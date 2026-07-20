import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitDate, unmatchedCommits } from '../src/git.js';
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

describe('commitDate', () => {
  it('returns the commit date in ISO 8601 format', async () => {
    const fixture = await createGitFixture();
    const sha = await fixture.commit('init');

    const date = await commitDate(sha, { cwd: fixture.dir });

    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(new Date(date).getUTCFullYear()).toBe(2024);

    await fixture.cleanup();
  });
});
