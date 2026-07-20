import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitDate, listBranches, resolveRef, unmatchedCommits } from '../src/git.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';

const execFileAsync = promisify(execFile);

describe('unmatchedCommits', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('flags a commit with no patch-content equivalent on the target', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await fixture.checkout('support/1.x');
    const sha = await fixture.commit('fix: only on support/1.x');

    const candidates = await unmatchedCommits('develop', 'support/1.x', { cwd: fixture.dir });

    expect(candidates.map((c) => c.sha)).toContain(sha);
  });

  it('does not flag a commit that was cherry-picked to the target under a new sha', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await fixture.checkout('support/1.x');
    const sha = await fixture.commit('fix: cherry-picked later');

    await fixture.checkout('develop');
    await execFileAsync('git', ['cherry-pick', sha], { cwd: fixture.dir });

    const candidates = await unmatchedCommits('develop', 'support/1.x', { cwd: fixture.dir });

    expect(candidates.map((c) => c.sha)).not.toContain(sha);
  });

  it('parses the subject after the sha, regardless of hash width', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await fixture.checkout('support/1.x');
    const sha = await fixture.commit('fix: has a subject with spaces');

    const [candidate] = await unmatchedCommits('develop', 'support/1.x', { cwd: fixture.dir });

    expect(candidate.sha).toBe(sha);
    expect(candidate.subject).toBe('fix: has a subject with spaces');
  });
});

describe('listBranches', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('returns local branches matching pattern, without an origin remote', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await fixture.branch('support/2.x');
    await fixture.branch('feature/unrelated');

    const branches = await listBranches(/^support\/\d+\.x$/, { cwd: fixture.dir });

    expect(branches.sort()).toEqual(['support/1.x', 'support/2.x']);
  });

  it('strips the origin/ prefix and dedupes a name present as both local and remote-tracking', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    // Simulate a remote-tracking ref by copying the local branch under
    // refs/remotes/origin — no real remote is configured in this fixture.
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/support/1.x', 'refs/heads/support/1.x'], { cwd: fixture.dir });

    const branches = await listBranches(/^support\/\d+\.x$/, { cwd: fixture.dir });

    expect(branches).toEqual(['support/1.x']);
  });
});

describe('resolveRef', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('falls back to the bare name when no origin/<name> ref exists', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');

    expect(await resolveRef('support/1.x', { cwd: fixture.dir })).toBe('support/1.x');
  });

  it('prefers origin/<name> when it exists', async () => {
    await fixture.commit('init');
    await fixture.branch('support/1.x');
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/support/1.x', 'refs/heads/support/1.x'], { cwd: fixture.dir });

    expect(await resolveRef('support/1.x', { cwd: fixture.dir })).toBe('origin/support/1.x');
  });
});

describe('commitDate', () => {
  it('returns the commit date in ISO 8601 format', async () => {
    const fixture = await createGitFixture();
    const sha = await fixture.commit('init');

    const date = await commitDate(sha, { cwd: fixture.dir });

    // %cI is strict ISO 8601 — a UTC offset renders as trailing "Z" on some
    // git versions and "+00:00" on others; both are valid, so accept either.
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
    expect(new Date(date).getUTCFullYear()).toBe(2024);

    await fixture.cleanup();
  });
});
