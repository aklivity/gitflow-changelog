import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
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

  beforeEach(async () => {
    consumer = await createGitFixture();
    upstream = await createGitFixture();
  });

  afterEach(async () => {
    await consumer.cleanup();
    await upstream.cleanup();
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
    vi.spyOn(gitModule, 'cloneRepo').mockImplementation(async (_owner, _repo, dir) => {
      await execFileAsync('git', ['clone', '--quiet', upstream.dir, dir]);
    });

    const result = await run({
      owner: 'acme',
      repo: 'app',
      token: 't',
      ref: 'develop',
      gitDir: consumer.dir,
      cachePath: join(consumer.dir, '.gitflow-changelog-cache.json'),
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
    expect(result.markdown).toContain('_Includes engine 1.2.5–1.2.6._');
    expect(result.markdown).toContain(
      '- export telemetry events [acme/engine\\#2080](https://github.com/acme/engine/pull/2080)',
    );

    expect(result.markdown).toContain('## [v1.0.0]');
    expect(result.markdown).toContain('_Includes engine up to 1.2.5._');
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
});
