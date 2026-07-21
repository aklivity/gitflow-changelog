import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitDate,
  findCommitsContainingSubject,
  listBranches,
  resolveRef,
  scanPortsTrailers,
  unmatchedCommits,
} from '../src/git.js';
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

describe('findCommitsContainingSubject', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('finds a commit on ref whose subject contains the substring', async () => {
    await fixture.commit('init');
    const sha = await fixture.commit('fix: apply route topic rewrite to Metadata requests');

    const found = await findCommitsContainingSubject('develop', 'apply route topic rewrite to Metadata requests', { cwd: fixture.dir });

    expect(found.map((c) => c.sha)).toContain(sha);
    expect(found.find((c) => c.sha === sha)?.subject).toBe('fix: apply route topic rewrite to Metadata requests');
  });

  it('returns an empty array when nothing matches', async () => {
    await fixture.commit('init');

    const found = await findCommitsContainingSubject('develop', 'nothing like this exists', { cwd: fixture.dir });

    expect(found).toEqual([]);
  });

  it('treats the search string as a literal substring, not a regex', async () => {
    await fixture.commit('init');
    const sha = await fixture.commit('fix(binding-kafka-proxy): apply route topic rewrite (#962)');

    // '(' and ')' would be regex metacharacters if not treated literally.
    const found = await findCommitsContainingSubject('develop', 'fix(binding-kafka-proxy): apply route topic rewrite', { cwd: fixture.dir });

    expect(found.map((c) => c.sha)).toContain(sha);
  });
});

describe('scanPortsTrailers', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('finds a Ports: trailer value in a commit body reachable from ref', async () => {
    await fixture.commit('init');
    await fixture.commit('chore(docker-image): add command-logs dependency\n\nPorts: 5a7e45294812fad54d63f9b2e88f226fec32179b');

    const values = await scanPortsTrailers('develop', { cwd: fixture.dir });

    expect(values).toContain('5a7e45294812fad54d63f9b2e88f226fec32179b');
  });

  it('returns an empty array when no commit carries a Ports: trailer', async () => {
    await fixture.commit('init');
    await fixture.commit('fix: ordinary commit with no trailer');

    const values = await scanPortsTrailers('develop', { cwd: fixture.dir });

    expect(values).toEqual([]);
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
