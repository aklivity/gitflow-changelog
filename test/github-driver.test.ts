import { describe, expect, it } from 'vitest';
import { emptyCache } from '../src/cache.js';
import { applyEvent, entriesFromCache } from '../src/drivers/github.js';
import type { DriverOptions } from '../src/types.js';

const OPTIONS: DriverOptions = {
  owner: 'aklivity',
  repo: 'zilla',
  token: 'token',
  enhancementLabels: ['enhancement'],
  bugLabels: ['bug'],
  excludeLabels: ['wontfix'],
};

function issueUser(login: string, botLogin = false) {
  return { login, type: botLogin ? 'Bot' : 'User' };
}

describe('applyEvent + entriesFromCache', () => {
  it('records an issue close as a shipped entry', () => {
    const cache = emptyCache();
    applyEvent(cache, {
      id: 1,
      event: 'closed',
      commit_id: 'abc123',
      issue: { number: 100, title: 'Fix the thing', user: issueUser('octocat'), labels: [{ name: 'bug' }] },
    });

    const entries = entriesFromCache(cache, OPTIONS);
    expect(entries).toEqual([
      { number: 100, kind: 'issue', category: 'bug', title: 'Fix the thing', login: 'octocat', bot: false, sha: 'abc123' },
    ]);
  });

  it('does not ship a PR that was closed without merging', () => {
    const cache = emptyCache();
    applyEvent(cache, {
      id: 1,
      event: 'closed',
      commit_id: null,
      issue: {
        number: 200,
        title: 'Abandoned PR',
        user: issueUser('octocat'),
        labels: [],
        pull_request: { merged_at: null },
      },
    });

    expect(entriesFromCache(cache, OPTIONS)).toEqual([]);
  });

  it('ships a merged PR', () => {
    const cache = emptyCache();
    applyEvent(cache, {
      id: 1,
      event: 'merged',
      commit_id: 'def456',
      issue: {
        number: 300,
        title: 'Add feature',
        user: issueUser('octocat'),
        labels: [{ name: 'enhancement' }],
        pull_request: { merged_at: '2024-01-01T00:00:00Z' },
      },
    });

    expect(entriesFromCache(cache, OPTIONS)).toEqual([
      { number: 300, kind: 'pr', category: 'enhancement', title: 'Add feature', login: 'octocat', bot: false, sha: 'def456' },
    ]);
  });

  it('invalidates the shipped sha on reopen', () => {
    const cache = emptyCache();
    const issue = { number: 100, title: 'Flaky', user: issueUser('octocat'), labels: [] };
    applyEvent(cache, { id: 1, event: 'closed', commit_id: 'abc123', issue });
    applyEvent(cache, { id: 2, event: 'reopened', commit_id: null, issue });

    expect(entriesFromCache(cache, OPTIONS)).toEqual([]);
    expect(cache.entries['100'].sha).toBeUndefined();
  });

  it('updates labels from labeled/unlabeled and excludes on exclude-labels', () => {
    const cache = emptyCache();
    const issue = { number: 100, title: 'Something', user: issueUser('octocat'), labels: [{ name: 'bug' }] };
    applyEvent(cache, { id: 1, event: 'closed', commit_id: 'abc123', issue });
    applyEvent(cache, {
      id: 2,
      event: 'labeled',
      commit_id: null,
      issue: { ...issue, labels: [{ name: 'bug' }, { name: 'wontfix' }] },
      label: { name: 'wontfix' },
    });

    expect(entriesFromCache(cache, OPTIONS)).toEqual([]);
  });

  it('updates the cached title on rename', () => {
    const cache = emptyCache();
    const issue = { number: 100, title: 'Old title', user: issueUser('octocat'), labels: [] };
    applyEvent(cache, { id: 1, event: 'closed', commit_id: 'abc123', issue });
    applyEvent(cache, {
      id: 2,
      event: 'renamed',
      commit_id: null,
      issue,
      rename: { from: 'Old title', to: 'New title' },
    });

    expect(entriesFromCache(cache, OPTIONS)[0].title).toBe('New title');
  });

  it('tracks the highest event id as the watermark', () => {
    const cache = emptyCache();
    const issue = { number: 100, title: 'x', user: issueUser('octocat'), labels: [] };
    applyEvent(cache, { id: 5, event: 'closed', commit_id: 'abc123', issue });
    applyEvent(cache, { id: 3, event: 'labeled', commit_id: null, issue, label: { name: 'bug' } });

    expect(cache.lastEventId).toBe(5);
  });

  it('renders bot author logins with the [bot] suffix stripped from the app URL', () => {
    const cache = emptyCache();
    applyEvent(cache, {
      id: 1,
      event: 'merged',
      commit_id: 'abc123',
      issue: {
        number: 400,
        title: 'Bump dependency',
        user: issueUser('dependabot[bot]', true),
        labels: [],
        pull_request: { merged_at: '2024-01-01T00:00:00Z' },
      },
    });

    const [entry] = entriesFromCache(cache, OPTIONS);
    expect(entry.bot).toBe(true);
    expect(entry.login).toBe('dependabot[bot]');
  });
});
