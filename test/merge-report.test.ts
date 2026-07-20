import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as githubDriver from '../src/drivers/github.js';
import { mergeReport } from '../src/merge-report.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';

const execFileAsync = promisify(execFile);

// Deterministic "now" one calendar year past git-fixture's commit dates
// (2024, counter-based days) so ageDays is stable and easy to assert on,
// instead of depending on the real clock.
const NOW = new Date(2025, 0, 1);

async function cherryPick(dir: string, sha: string): Promise<string> {
  await execFileAsync('git', ['cherry-pick', sha], { cwd: dir });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

describe('mergeReport', () => {
  let fixture: GitFixture;
  let cachePath: string;
  let cacheDir: string;

  beforeEach(async () => {
    fixture = await createGitFixture();
    cacheDir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-merge-report-cache-'));
    cachePath = join(cacheDir, '.gitflow-changelog-cache.json');
    vi.spyOn(githubDriver, 'updateCache').mockImplementation(async (cache) => cache);
  });

  afterEach(async () => {
    await fixture.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports a genuinely unported commit but not one already cherry-picked to the target', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await fixture.checkout('support/1.x');
    const missingSha = await fixture.commit('fix: genuinely unported');
    const portedSha = await fixture.commit('fix: already ported');

    await fixture.checkout('develop');
    await cherryPick(fixture.dir, portedSha);

    const result = await mergeReport(
      {
        owner: 'acme',
        repo: 'widget',
        token: 't',
        source: 'support/1.x',
        targets: ['develop'],
        gitDir: fixture.dir,
        cachePath,
        excludeLabels: [],
      },
      NOW,
    );

    const shas = result.outstanding.map((entry) => entry.sha);
    expect(shas).toContain(missingSha);
    expect(shas).not.toContain(portedSha);
  });

  it('drops a candidate whose originating PR/issue carries an exclude-label', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await fixture.checkout('support/1.x');
    const depSha = await fixture.commit('build(deps): bump some-lib');

    vi.spyOn(githubDriver, 'updateCache').mockImplementation(async (cache) => {
      cache.entries['1'] = { kind: 'pr', title: 'Bump some-lib', login: 'dependabot[bot]', bot: true, labels: ['dependencies'], sha: depSha };
      return cache;
    });

    const result = await mergeReport(
      {
        owner: 'acme',
        repo: 'widget',
        token: 't',
        source: 'support/1.x',
        targets: ['develop'],
        gitDir: fixture.dir,
        cachePath,
        excludeLabels: ['dependencies'],
      },
      NOW,
    );

    expect(result.outstanding.map((entry) => entry.sha)).not.toContain(depSha);
  });

  it('drops a candidate listed in the merge-ignore file', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await fixture.checkout('support/1.x');
    const ignoredSha = await fixture.commit('fix(support/1.x): branch-only version bump');

    const ignorePath = join(cacheDir, '.gitflow-changelog-merge-ignore.yml');
    await writeFile(ignorePath, `merge-ignore:\n  ${ignoredSha}: "branch-only, not applicable to develop"\n`, 'utf8');

    const result = await mergeReport(
      {
        owner: 'acme',
        repo: 'widget',
        token: 't',
        source: 'support/1.x',
        targets: ['develop'],
        gitDir: fixture.dir,
        cachePath,
        mergeIgnorePath: ignorePath,
        excludeLabels: [],
      },
      NOW,
    );

    expect(result.outstanding.map((entry) => entry.sha)).not.toContain(ignoredSha);
  });

  it('fans out across multiple targets, reporting each target independently', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await fixture.branch('support/2.x');
    await fixture.checkout('support/1.x');
    const onlyOnSource = await fixture.commit('fix: needed everywhere');

    const result = await mergeReport(
      {
        owner: 'acme',
        repo: 'widget',
        token: 't',
        source: 'support/1.x',
        targets: ['develop', 'support/2.x'],
        gitDir: fixture.dir,
        cachePath,
        excludeLabels: [],
      },
      NOW,
    );

    const targets = result.outstanding.filter((entry) => entry.sha === onlyOnSource).map((entry) => entry.target);
    expect(targets.sort()).toEqual(['develop', 'support/2.x']);
  });

  it('sorts outstanding entries oldest-first by commit age', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await fixture.checkout('support/1.x');
    const older = await fixture.commit('fix: older');
    const newer = await fixture.commit('fix: newer');

    const result = await mergeReport(
      {
        owner: 'acme',
        repo: 'widget',
        token: 't',
        source: 'support/1.x',
        targets: ['develop'],
        gitDir: fixture.dir,
        cachePath,
        excludeLabels: [],
      },
      NOW,
    );

    const shas = result.outstanding.map((entry) => entry.sha);
    expect(shas.indexOf(older)).toBeLessThan(shas.indexOf(newer));
    const olderEntry = result.outstanding.find((entry) => entry.sha === older);
    const newerEntry = result.outstanding.find((entry) => entry.sha === newer);
    expect(olderEntry!.ageDays).toBeGreaterThan(newerEntry!.ageDays);
  });
});
