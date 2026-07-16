import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as githubDriver from '../src/drivers/github.js';
import type { Entry, PlacementResult, Tag } from '../src/types.js';
import {
  computeFoldIn,
  computeVersionRanges,
  filterForFoldIn,
  readVersionAtRef,
  selectUpstreamEntries,
} from '../src/upstream.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';

function tag(name: string): Tag {
  return { name, sha: name, date: '2024-01-01T00:00:00Z' };
}

function pr(number: number, sha = `sha-${number}`): Entry {
  return { number, kind: 'pr', category: 'issue', title: `pr ${number}`, login: 'octocat', bot: false, sha };
}

function issue(number: number): Entry {
  return { number, kind: 'issue', category: 'issue', title: `issue ${number}`, login: 'octocat', bot: false, sha: `sha-${number}` };
}

function placementWithBuckets(buckets: PlacementResult['buckets']): PlacementResult {
  return { buckets, dropped: [], unresolved: [], allTags: buckets.map((b) => b.tag).filter((t): t is Tag => t !== null) };
}

describe('selectUpstreamEntries', () => {
  const upstreamPlacement = placementWithBuckets([
    { tag: tag('1.2.6'), entries: [pr(300), pr(301)] },
    { tag: tag('1.2.5'), entries: [pr(200)] },
    { tag: tag('1.2.4'), entries: [pr(100)] },
  ]);

  it('selects entries strictly after fromVersion up to and including toVersion', () => {
    const entries = selectUpstreamEntries(upstreamPlacement, '1.2.4', '1.2.6');
    expect(entries.map((e) => e.number)).toEqual([300, 301, 200]);
  });

  it('selects everything up to toVersion when fromVersion is undefined (first release)', () => {
    const entries = selectUpstreamEntries(upstreamPlacement, undefined, '1.2.5');
    expect(entries.map((e) => e.number)).toEqual([200, 100]);
  });

  it('returns nothing when toVersion has no matching upstream tag', () => {
    expect(selectUpstreamEntries(upstreamPlacement, '1.2.4', '9.9.9')).toEqual([]);
  });

  it('returns just that tag when fromVersion tag is not found in upstream placement', () => {
    const entries = selectUpstreamEntries(upstreamPlacement, '0.0.1', '1.2.4');
    expect(entries.map((e) => e.number)).toEqual([100]);
  });
});

describe('readVersionAtRef and computeVersionRanges', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  async function writePom(version: string) {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(
      join(fixture.dir, 'pom.xml'),
      `<project><properties><engine.version>${version}</engine.version></properties></project>`,
      'utf8',
    );
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('git', ['add', 'pom.xml'], { cwd: fixture.dir });
  }

  it('reads the pinned dependency version at a given tag', async () => {
    await writePom('1.2.5');
    await fixture.commit('bump to 1.2.5');
    await fixture.tag('v1.0.0', '2024-01-01T00:00:00Z');

    expect(await readVersionAtRef('v1.0.0', 'pom.xml', 'engine.version', { cwd: fixture.dir })).toBe('1.2.5');
  });

  it('returns undefined when the file did not exist yet at that ref', async () => {
    await fixture.commit('unrelated');
    await fixture.tag('v0.9.0', '2024-01-01T00:00:00Z');

    expect(await readVersionAtRef('v0.9.0', 'pom.xml', 'engine.version', { cwd: fixture.dir })).toBeUndefined();
  });

  it('pairs every tag with the version at the tag immediately before it, using the full tag sequence', async () => {
    await writePom('1.2.4');
    await fixture.commit('bump to 1.2.4');
    await fixture.tag('v1.0.0', '2024-01-01T00:00:00Z');

    await writePom('1.2.5');
    await fixture.commit('bump to 1.2.5');
    await fixture.tag('v1.1.0', '2024-02-01T00:00:00Z'); // no entries of its own — still gets its own range

    await writePom('1.2.6');
    await fixture.commit('bump to 1.2.6');
    await fixture.tag('v1.2.0', '2024-03-01T00:00:00Z');

    const placement = placementWithBuckets([
      { tag: tag('v1.2.0'), entries: [pr(1)] },
      { tag: tag('v1.0.0'), entries: [pr(2)] },
    ]);
    placement.allTags = [tag('v1.2.0'), tag('v1.1.0'), tag('v1.0.0')];

    const ranges = await computeVersionRanges(placement, 'develop', 'pom.xml', 'engine.version', { cwd: fixture.dir });

    expect(ranges).toEqual([
      { bucketTag: 'v1.2.0', fromVersion: '1.2.5', toVersion: '1.2.6' },
      { bucketTag: 'v1.1.0', fromVersion: '1.2.4', toVersion: '1.2.5' },
      { bucketTag: 'v1.0.0', fromVersion: undefined, toVersion: '1.2.4' },
    ]);
  });

  it('drops a range where nothing actually changed (headRef sitting exactly on the newest tag)', async () => {
    await writePom('1.2.5');
    await fixture.commit('bump to 1.2.5');
    await fixture.tag('v1.0.0', '2024-01-01T00:00:00Z');

    const placement = placementWithBuckets([{ tag: tag('v1.0.0'), entries: [pr(1)] }]);
    placement.allTags = [tag('v1.0.0')];

    const ranges = await computeVersionRanges(placement, 'develop', 'pom.xml', 'engine.version', { cwd: fixture.dir });

    expect(ranges).toEqual([{ bucketTag: 'v1.0.0', fromVersion: undefined, toVersion: '1.2.5' }]);
  });
});

describe('filterForFoldIn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns only PR-kind entries unfiltered when classification level is none', async () => {
    const entries = await filterForFoldIn([pr(1), issue(2)], {
      level: 'none',
      owner: 'acme',
      repo: 'engine',
      token: 't',
    });
    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  it('drops PRs classified as noise or test-only when level is path', async () => {
    vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async (_owner, _repo, number) => {
      if (number === 1) return ['runtime/module-a/src/main/java/Foo.java'];
      if (number === 2) return ['.github/workflows/build.yml'];
      return ['runtime/module-a/src/test/java/FooTest.java'];
    });

    const entries = await filterForFoldIn([pr(1), pr(2), pr(3)], {
      level: 'path',
      owner: 'acme',
      repo: 'engine',
      token: 't',
    });

    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  it('additionally requires a touched artifact in the dependency set when level is maven', async () => {
    vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async (_owner, _repo, number) => {
      if (number === 1) return ['runtime/module-a/src/main/java/Foo.java'];
      return ['runtime/module-b/src/main/java/Bar.java'];
    });

    const entries = await filterForFoldIn([pr(1), pr(2)], {
      level: 'maven',
      owner: 'acme',
      repo: 'engine',
      token: 't',
      dependencySet: new Set(['module-a']),
      moduleArtifactIds: new Map([
        ['module-a', 'module-a'],
        ['module-b', 'module-b'],
      ]),
    });

    expect(entries.map((e) => e.number)).toEqual([1]);
  });
});

describe('computeFoldIn', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
    vi.restoreAllMocks();
  });

  it('produces a fold-in section per bucket with a real version bump, filtered by classification', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const git = promisify(execFile);

    async function writePom(version: string) {
      await writeFile(
        join(fixture.dir, 'pom.xml'),
        `<project><properties><engine.version>${version}</engine.version></properties></project>`,
        'utf8',
      );
      await git('git', ['add', 'pom.xml'], { cwd: fixture.dir });
    }

    await writePom('1.2.5');
    await fixture.commit('bump to 1.2.5');
    await fixture.tag('v1.0.0', '2024-01-01T00:00:00Z');

    await writePom('1.2.6');
    await fixture.commit('bump to 1.2.6');
    await fixture.tag('v1.1.0', '2024-02-01T00:00:00Z');

    const placement = placementWithBuckets([{ tag: tag('v1.1.0'), entries: [pr(500)] }]);
    placement.allTags = [tag('v1.1.0'), tag('v1.0.0')];

    const upstreamPlacement = placementWithBuckets([
      { tag: tag('1.2.6'), entries: [pr(2080), pr(2081)] },
      { tag: tag('1.2.5'), entries: [pr(1990)] },
    ]);

    vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async (_owner, _repo, number) => {
      if (number === 2080) return ['runtime/module-a/src/main/java/Foo.java'];
      return ['.github/workflows/build.yml'];
    });

    const sections = await computeFoldIn({
      upstream: {
        repo: 'acme/engine',
        'dependency-version-file': 'pom.xml',
        'dependency-version-property': 'engine.version',
        classification: 'path',
      },
      placement,
      upstreamPlacement,
      headRef: 'develop',
      gitDir: fixture.dir,
      gitOptions: { cwd: fixture.dir },
      token: 't',
    });

    expect(sections.size).toBe(1);
    const section = sections.get('v1.1.0');
    expect(section).toBeDefined();
    expect(section?.fromVersion).toBe('1.2.5');
    expect(section?.toVersion).toBe('1.2.6');
    expect(section?.entries.map((e) => e.number)).toEqual([2080]);
  });
});
