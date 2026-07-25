import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCompleteness } from '../src/completeness.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';

describe('checkCompleteness', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('flags a squash-merged PR whose number is missing from knownNumbers', async () => {
    const base = await fixture.commit('base');
    const squashed = await fixture.commit('fix(engine): do the thing (#1073)');
    void base;

    const issues = await checkCompleteness('HEAD', new Set(), { cwd: fixture.dir });

    expect(issues).toEqual([{ number: 1073, sha: squashed }]);
  });

  it('does not flag a squash-merged PR whose number is already known', async () => {
    await fixture.commit('base');
    await fixture.commit('fix(engine): do the thing (#1073)');

    const issues = await checkCompleteness('HEAD', new Set([1073]), { cwd: fixture.dir });

    expect(issues).toEqual([]);
  });

  it('flags a real merge commit via the "Merge pull request #NNN from" convention', async () => {
    await fixture.commit('base');
    const merge = await fixture.commit('Merge pull request #45 from acme/feature-x');

    const issues = await checkCompleteness('HEAD', new Set(), { cwd: fixture.dir });

    expect(issues).toEqual([{ number: 45, sha: merge }]);
  });

  it('ignores a bare "#NNN" reference inside the body that is not a merge/squash subject', async () => {
    await fixture.commit('base');
    // Looks like it references #929, but this is prose, not GitHub's own
    // "this commit IS a PR" convention (no trailing parens, no "Merge pull
    // request" prefix) — scanCommitsReferencingNumbers would match this,
    // checkCompleteness deliberately should not.
    await fixture.commit('fix: work around a bug related to #929');

    const issues = await checkCompleteness('HEAD', new Set(), { cwd: fixture.dir });

    expect(issues).toEqual([]);
  });

  it('only checks commits within the given range, not full history', async () => {
    await fixture.commit('fix(old): already released (#100)');
    await fixture.tag('v1.0.0', '2024-01-01T00:00:00Z');
    const newSha = await fixture.commit('fix(new): just merged (#200)');

    // #100 predates v1.0.0 and is out of range — even though it's also
    // "missing" from knownNumbers, it must not show up here; only #200
    // (within v1.0.0..HEAD) should.
    const issues = await checkCompleteness('v1.0.0..HEAD', new Set(), { cwd: fixture.dir });

    expect(issues).toEqual([{ number: 200, sha: newSha }]);
  });

  it('returns no issues when every merged PR in range is already known', async () => {
    await fixture.commit('fix(a): thing one (#1)');
    await fixture.commit('fix(b): thing two (#2)');

    const issues = await checkCompleteness('HEAD', new Set([1, 2]), { cwd: fixture.dir });

    expect(issues).toEqual([]);
  });

  it('deduplicates a repeated PR number appearing on more than one commit', async () => {
    await fixture.commit('fix(a): first pass (#1073)');
    const second = await fixture.commit('fix(a): amended (#1073)');
    void second;

    const issues = await checkCompleteness('HEAD', new Set(), { cwd: fixture.dir });

    expect(issues.map((issue) => issue.number)).toEqual([1073]);
  });
});
