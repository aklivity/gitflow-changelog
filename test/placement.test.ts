import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { place } from '../src/placement.js';
import type { Entry } from '../src/types.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';

function issue(number: number, sha: string): Entry {
  return { number, kind: 'issue', category: 'issue', title: `issue ${number}`, login: 'octocat', bot: false, sha };
}

function pr(number: number, sha: string): Entry {
  return { number, kind: 'pr', category: 'issue', title: `pr ${number}`, login: 'octocat', bot: false, sha };
}

describe('place', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('buckets entries by the earliest tag whose history contains them', async () => {
    const c1 = await fixture.commit('base');
    await fixture.tag('v1.0.0', '2024-01-01T00:00:00Z');

    const c2 = await fixture.commit('fix for issue 100');
    await fixture.tag('v1.1.0', '2024-02-01T00:00:00Z');

    const c3 = await fixture.commit('fix for issue 200, not yet tagged');

    await fixture.branch('feature-branch');
    await fixture.checkout('feature-branch');
    const c4 = await fixture.commit('pr 300 merged to an unrelated line');
    await fixture.checkout('develop');

    void c1;

    const result = await place(
      { entries: [issue(100, c2), issue(200, c3), pr(300, c4)], ref: 'develop', tagPattern: /.*/ },
      { cwd: fixture.dir },
    );

    expect(result.dropped.map((entry) => entry.number)).toEqual([300]);

    const unreleased = result.buckets.find((bucket) => bucket.tag === null);
    expect(unreleased?.entries.map((entry) => entry.number)).toEqual([200]);

    const v110 = result.buckets.find((bucket) => bucket.tag?.name === 'v1.1.0');
    expect(v110?.entries.map((entry) => entry.number)).toEqual([100]);

    const v100 = result.buckets.find((bucket) => bucket.tag?.name === 'v1.0.0');
    expect(v100).toBeUndefined();
  });

  it('excludes tags that do not match tagPattern from getting their own section', async () => {
    await fixture.commit('base');
    const c2 = await fixture.commit('fix for issue 100');
    await fixture.tag('v1.0.0-alpha.1', '2024-01-15T00:00:00Z');
    await fixture.tag('v1.0.0', '2024-02-01T00:00:00Z');

    const result = await place(
      { entries: [issue(100, c2)], ref: 'develop', tagPattern: /^v\d+\.\d+\.\d+$/ },
      { cwd: fixture.dir },
    );

    expect(result.buckets.map((bucket) => bucket.tag?.name)).toEqual(['v1.0.0']);
  });

  it('places an entry under the earliest tag even when a later tag also contains it', async () => {
    const c1 = await fixture.commit('base with fix');
    await fixture.tag('v1.0.0', '2024-01-01T00:00:00Z');
    await fixture.commit('unrelated change');
    await fixture.tag('v1.1.0', '2024-02-01T00:00:00Z');

    const result = await place(
      { entries: [issue(100, c1)], ref: 'develop', tagPattern: /.*/ },
      { cwd: fixture.dir },
    );

    const withEntry = result.buckets.filter((bucket) => bucket.entries.length > 0);
    expect(withEntry).toHaveLength(1);
    expect(withEntry[0].tag?.name).toBe('v1.0.0');
  });
});
