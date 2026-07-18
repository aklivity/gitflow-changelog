import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as githubModule from '../src/drivers/github.js';
import * as gitModule from '../src/git.js';
import { EMPTY_OVERRIDES } from '../src/overrides.js';
import { resolveHashes } from '../src/resolve.js';
import type { Entry } from '../src/types.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';

const DEAD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const OTHER_DEAD_SHA = 'baaaaaadbaaaaaadbaaaaaadbaaaaaadbaaaaaad';
const GITHUB = { owner: 'aklivity', repo: 'zilla', token: 'token' };

function pr(number: number, sha: string): Entry {
  return { number, kind: 'pr', category: 'issue', title: `pr ${number}`, login: 'octocat', bot: false, sha };
}

function issue(number: number, sha: string): Entry {
  return { number, kind: 'issue', category: 'issue', title: `issue ${number}`, login: 'octocat', bot: false, sha };
}

describe('resolveHashes', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
    vi.restoreAllMocks();
  });

  it('passes through entries whose recorded commit exists', async () => {
    const c1 = await fixture.commit('base');

    const result = await resolveHashes(
      { entries: [pr(1, c1)], overrides: EMPTY_OVERRIDES, ref: 'develop' },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(1, c1)]);
    expect(result.unresolved).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('applies a checked-in override even when the recorded commit is bogus', async () => {
    await fixture.commit('base');
    const c2 = await fixture.commit('real fix, referenced by #1947 in message');

    const result = await resolveHashes(
      {
        entries: [pr(1947, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')],
        overrides: new Map([['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', c2]]),
        ref: 'develop',
      },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(1947, c2)]);
    expect(result.unresolved).toEqual([]);
  });

  // The core motivating case: an issue auto-closed by a merged PR has its
  // sha backfilled from that PR's own commit (applyClosingReferences in
  // drivers/github.ts), so both entries carry the identical broken sha —
  // one hash-overrides entry resolves both, no per-(kind, number) override
  // needed for each.
  it('a single override entry resolves both a PR and an issue sharing the same broken sha', async () => {
    await fixture.commit('base');
    const replacement = await fixture.commit('the squash commit that actually carries this content');

    const result = await resolveHashes(
      {
        entries: [pr(174, DEAD_SHA), issue(171, DEAD_SHA)],
        overrides: new Map([[DEAD_SHA, replacement]]),
        ref: 'develop',
      },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(174, replacement), issue(171, replacement)]);
    expect(result.unresolved).toEqual([]);
  });

  it('auto-substitutes when exactly one commit message references the PR number', async () => {
    await fixture.commit('base');
    const c2 = await fixture.commit('fix thing (#42)');

    const result = await resolveHashes(
      { entries: [pr(42, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')], overrides: EMPTY_OVERRIDES, ref: 'develop' },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(42, c2)]);
    expect(result.unresolved).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('auto-substituted');
  });

  it('flags as unresolved when no commit references the number', async () => {
    await fixture.commit('base');

    const result = await resolveHashes(
      { entries: [pr(99, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')], overrides: EMPTY_OVERRIDES, ref: 'develop' },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toBe('not-found-anywhere');
  });

  it('flags as unresolved when multiple commits ambiguously reference the number', async () => {
    await fixture.commit('base');
    await fixture.commit('fix thing (#7)');
    await fixture.commit('another fix (#7)');

    const result = await resolveHashes(
      { entries: [pr(7, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')], overrides: EMPTY_OVERRIDES, ref: 'develop' },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toBe('ambiguous-candidates');
    expect(result.unresolved[0].candidates).toHaveLength(2);
  });

  it('reuses a cached fallback substitute without rescanning history', async () => {
    await fixture.commit('base');
    const c2 = await fixture.commit('fix thing (#42)');

    const cache = { 'pr:42': { originalSha: DEAD_SHA, resolvedSha: c2 } };
    const spy = vi.spyOn(gitModule, 'scanCommitsReferencingNumbers');

    const result = await resolveHashes(
      { entries: [pr(42, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', hashFallbackCache: cache },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(42, c2)]);
    expect(result.warnings[0]).toContain('reusing cached substitute');
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores a cached fallback whose originalSha no longer matches the entry, and refreshes it', async () => {
    await fixture.commit('base');
    const c2 = await fixture.commit('fix thing (#42)');

    const cache = { 'pr:42': { originalSha: OTHER_DEAD_SHA, resolvedSha: c2 } };

    const result = await resolveHashes(
      { entries: [pr(42, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', hashFallbackCache: cache },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(42, c2)]);
    expect(result.warnings[0]).toContain('auto-substituted');
    expect(cache['pr:42']).toEqual({ originalSha: DEAD_SHA, resolvedSha: c2 });
  });

  it('ignores a cached fallback whose resolvedSha no longer exists, and refreshes it', async () => {
    await fixture.commit('base');
    const c2 = await fixture.commit('fix thing (#42)');

    const cache = { 'pr:42': { originalSha: DEAD_SHA, resolvedSha: OTHER_DEAD_SHA } };

    const result = await resolveHashes(
      { entries: [pr(42, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', hashFallbackCache: cache },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(42, c2)]);
    expect(cache['pr:42']).toEqual({ originalSha: DEAD_SHA, resolvedSha: c2 });
  });

  it('an explicit override still wins over a cached fallback', async () => {
    await fixture.commit('base');
    const c2 = await fixture.commit('fix thing (#42)');
    const c3 = await fixture.commit('the actually-correct fix (#42)');

    const cache = { 'pr:42': { originalSha: DEAD_SHA, resolvedSha: c2 } };

    const result = await resolveHashes(
      {
        entries: [pr(42, DEAD_SHA)],
        overrides: new Map([[DEAD_SHA, c3]]),
        ref: 'develop',
        hashFallbackCache: cache,
      },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(42, c3)]);
  });

  it('scans history exactly once no matter how many entries need the fallback', async () => {
    await fixture.commit('base');
    const c2 = await fixture.commit('fix thing (#42)');
    const c3 = await fixture.commit('another fix (#43)');

    const spy = vi.spyOn(gitModule, 'scanCommitsReferencingNumbers');

    const result = await resolveHashes(
      { entries: [pr(42, DEAD_SHA), pr(43, OTHER_DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop' },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(42, c2), pr(43, c3)]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Tier 4: a PR merged into a long-lived feature branch that was itself
  // later squash-merged into the repo's default branch has its own commit
  // flattened away — the real zilla case (feature/grpc-kafka squash-merged
  // via #225).
  describe('squash-merge fallback (tier 4)', () => {
    it('resolves via the squash-merge PR when the entry\'s own number is not referenced', async () => {
      await fixture.commit('base');
      const squashCommit = await fixture.commit('grpc-kafka feature baseline (#225)');

      vi.spyOn(githubModule, 'fetchDefaultBranch').mockResolvedValue('develop');
      vi.spyOn(githubModule, 'fetchPullRequestBaseRef').mockResolvedValue('feature/grpc-kafka');
      vi.spyOn(githubModule, 'findSquashMergePr').mockResolvedValue(225);

      const result = await resolveHashes(
        { entries: [pr(174, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', github: GITHUB },
        { cwd: fixture.dir },
      );

      expect(result.resolved).toEqual([pr(174, squashCommit)]);
      expect(result.unresolved).toEqual([]);
      expect(result.warnings[0]).toContain('squash-merge');
      expect(result.warnings[0]).toContain('#225');
    });

    it('does not attempt the squash-merge tier for issue-kind entries', async () => {
      await fixture.commit('base');

      const defaultBranchSpy = vi.spyOn(githubModule, 'fetchDefaultBranch');
      const baseRefSpy = vi.spyOn(githubModule, 'fetchPullRequestBaseRef');

      const result = await resolveHashes(
        { entries: [issue(171, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', github: GITHUB },
        { cwd: fixture.dir },
      );

      expect(defaultBranchSpy).not.toHaveBeenCalled();
      expect(baseRefSpy).not.toHaveBeenCalled();
      expect(result.unresolved).toHaveLength(1);
    });

    it('skips the squash-merge tier when the PR\'s base ref is already the repo\'s default branch', async () => {
      await fixture.commit('base');

      vi.spyOn(githubModule, 'fetchDefaultBranch').mockResolvedValue('develop');
      vi.spyOn(githubModule, 'fetchPullRequestBaseRef').mockResolvedValue('develop');
      const searchSpy = vi.spyOn(githubModule, 'findSquashMergePr');

      const result = await resolveHashes(
        { entries: [pr(99, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', github: GITHUB },
        { cwd: fixture.dir },
      );

      expect(searchSpy).not.toHaveBeenCalled();
      expect(result.unresolved).toHaveLength(1);
    });

    // Confirmed against the real aklivity/zilla history: a squash-merge
    // PR's base is always the repo's actual default branch (develop), even
    // when generating the changelog for a maintenance branch that merely
    // inherited the same squash commit via ancestry. Comparing against
    // `ref` (support/1.x here) instead of the real default branch would
    // wrongly search `base:support/1.x` and find nothing.
    it('still resolves via the default branch when ref is a maintenance branch, not develop', async () => {
      await fixture.commit('base');
      const squashCommit = await fixture.commit('grpc-kafka feature baseline (#225)');
      await fixture.branch('support/1.x');

      vi.spyOn(githubModule, 'fetchDefaultBranch').mockResolvedValue('develop');
      vi.spyOn(githubModule, 'fetchPullRequestBaseRef').mockResolvedValue('feature/grpc-kafka');
      const searchSpy = vi.spyOn(githubModule, 'findSquashMergePr').mockResolvedValue(225);

      const result = await resolveHashes(
        { entries: [pr(174, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'support/1.x', github: GITHUB },
        { cwd: fixture.dir },
      );

      expect(result.resolved).toEqual([pr(174, squashCommit)]);
      expect(searchSpy).toHaveBeenCalledWith('aklivity', 'zilla', 'feature/grpc-kafka', 'develop', 'token');
    });

    it('leaves the entry unresolved when no squash-merge PR is found', async () => {
      await fixture.commit('base');

      vi.spyOn(githubModule, 'fetchDefaultBranch').mockResolvedValue('develop');
      vi.spyOn(githubModule, 'fetchPullRequestBaseRef').mockResolvedValue('feature/orphaned');
      vi.spyOn(githubModule, 'findSquashMergePr').mockResolvedValue(undefined);

      const result = await resolveHashes(
        { entries: [pr(174, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', github: GITHUB },
        { cwd: fixture.dir },
      );

      expect(result.resolved).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
    });

    it('leaves the entry unresolved when the squash-merge PR number is ambiguous in commit messages', async () => {
      await fixture.commit('base');
      await fixture.commit('baseline (#225)');
      await fixture.commit('another mention (#225)');

      vi.spyOn(githubModule, 'fetchDefaultBranch').mockResolvedValue('develop');
      vi.spyOn(githubModule, 'fetchPullRequestBaseRef').mockResolvedValue('feature/grpc-kafka');
      vi.spyOn(githubModule, 'findSquashMergePr').mockResolvedValue(225);

      const result = await resolveHashes(
        { entries: [pr(174, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', github: GITHUB },
        { cwd: fixture.dir },
      );

      expect(result.resolved).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
    });

    it('does not attempt the squash-merge tier at all when no github context is provided', async () => {
      await fixture.commit('base');
      const defaultBranchSpy = vi.spyOn(githubModule, 'fetchDefaultBranch');
      const baseRefSpy = vi.spyOn(githubModule, 'fetchPullRequestBaseRef');

      const result = await resolveHashes(
        { entries: [pr(174, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop' },
        { cwd: fixture.dir },
      );

      expect(defaultBranchSpy).not.toHaveBeenCalled();
      expect(baseRefSpy).not.toHaveBeenCalled();
      expect(result.unresolved).toHaveLength(1);
    });

    // The other half of the real zilla case: issue #171 was auto-closed by
    // PR #174 and shares its exact broken sha (applyClosingReferences in
    // drivers/github.ts) — it should resolve for free off #174's
    // squash-merge lookup, with no base-ref lookup of its own.
    it('resolves a same-sha issue for free once its closing PR resolves via squash-merge', async () => {
      await fixture.commit('base');
      const squashCommit = await fixture.commit('grpc-kafka feature baseline (#225)');

      vi.spyOn(githubModule, 'fetchDefaultBranch').mockResolvedValue('develop');
      vi.spyOn(githubModule, 'fetchPullRequestBaseRef').mockResolvedValue('feature/grpc-kafka');
      const searchSpy = vi.spyOn(githubModule, 'findSquashMergePr').mockResolvedValue(225);

      const result = await resolveHashes(
        { entries: [pr(174, DEAD_SHA), issue(171, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', github: GITHUB },
        { cwd: fixture.dir },
      );

      expect(result.resolved).toEqual(expect.arrayContaining([pr(174, squashCommit), issue(171, squashCommit)]));
      expect(result.unresolved).toEqual([]);
      // The base-ref/search lookup only ran once — for the PR — not once
      // per entry sharing the broken sha.
      expect(searchSpy).toHaveBeenCalledTimes(1);
    });

    it('persists discovered base refs and squash PR numbers into the caller-provided squash cache', async () => {
      await fixture.commit('base');
      await fixture.commit('grpc-kafka feature baseline (#225)');

      vi.spyOn(githubModule, 'fetchDefaultBranch').mockResolvedValue('develop');
      vi.spyOn(githubModule, 'fetchPullRequestBaseRef').mockResolvedValue('feature/grpc-kafka');
      vi.spyOn(githubModule, 'findSquashMergePr').mockResolvedValue(225);

      const squashMergeCache = { prBaseRefs: {}, squashMergePrs: {} };
      await resolveHashes(
        { entries: [pr(174, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', github: GITHUB, squashMergeCache },
        { cwd: fixture.dir },
      );

      expect(squashMergeCache.prBaseRefs).toEqual({ '174': 'feature/grpc-kafka' });
      expect(squashMergeCache.squashMergePrs).toEqual({ 'feature/grpc-kafka': 225 });
    });

    it('reuses a cached base ref and squash PR number without re-fetching', async () => {
      await fixture.commit('base');
      const squashCommit = await fixture.commit('grpc-kafka feature baseline (#225)');

      vi.spyOn(githubModule, 'fetchDefaultBranch').mockResolvedValue('develop');
      const baseRefSpy = vi.spyOn(githubModule, 'fetchPullRequestBaseRef');
      const searchSpy = vi.spyOn(githubModule, 'findSquashMergePr');

      const squashMergeCache = {
        prBaseRefs: { '174': 'feature/grpc-kafka' },
        squashMergePrs: { 'feature/grpc-kafka': 225 },
      };
      const result = await resolveHashes(
        { entries: [pr(174, DEAD_SHA)], overrides: EMPTY_OVERRIDES, ref: 'develop', github: GITHUB, squashMergeCache },
        { cwd: fixture.dir },
      );

      expect(result.resolved).toEqual([pr(174, squashCommit)]);
      expect(baseRefSpy).not.toHaveBeenCalled();
      expect(searchSpy).not.toHaveBeenCalled();
    });
  });
});
