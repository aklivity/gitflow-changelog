import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as gitModule from '../src/git.js';
import { EMPTY_OVERRIDES } from '../src/overrides.js';
import { resolveHashes } from '../src/resolve.js';
import type { Entry } from '../src/types.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';

const DEAD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const OTHER_DEAD_SHA = 'baaaaaadbaaaaaadbaaaaaadbaaaaaadbaaaaaad';

function pr(number: number, sha: string): Entry {
  return { number, kind: 'pr', category: 'issue', title: `pr ${number}`, login: 'octocat', bot: false, sha };
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
        overrides: { prOverrides: new Map([[1947, c2]]), issueOverrides: new Map() },
        ref: 'develop',
      },
      { cwd: fixture.dir },
    );

    expect(result.resolved).toEqual([pr(1947, c2)]);
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
        overrides: { prOverrides: new Map([[42, c3]]), issueOverrides: new Map() },
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
});
