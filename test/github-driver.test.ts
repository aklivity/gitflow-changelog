import { describe, expect, it } from 'vitest';
import { emptyCache } from '../src/cache.js';
import { applyClosingReferences, applyEvent, entriesFromCache } from '../src/drivers/github.js';
import type { DriverOptions } from '../src/types.js';

const OPTIONS: DriverOptions = {
  owner: 'acme',
  repo: 'widget',
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

describe('applyClosingReferences', () => {
  it('backfills an issue closed by a merged PR\'s closing keyword, whose own closed event has no commit_id', () => {
    const cache = emptyCache();
    const closedEvent = {
      id: 1,
      event: 'closed' as const,
      commit_id: null,
      issue: { number: 924, title: 'Put /opt on PATH', user: issueUser('octocat'), labels: [] },
    };
    const mergedEvent = {
      id: 2,
      event: 'merged' as const,
      commit_id: 'merge-sha',
      issue: {
        number: 927,
        title: 'feat: put /opt on PATH',
        user: issueUser('octocat'),
        labels: [],
        pull_request: { merged_at: '2024-01-01T00:00:00Z' },
        body: 'Fixes #924',
      },
    };
    applyEvent(cache, closedEvent);
    applyEvent(cache, mergedEvent);
    applyClosingReferences(cache, [closedEvent, mergedEvent]);

    expect(entriesFromCache(cache, OPTIONS)).toContainEqual(
      { number: 924, kind: 'issue', category: 'issue', title: 'Put /opt on PATH', login: 'octocat', bot: false, sha: 'merge-sha' },
    );
  });

  it('recognizes closes/fixes/resolves, case-insensitively, with or without a colon', () => {
    for (const keyword of ['Closes', 'CLOSED', 'fix', 'Fixed', 'resolve', 'Resolves:'])
    {
      const cache = emptyCache();
      applyEvent(cache, { id: 1, event: 'closed', commit_id: null, issue: { number: 10, title: 'x', user: issueUser('a'), labels: [] } });
      const mergedEvent = {
        id: 2,
        event: 'merged' as const,
        commit_id: 'sha',
        issue: {
          number: 20,
          title: 'y',
          user: issueUser('a'),
          labels: [],
          pull_request: { merged_at: '2024-01-01T00:00:00Z' },
          body: `${keyword} #10`,
        },
      };
      applyEvent(cache, mergedEvent);
      applyClosingReferences(cache, [mergedEvent]);

      expect(cache.entries['10'].sha).toBe('sha');
    }
  });

  it('does not backfill from a non-closing mention like "See #924"', () => {
    const cache = emptyCache();
    applyEvent(cache, { id: 1, event: 'closed', commit_id: null, issue: { number: 924, title: 'x', user: issueUser('a'), labels: [] } });
    const mergedEvent = {
      id: 2,
      event: 'merged' as const,
      commit_id: 'sha',
      issue: {
        number: 927,
        title: 'y',
        user: issueUser('a'),
        labels: [],
        pull_request: { merged_at: '2024-01-01T00:00:00Z' },
        body: 'See #924 for context',
      },
    };
    applyEvent(cache, mergedEvent);
    applyClosingReferences(cache, [mergedEvent]);

    expect(cache.entries['924'].sha).toBeUndefined();
  });

  it('does not overwrite a sha already set from the issue\'s own closed event', () => {
    const cache = emptyCache();
    applyEvent(cache, { id: 1, event: 'closed', commit_id: 'direct-sha', issue: { number: 924, title: 'x', user: issueUser('a'), labels: [] } });
    const mergedEvent = {
      id: 2,
      event: 'merged' as const,
      commit_id: 'merge-sha',
      issue: {
        number: 927,
        title: 'y',
        user: issueUser('a'),
        labels: [],
        pull_request: { merged_at: '2024-01-01T00:00:00Z' },
        body: 'Fixes #924',
      },
    };
    applyEvent(cache, mergedEvent);
    applyClosingReferences(cache, [mergedEvent]);

    expect(cache.entries['924'].sha).toBe('direct-sha');
  });

  it('is a no-op when the referenced issue was never independently observed', () => {
    const cache = emptyCache();
    const mergedEvent = {
      id: 1,
      event: 'merged' as const,
      commit_id: 'sha',
      issue: {
        number: 927,
        title: 'y',
        user: issueUser('a'),
        labels: [],
        pull_request: { merged_at: '2024-01-01T00:00:00Z' },
        body: 'Fixes #924',
      },
    };
    applyEvent(cache, mergedEvent);

    expect(() => applyClosingReferences(cache, [mergedEvent])).not.toThrow();
    expect(cache.entries['924']).toBeUndefined();
  });
});
