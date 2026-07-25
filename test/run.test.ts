import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubDriver } from '../src/drivers/github.js';
import * as gitModule from '../src/git.js';
import { run } from '../src/run.js';
import type { Entry } from '../src/types.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';

const execFileAsync = promisify(execFile);

async function writePom(dir: string, version: string): Promise<void> {
  await writeFile(
    join(dir, 'pom.xml'),
    `<project><properties><engine.version>${version}</engine.version></properties></project>`,
    'utf8',
  );
  await execFileAsync('git', ['add', 'pom.xml'], { cwd: dir });
}

function entry(overrides: Partial<Entry> & { sha: string; number: number }): Entry {
  return {
    kind: 'pr',
    category: 'issue',
    title: 'title',
    login: 'octocat',
    bot: false,
    ...overrides,
  };
}

// Exercises the wiring in run.ts end-to-end: cloning an "upstream" repo,
// fetching its own entries, placing its own history, and folding a filtered
// subset into the consuming repo's rendered changelog. GithubDriver's
// network calls and git.ts's real clone (auth + real GitHub URL) are
// swapped for local fixtures — everything else (placement, classification,
// rendering) runs for real.
describe('run — upstream fold-in wiring', () => {
  let consumer: GitFixture;
  let upstream: GitFixture;
  let upstreamCacheDir: string;

  beforeEach(async () => {
    consumer = await createGitFixture();
    upstream = await createGitFixture();
    upstreamCacheDir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-upstream-cache-'));
  });

  afterEach(async () => {
    await consumer.cleanup();
    await upstream.cleanup();
    await rm(upstreamCacheDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('folds a filtered subset of upstream releases into the matching consumer release', async () => {
    const upstreamShaAt125 = await upstream.commit('feature A');
    await upstream.tag('1.2.5', '2024-01-01T00:00:00Z');
    const upstreamShaAt126 = await upstream.commit('feature B');
    await upstream.tag('1.2.6', '2024-02-01T00:00:00Z');

    await writePom(consumer.dir, '1.2.5');
    await consumer.commit('bump to 1.2.5');
    await consumer.tag('v1.0.0', '2024-01-05T00:00:00Z');

    await writePom(consumer.dir, '1.2.6');
    const consumerShaAt110 = await consumer.commit('bump to 1.2.6');
    await consumer.tag('v1.1.0', '2024-02-05T00:00:00Z');

    const ownEntry = entry({ number: 500, title: 'Our own change', sha: consumerShaAt110 });
    const upstreamBugfix = entry({ number: 1990, category: 'bug', title: 'fix crash', sha: upstreamShaAt125 });
    const upstreamFeature = entry({ number: 2080, title: 'export telemetry events', sha: upstreamShaAt126 });

    vi.spyOn(GithubDriver.prototype, 'fetchEntries').mockImplementation(async (options) => {
      if (options.repo === 'app') return [ownEntry];
      if (options.repo === 'engine') return [upstreamBugfix, upstreamFeature];
      return [];
    });
    vi.spyOn(gitModule, 'cloneOrUpdateRepo').mockImplementation(async (_owner, _repo, dir) => {
      await execFileAsync('git', ['clone', '--quiet', upstream.dir, dir]);
    });

    const result = await run({
      owner: 'acme',
      repo: 'app',
      token: 't',
      ref: 'develop',
      gitDir: consumer.dir,
      cachePath: join(consumer.dir, '.gitflow-changelog-cache.json'),
      upstreamCacheDir,
      tagPattern: /^v\d+\.\d+\.\d+$/,
      enhancementLabels: ['enhancement'],
      bugLabels: ['bug'],
      excludeLabels: [],
      format: 'default',
      upstream: [
        {
          repo: 'acme/engine',
          'dependency-version-file': 'pom.xml',
          'dependency-version-property': 'engine.version',
          classification: 'none',
        },
      ],
    });

    expect(result.markdown).toContain('## [v1.1.0]');
    expect(result.markdown).toContain('- Our own change [\\#500]');
    expect(result.markdown).toContain('_Includes [engine 1.2.5–1.2.6](https://github.com/acme/engine/compare/1.2.5...1.2.6)._');
    expect(result.markdown).toContain(
      '- export telemetry events [acme/engine\\#2080](https://github.com/acme/engine/pull/2080)',
    );

    expect(result.markdown).toContain('## [v1.0.0]');
    expect(result.markdown).toContain('_Includes [engine up to 1.2.5](https://github.com/acme/engine/tree/1.2.5)._');
    expect(result.markdown).toContain(
      '- fix crash [acme/engine\\#1990](https://github.com/acme/engine/pull/1990)',
    );

    const v110Index = result.markdown.indexOf('## [v1.1.0]');
    const v100Index = result.markdown.indexOf('## [v1.0.0]');
    const featureIndex = result.markdown.indexOf('export telemetry events');
    const bugfixIndex = result.markdown.indexOf('fix crash');
    expect(v110Index).toBeLessThan(featureIndex);
    expect(featureIndex).toBeLessThan(v100Index);
    expect(v100Index).toBeLessThan(bugfixIndex);
  });

  // computeUpstreamFoldIn runs resolveHashes against the upstream repo's own
  // history — the exact same tiers (checked-in override, cache reuse,
  // commit-message scan, squash-merge discovery) as the consuming repo's own
  // resolution. Its warnings must surface with the same visibility, prefixed
  // with the upstream's identity so a reader knows which repo a warning is
  // about — see issue #30 (a real squash-merge substitution or rate limit
  // while resolving the upstream's entries was previously invisible).
  it('surfaces resolveHashes warnings from resolving upstream entries, prefixed with the upstream repo', async () => {
    await upstream.commit('feature A');
    await upstream.tag('1.2.5', '2024-01-01T00:00:00Z');

    await writePom(consumer.dir, '1.2.5');
    const consumerSha = await consumer.commit('bump to 1.2.5');
    await consumer.tag('v1.0.0', '2024-01-05T00:00:00Z');

    const ownEntry = entry({ number: 500, title: 'Our own change', sha: consumerSha });
    // Unresolvable: no override, no such commit, and no commit message in
    // the upstream fixture's history references #9999.
    const brokenUpstreamIssue = entry({
      number: 9999,
      kind: 'issue',
      title: 'ghost issue',
      sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });

    vi.spyOn(GithubDriver.prototype, 'fetchEntries').mockImplementation(async (options) => {
      if (options.repo === 'app') return [ownEntry];
      if (options.repo === 'engine') return [brokenUpstreamIssue];
      return [];
    });
    vi.spyOn(gitModule, 'cloneOrUpdateRepo').mockImplementation(async (_owner, _repo, dir) => {
      await execFileAsync('git', ['clone', '--quiet', upstream.dir, dir]);
    });

    const result = await run({
      owner: 'acme',
      repo: 'app',
      token: 't',
      ref: 'develop',
      gitDir: consumer.dir,
      cachePath: join(consumer.dir, '.gitflow-changelog-cache.json'),
      upstreamCacheDir,
      tagPattern: /^v\d+\.\d+\.\d+$/,
      enhancementLabels: ['enhancement'],
      bugLabels: ['bug'],
      excludeLabels: [],
      format: 'default',
      upstream: [
        {
          repo: 'acme/engine',
          'dependency-version-file': 'pom.xml',
          'dependency-version-property': 'engine.version',
          classification: 'none',
        },
      ],
    });

    const upstreamWarning = result.warnings.find((warning) => warning.startsWith('upstream acme/engine:'));
    expect(upstreamWarning).toBeDefined();
    expect(upstreamWarning).toContain('issue #9999');
    expect(upstreamWarning).toContain('dropping this entry');
  });

  // See issue #33: computeUpstreamFoldIn used to hardcode overrides to
  // EMPTY_OVERRIDES, so a checked-in override committed to the upstream
  // repo itself — the highest-precedence resolution tier for the
  // upstream's own history — was silently ignored during fold-in.
  it('honors the upstream repo\'s own checked-in hash-overrides file during fold-in resolution', async () => {
    const upstreamShaAt125 = await upstream.commit('feature A');
    await upstream.tag('1.2.5', '2024-01-01T00:00:00Z');

    await writeFile(
      join(upstream.dir, '.gitflow-changelog-hash-overrides.yml'),
      `hash-overrides:\n  deadbeefdeadbeefdeadbeefdeadbeefdeadbeef: ${upstreamShaAt125}\n`,
      'utf8',
    );
    await execFileAsync('git', ['add', '.gitflow-changelog-hash-overrides.yml'], { cwd: upstream.dir });
    await execFileAsync('git', ['commit', '-m', 'add overrides'], { cwd: upstream.dir });

    await writePom(consumer.dir, '1.2.5');
    const consumerSha = await consumer.commit('bump to 1.2.5');
    await consumer.tag('v1.0.0', '2024-01-05T00:00:00Z');

    const ownEntry = entry({ number: 500, title: 'Our own change', sha: consumerSha });
    // Recorded sha is bogus — only resolvable via the override above, not
    // any fallback tier (it doesn't exist, and no commit message anywhere
    // references #3010).
    const overriddenUpstreamEntry = entry({
      number: 3010,
      title: 'export events via override',
      sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });

    vi.spyOn(GithubDriver.prototype, 'fetchEntries').mockImplementation(async (options) => {
      if (options.repo === 'app') return [ownEntry];
      if (options.repo === 'engine') return [overriddenUpstreamEntry];
      return [];
    });
    vi.spyOn(gitModule, 'cloneOrUpdateRepo').mockImplementation(async (_owner, _repo, dir) => {
      await execFileAsync('git', ['clone', '--quiet', upstream.dir, dir]);
    });

    const result = await run({
      owner: 'acme',
      repo: 'app',
      token: 't',
      ref: 'develop',
      gitDir: consumer.dir,
      cachePath: join(consumer.dir, '.gitflow-changelog-cache.json'),
      upstreamCacheDir,
      tagPattern: /^v\d+\.\d+\.\d+$/,
      enhancementLabels: ['enhancement'],
      bugLabels: ['bug'],
      excludeLabels: [],
      format: 'default',
      upstream: [
        {
          repo: 'acme/engine',
          'dependency-version-file': 'pom.xml',
          'dependency-version-property': 'engine.version',
          classification: 'none',
        },
      ],
    });

    expect(result.markdown).toContain(
      '- export events via override [acme/engine\\#3010](https://github.com/acme/engine/pull/3010)',
    );
    // The override resolves this silently at the highest-precedence tier —
    // no fallback-tier warning should ever fire for it.
    expect(result.warnings.some((warning) => warning.includes('#3010'))).toBe(false);
  });
});

// See aklivity/zilla-plus#1073/#1075: both squash-merged into support/1.x
// with no error or warning anywhere, yet both were absent from the driver's
// fetched entries when 1.4.3 was cut — CHANGELOG.md silently shipped
// incomplete. completenessIssues exists to make exactly this case loud
// instead of invisible; these tests exercise it through run() end-to-end
// rather than just unit-testing checkCompleteness in isolation, so a
// regression in the run.ts wiring (wrong range, wrong knownNumbers set)
// would fail here even if completeness.ts itself were still correct.
describe('run — completeness check', () => {
  let repo: GitFixture;

  beforeEach(async () => {
    repo = await createGitFixture();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function baseOptions(overrides: Partial<Parameters<typeof run>[0]> = {}) {
    return {
      owner: 'acme',
      repo: 'app',
      token: 't',
      ref: 'develop',
      gitDir: repo.dir,
      cachePath: join(repo.dir, '.gitflow-changelog-cache.json'),
      upstreamCacheDir: await mkdtemp(join(tmpdir(), 'gitflow-changelog-upstream-cache-')),
      tagPattern: /^v\d+\.\d+\.\d+$/,
      enhancementLabels: ['enhancement'],
      bugLabels: ['bug'],
      excludeLabels: [],
      format: 'default',
      upstream: [],
      ...overrides,
    };
  }

  it('flags a squash-merged PR that git history shows but the driver never fetched', async () => {
    await repo.commit('base');
    // Merged into git history with a real squash-merge subject, but never
    // returned by fetchEntries — the exact shape of the driver silently
    // dropping an entry.
    await repo.commit('fix(engine): support EKS for metering (#1073)');

    vi.spyOn(GithubDriver.prototype, 'fetchEntries').mockResolvedValue([]);

    const result = await run(await baseOptions());

    expect(result.completenessIssues).toEqual([{ number: 1073, sha: expect.any(String) }]);
  });

  it('reports no completeness issues once the driver-fetched entry matches git history', async () => {
    await repo.commit('base');
    const sha = await repo.commit('fix(engine): support EKS for metering (#1073)');

    vi.spyOn(GithubDriver.prototype, 'fetchEntries').mockResolvedValue([
      entry({ number: 1073, title: 'support EKS for metering', sha }),
    ]);

    const result = await run(await baseOptions());

    expect(result.completenessIssues).toEqual([]);
  });

  it('only checks the newly-tagged range, not a tag already fully released', async () => {
    await repo.commit('fix(old): already released (#100)');
    await repo.tag('v1.0.0', '2024-01-01T00:00:00Z');
    const newSha = await repo.commit('fix(new): just merged (#200)');

    // Neither #100 nor #200 is returned by the driver, but only #200 falls
    // within the range this run is actually rendering (v1.0.0..develop) —
    // #100's gap belongs to v1.0.0's own already-published run, not this one.
    vi.spyOn(GithubDriver.prototype, 'fetchEntries').mockResolvedValue([]);

    const result = await run(await baseOptions());

    expect(result.completenessIssues).toEqual([{ number: 200, sha: newSha }]);
  });
});
