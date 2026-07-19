import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as githubDriver from '../src/drivers/github.js';
import * as gitModule from '../src/git.js';
import type { MavenModule } from '../src/maven.js';
import type { Entry, PlacementResult, Tag } from '../src/types.js';
import {
  computeFoldIn,
  computeVersionRanges,
  filterForFoldIn,
  placeUpstreamGlobally,
  readVersionAtRef,
  selectEntriesInRange,
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

describe('placeUpstreamGlobally and selectEntriesInRange', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
    vi.restoreAllMocks();
  });

  it('selects entries strictly after fromVersion up to and including toVersion', async () => {
    const shaAt100 = await fixture.commit('feature 100');
    await fixture.tag('1.2.4', '2024-01-01T00:00:00Z');
    const shaAt200 = await fixture.commit('feature 200');
    await fixture.tag('1.2.5', '2024-02-01T00:00:00Z');
    const shaAt300 = await fixture.commit('feature 300');
    await fixture.tag('1.2.6', '2024-03-01T00:00:00Z');

    const placement = await placeUpstreamGlobally(
      [pr(100, shaAt100), pr(200, shaAt200), pr(300, shaAt300)],
      { cwd: fixture.dir },
    );

    expect((await selectEntriesInRange(placement, '1.2.4', '1.2.6', { cwd: fixture.dir })).map((e) => e.number)).toEqual([300, 200]);
  });

  it('selects everything up to toVersion when fromVersion is undefined (first release)', async () => {
    const shaAt100 = await fixture.commit('feature 100');
    await fixture.tag('1.2.4', '2024-01-01T00:00:00Z');
    const shaAt200 = await fixture.commit('feature 200');
    await fixture.tag('1.2.5', '2024-02-01T00:00:00Z');

    const placement = await placeUpstreamGlobally([pr(100, shaAt100), pr(200, shaAt200)], { cwd: fixture.dir });

    expect((await selectEntriesInRange(placement, undefined, '1.2.5', { cwd: fixture.dir })).map((e) => e.number)).toEqual([200, 100]);
  });

  it('excludes an entry not reachable from toVersion at all (a different, unrelated line of history)', async () => {
    const shaOnMain = await fixture.commit('feature on main');
    await fixture.tag('1.2.4', '2024-01-01T00:00:00Z');
    await fixture.branch('other');
    await fixture.checkout('other');
    const shaOffBranch = await fixture.commit('unrelated branch work');

    const placement = await placeUpstreamGlobally([pr(100, shaOnMain), pr(200, shaOffBranch)], { cwd: fixture.dir });

    expect((await selectEntriesInRange(placement, undefined, '1.2.4', { cwd: fixture.dir })).map((e) => e.number)).toEqual([100]);
  });

  // The actual bug this guards against (#10): a consumer's pom.xml can pin a
  // version that is a real, resolvable ref but doesn't look like a "real"
  // release to upstream's own tag-pattern (e.g. tracking upstream's develop
  // line via an alpha build) — resolution must not depend on that pattern.
  // placeUpstreamGlobally never applies a tag pattern at all.
  it('finds an entry under a tag that would never match a strict semver tag pattern', async () => {
    const shaAt1 = await fixture.commit('feature 1');
    await fixture.tag('1.0.0', '2024-01-01T00:00:00Z');
    const shaAt2 = await fixture.commit('feature 2');
    await fixture.tag('2.0.0-alpha-22', '2024-02-01T00:00:00Z');

    const placement = await placeUpstreamGlobally([pr(1, shaAt1), pr(2, shaAt2)], { cwd: fixture.dir });

    expect((await selectEntriesInRange(placement, '1.0.0', '2.0.0-alpha-22', { cwd: fixture.dir })).map((e) => e.number)).toEqual([2]);
  });

  // The bug #7 originally fixed, now solved without any per-tag rescoping:
  // a backport-only commit that never lands on the branch a tag's sibling
  // release came from is still found, because `git tag --contains` is
  // inherently branch-agnostic — no ref scoping is involved at all.
  it('finds a commit under the earliest tag containing it regardless of which branch produced that tag', async () => {
    const shaAt1990 = await fixture.commit('fix 1990');
    await fixture.branch('support/1.x');
    await fixture.checkout('support/1.x');
    await fixture.tag('1.2.5', '2024-01-01T00:00:00Z');
    const shaAt2080 = await fixture.commit('backport 2080');
    await fixture.tag('1.2.6', '2024-02-01T00:00:00Z');

    const placement = await placeUpstreamGlobally([pr(1990, shaAt1990), pr(2080, shaAt2080)], { cwd: fixture.dir });

    expect((await selectEntriesInRange(placement, '1.2.5', '1.2.6', { cwd: fixture.dir })).map((e) => e.number)).toEqual([2080]);
    expect((await selectEntriesInRange(placement, undefined, '1.2.5', { cwd: fixture.dir })).map((e) => e.number)).toEqual([1990]);
  });

  // The actual performance fix (#5): placement is computed once, up front —
  // not once per version range. Slicing additional ranges out of an
  // already-computed placement makes no further tagsContaining calls at
  // all — the O(entries) cost stays paid exactly once regardless of how
  // many ranges get sliced. selectEntriesInRange's own ancestry check
  // (added for #36) is a separate, much cheaper cost bounded by the number
  // of tags between two dates, not by entry count — untouched by this
  // fix and asserted separately below.
  it('computes placement with one tagsContaining call per entry, then slices ranges with zero further tagsContaining calls', async () => {
    const shaAt100 = await fixture.commit('feature 100');
    await fixture.tag('1.2.4', '2024-01-01T00:00:00Z');
    const shaAt200 = await fixture.commit('feature 200');
    await fixture.tag('1.2.5', '2024-02-01T00:00:00Z');
    const shaAt300 = await fixture.commit('feature 300');
    await fixture.tag('1.2.6', '2024-03-01T00:00:00Z');

    const spy = vi.spyOn(gitModule, 'tagsContaining');
    const entries = [pr(100, shaAt100), pr(200, shaAt200), pr(300, shaAt300)];
    const placement = await placeUpstreamGlobally(entries, { cwd: fixture.dir });

    expect(spy).toHaveBeenCalledTimes(entries.length);

    await selectEntriesInRange(placement, '1.2.4', '1.2.6', { cwd: fixture.dir });
    await selectEntriesInRange(placement, undefined, '1.2.4', { cwd: fixture.dir });
    await selectEntriesInRange(placement, '1.2.5', '1.2.6', { cwd: fixture.dir });

    expect(spy).toHaveBeenCalledTimes(entries.length);
  });

  // #36: reproduces the real aklivity/zilla-plus/zilla bug. zilla tags two
  // parallel lines (develop's alpha builds, support/1.x's patch releases)
  // whose dates interleave arbitrarily — a pure date-window walk between
  // support/1.x's 1.2.6 and 1.3.0 would wrongly sweep in every alpha tag
  // dated in between, and with it, entries that only ever shipped on
  // develop.
  it('excludes entries under tags from a parallel branch line even when their dates fall inside the range', async () => {
    await fixture.commit('shared base');
    await fixture.branch('support/1.x');

    await fixture.checkout('support/1.x');
    await fixture.tag('1.2.6', '2024-01-01T00:00:00Z');

    await fixture.checkout('develop');
    const shaAlpha1 = await fixture.commit('develop-only feature (never on support/1.x)');
    await fixture.tag('2.0.0-alpha-1', '2024-01-05T00:00:00Z');
    await fixture.commit('another develop-only feature');
    await fixture.tag('2.0.0-alpha-2', '2024-01-10T00:00:00Z');

    await fixture.checkout('support/1.x');
    const shaSupportFix = await fixture.commit('real support/1.x fix');
    await fixture.tag('1.3.0', '2024-01-15T00:00:00Z');

    const placement = await placeUpstreamGlobally(
      [pr(300, shaSupportFix), pr(999, shaAlpha1)],
      { cwd: fixture.dir },
    );

    const result = await selectEntriesInRange(placement, '1.2.6', '1.3.0', { cwd: fixture.dir });

    expect(result.map((e) => e.number)).toEqual([300]);
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

  it('returns every entry unfiltered when classification level is none, PR and issue alike', async () => {
    const entries = await filterForFoldIn([pr(1), issue(2)], {
      level: 'none',
      owner: 'acme',
      repo: 'engine',
      token: 't',
      gitOptions: { cwd: '.' },
    });
    expect(entries.map((e) => e.number)).toEqual([1, 2]);
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
      gitOptions: { cwd: '.' },
    });

    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  it('additionally requires a touched artifact in the dependency set when level is maven', async () => {
    vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async (_owner, _repo, number) => {
      if (number === 1) return ['runtime/module-a/src/main/java/Foo.java'];
      return ['runtime/module-b/src/main/java/Bar.java'];
    });

    const modules: MavenModule[] = [
      { dir: 'runtime/module-a', artifactId: 'module-a', dependencies: [] },
      { dir: 'runtime/module-b', artifactId: 'module-b', dependencies: [] },
    ];

    const entries = await filterForFoldIn([pr(1), pr(2)], {
      level: 'maven',
      owner: 'acme',
      repo: 'engine',
      token: 't',
      dependencySet: new Set(['module-a']),
      modules,
      gitOptions: { cwd: '.' },
    });

    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  // Reproduces #17: an issue auto-closed by a merged PR shares that PR's
  // merge-commit sha (applyClosingReferences backfills it in
  // drivers/github.ts), so it should inherit that PR's in/out-of-scope
  // determination instead of being dropped outright for being issue-kind.
  it('classifies an issue by its closing PR file list when their shas match', async () => {
    vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async (_owner, _repo, number) => {
      if (number === 1) return ['runtime/module-a/src/main/java/Foo.java'];
      return ['runtime/module-b/src/main/java/Bar.java'];
    });

    const modules: MavenModule[] = [
      { dir: 'runtime/module-a', artifactId: 'module-a', dependencies: [] },
      { dir: 'runtime/module-b', artifactId: 'module-b', dependencies: [] },
    ];

    const closingPr = pr(1, 'shared-sha');
    const inScopeIssue: Entry = { ...issue(101), sha: 'shared-sha' };
    const outOfScopePr = pr(2, 'other-sha');
    const outOfScopeIssue: Entry = { ...issue(102), sha: 'other-sha' };

    const entries = await filterForFoldIn([closingPr, inScopeIssue, outOfScopePr, outOfScopeIssue], {
      level: 'maven',
      owner: 'acme',
      repo: 'engine',
      token: 't',
      dependencySet: new Set(['module-a']),
      modules,
      gitOptions: { cwd: '.' },
    });

    expect(entries.map((e) => e.number)).toEqual([1, 101]);
  });

  // Reproduces #17's other case: an issue closed directly by a commit (no
  // matching PR sha in this entry set at all) still gets classified, via a
  // local git diff against the upstream clone, instead of being dropped
  // unconditionally.
  it('classifies an issue with no matching PR sha via a local git diff of its own commit', async () => {
    const upstream = await createGitFixture();
    try
    {
      await upstream.commit('unrelated setup');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await mkdir(join(upstream.dir, 'runtime', 'module-a', 'src', 'main', 'java'), { recursive: true });
      await writeFile(join(upstream.dir, 'runtime', 'module-a', 'src', 'main', 'java', 'Foo.java'), 'class Foo {}');
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const git = promisify(execFile);
      await git('git', ['add', 'runtime/module-a/src/main/java/Foo.java'], { cwd: upstream.dir });
      const directCloseSha = await upstream.commit('direct commit closing the issue');

      const modules: MavenModule[] = [{ dir: 'runtime/module-a', artifactId: 'module-a', dependencies: [] }];
      const directClosedIssue: Entry = { ...issue(200), sha: directCloseSha };

      const entries = await filterForFoldIn([directClosedIssue], {
        level: 'maven',
        owner: 'acme',
        repo: 'engine',
        token: 't',
        dependencySet: new Set(['module-a']),
        modules,
        gitOptions: { cwd: upstream.dir },
      });

      expect(entries.map((e) => e.number)).toEqual([200]);
    }
    finally
    {
      await upstream.cleanup();
    }
  });

  // No `patterns` override here at all — both classification (deriving
  // featurePaths from the module index, per classification.ts's
  // featurePathsFromModules) and module resolution (resolveModule) now
  // discover a top-level module like `manager` with zero runtime/-prefix
  // knowledge anywhere in the pipeline.
  it('resolves a touched module by nearest enclosing pom.xml, not a runtime/-prefix assumption', async () => {
    vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async (_owner, _repo, number) => {
      if (number === 1) return ['manager/src/main/java/io/example/Foo.java'];
      return ['cloud/docker-image/src/main/docker/zpm.json.template'];
    });

    const modules: MavenModule[] = [
      { dir: 'manager', artifactId: 'manager', dependencies: [] },
      { dir: 'cloud/docker-image', artifactId: 'docker-image', dependencies: [] },
    ];

    const entries = await filterForFoldIn([pr(1), pr(2)], {
      level: 'maven',
      owner: 'acme',
      repo: 'engine',
      token: 't',
      dependencySet: new Set(['manager']),
      modules,
      gitOptions: { cwd: '.' },
    });

    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  it('skips fetching a PR whose files are already in prFilesCache', async () => {
    const fetchSpy = vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async (_owner, _repo, number) => {
      if (number === 2) return ['runtime/module-a/src/main/java/Foo.java'];
      throw new Error(`unexpected fetch for #${number}`);
    });

    const entries = await filterForFoldIn([pr(1), pr(2)], {
      level: 'path',
      owner: 'acme',
      repo: 'engine',
      token: 't',
      prFilesCache: { 1: ['runtime/module-a/src/main/java/Foo.java'] },
      gitOptions: { cwd: '.' },
    });

    expect(entries.map((e) => e.number)).toEqual([1, 2]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('acme', 'engine', 2, 't');
  });

  it('populates prFilesCache with newly fetched file lists', async () => {
    vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async (_owner, _repo, number) => [`runtime/module-a/src/main-${number}.java`]);

    const cache: Record<string, string[]> = {};
    await filterForFoldIn([pr(1), pr(2)], {
      level: 'path',
      owner: 'acme',
      repo: 'engine',
      token: 't',
      prFilesCache: cache,
      gitOptions: { cwd: '.' },
    });

    expect(cache).toEqual({
      1: ['runtime/module-a/src/main-1.java'],
      2: ['runtime/module-a/src/main-2.java'],
    });
  });

  it('fetches every uncached PR exactly once even with concurrency', async () => {
    const fetchSpy = vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async (_owner, _repo, number) => [`runtime/module-a/src/main/java/Foo${number}.java`]);

    const prs = Array.from({ length: 20 }, (_, index) => pr(index + 1));
    const entries = await filterForFoldIn(prs, {
      level: 'path',
      owner: 'acme',
      repo: 'engine',
      token: 't',
      gitOptions: { cwd: '.' },
    });

    expect(entries.map((e) => e.number)).toEqual(prs.map((p) => p.number));
    expect(fetchSpy).toHaveBeenCalledTimes(20);
    prs.forEach((p) => expect(fetchSpy).toHaveBeenCalledWith('acme', 'engine', p.number, 't'));
  });
});

describe('computeFoldIn', () => {
  let fixture: GitFixture;
  let upstreamFixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
    upstreamFixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
    await upstreamFixture.cleanup();
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

    // Mirrors the real bug this test guards against: 1990 ships on the
    // upstream's default branch, but 2080/2081 are backport-only commits
    // that only ever land on the upstream's own support/1.x branch and are
    // never merged forward — scoping placement to the pinned version tag
    // itself (not the upstream's default branch) is what makes 2080
    // findable regardless.
    const shaAt1990 = await upstreamFixture.commit('fix 1990');
    await upstreamFixture.branch('support/1.x');
    await upstreamFixture.checkout('support/1.x');
    await upstreamFixture.tag('1.2.5', '2024-01-01T00:00:00Z');
    const shaAt2080 = await upstreamFixture.commit('backport 2080');
    const shaAt2081 = await upstreamFixture.commit('noise 2081');
    await upstreamFixture.tag('1.2.6', '2024-02-01T00:00:00Z');

    const upstreamEntries = [
      pr(1990, shaAt1990),
      pr(2080, shaAt2080),
      pr(2081, shaAt2081),
    ];

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
      upstreamEntries,
      upstreamGitOptions: { cwd: upstreamFixture.dir },
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

  // Reproduces #10: a consumer's pom.xml can pin a version tracking
  // upstream's own develop line via an alpha/rc build — one that would
  // never satisfy a strict semver tag pattern. Fold-in must still find
  // the qualifying entries for it.
  it('folds in entries for an Unreleased bucket pinning an upstream alpha version', async () => {
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

    await writePom('2.0.0-alpha-21');
    await fixture.commit('bump to 2.0.0-alpha-21');
    await fixture.tag('v1.0.0', '2024-01-01T00:00:00Z');

    await writePom('2.0.0-alpha-22');
    await fixture.commit('bump to 2.0.0-alpha-22');
    // No new consumer tag — this bump only shows up in the Unreleased bucket.

    const placement = placementWithBuckets([{ tag: tag('v1.0.0'), entries: [] }]);
    placement.allTags = [tag('v1.0.0')];

    const shaAtAlpha21 = await upstreamFixture.commit('feature pre-21');
    await upstreamFixture.tag('2.0.0-alpha-21', '2024-01-01T00:00:00Z');
    const shaAtAlpha22 = await upstreamFixture.commit('feature for 22');
    await upstreamFixture.tag('2.0.0-alpha-22', '2024-02-01T00:00:00Z');

    const upstreamEntries = [pr(1990, shaAtAlpha21), pr(2080, shaAtAlpha22)];

    vi.spyOn(githubDriver, 'fetchPullRequestFiles').mockImplementation(async () => [
      'runtime/module-a/src/main/java/Foo.java',
    ]);

    const sections = await computeFoldIn({
      upstream: {
        repo: 'acme/engine',
        'dependency-version-file': 'pom.xml',
        'dependency-version-property': 'engine.version',
        classification: 'path',
      },
      placement,
      upstreamEntries,
      upstreamGitOptions: { cwd: upstreamFixture.dir },
      headRef: 'develop',
      gitDir: fixture.dir,
      gitOptions: { cwd: fixture.dir },
      token: 't',
    });

    const section = sections.get(null);
    expect(section).toBeDefined();
    expect(section?.fromVersion).toBe('2.0.0-alpha-21');
    expect(section?.toVersion).toBe('2.0.0-alpha-22');
    expect(section?.entries.map((e) => e.number)).toEqual([2080]);
  });
});
