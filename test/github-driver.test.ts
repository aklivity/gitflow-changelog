import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCache } from '../src/cache.js';
import { applyClosingReferences, applyEvent, entriesFromCache, excludedShas, fetchDefaultBranch, fetchPullRequestBaseRef, findSquashMergePr, GithubRateLimitError, walkNewEvents } from '../src/drivers/github.js';
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

describe('excludedShas', () => {
  it('collects the sha of any entry whose labels intersect excludeLabels', () => {
    const cache = emptyCache();
    applyEvent(cache, {
      id: 1,
      event: 'merged',
      commit_id: 'dep-sha',
      issue: {
        number: 900,
        title: 'Bump some-lib',
        user: issueUser('dependabot[bot]', true),
        labels: [{ name: 'dependencies' }],
        pull_request: { merged_at: '2024-01-01T00:00:00Z' },
      },
    });
    applyEvent(cache, {
      id: 2,
      event: 'merged',
      commit_id: 'real-fix-sha',
      issue: {
        number: 901,
        title: 'fix crash',
        user: issueUser('octocat'),
        labels: [{ name: 'bug' }],
        pull_request: { merged_at: '2024-01-01T00:00:00Z' },
      },
    });

    expect(excludedShas(cache, ['dependencies'])).toEqual(new Set(['dep-sha']));
  });

  it('ignores an entry with no recorded sha', () => {
    const cache = emptyCache();
    applyEvent(cache, {
      id: 1,
      event: 'labeled',
      commit_id: null,
      issue: { number: 900, title: 'still open', user: issueUser('octocat'), labels: [{ name: 'dependencies' }] },
      label: { name: 'dependencies' },
    });

    expect(excludedShas(cache, ['dependencies'])).toEqual(new Set());
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

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body } as Response;
}

function primaryRateLimitResponse(): Response {
  return jsonResponse(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
}

function secondaryRateLimitResponse(): Response {
  return jsonResponse(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '60' });
}

function issueEvent(id: number) {
  return {
    id,
    event: 'labeled',
    commit_id: null,
    issue: { number: id, title: `event ${id}`, user: issueUser('octocat'), labels: [] },
  };
}

function pageResponse(events: ReturnType<typeof issueEvent>[], lastPage: number | undefined): Response {
  const headers: Record<string, string> = lastPage === undefined
    ? {}
    : { link: `<https://api.github.com/repos/acme/widget/issues/events?page=${lastPage}>; rel="last"` };
  return jsonResponse(200, events, headers);
}

function pageOf(url: string): number {
  return Number(new URL(url).searchParams.get('page'));
}

describe('walkNewEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns every event when everything fits on a single page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pageResponse([issueEvent(1), issueEvent(2)], undefined)));

    const events = await walkNewEvents('acme', 'widget', 'token', 0);

    expect(events.map((event) => event.id)).toEqual([1, 2]);
  });

  it('stops walking backward once a page has nothing newer than lastEventId', async () => {
    // 5 pages total, no drift. Only pages 4 and 5 have anything newer than
    // lastEventId=30; page 3 has nothing new and should end the walk before
    // pages 2 or 1 (beyond the initial bootstrap fetch) are ever requested.
    const fetchMock = vi.fn(async (url: string) => {
      const page = pageOf(url);
      const byPage: Record<number, ReturnType<typeof issueEvent>[]> = {
        1: [issueEvent(10)],
        2: [issueEvent(20)],
        3: [issueEvent(25)],
        4: [issueEvent(40)],
        5: [issueEvent(50)],
      };
      return pageResponse(byPage[page], 5);
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await walkNewEvents('acme', 'widget', 'token', 30);

    expect(events.map((event) => event.id)).toEqual([40, 50]);
    // Bootstrap (page 1) + page 5 + page 4 + page 3 (empty, ends the walk).
    // Pages 2 and beyond must never be requested.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => pageOf(url as string)).sort((a, b) => a - b)).toEqual([1, 3, 4, 5]);
  });

  // The regression case: a naive "compute the last page once, from the
  // very first request" walk would stop at page 3 and never learn page 4
  // exists at all — silently dropping event 4 with no error anywhere. This
  // is the exact shape of aklivity/zilla-plus#1073/#1075 going missing from
  // a real changelog run.
  it('picks up a page that appears only after the walk has already started (pagination drift)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const page = pageOf(url);
      if (page === 1)
      {
        // At the moment of this request, only 3 pages exist.
        return pageResponse([issueEvent(1)], 3);
      }
      if (page === 3)
      {
        // By the time page 3 is fetched, a new event has pushed the total
        // to 4 pages — discovered here, mid-walk, not at the start.
        return pageResponse([issueEvent(3)], 4);
      }
      if (page === 4)
      {
        return pageResponse([issueEvent(4)], 4);
      }
      if (page === 2)
      {
        return pageResponse([issueEvent(2)], 4);
      }
      throw new Error(`unexpected page ${page}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await walkNewEvents('acme', 'widget', 'token', 0);

    expect(events.map((event) => event.id)).toEqual([1, 2, 3, 4]);
  });

  it('deduplicates an event refetched twice across the recursive drift-handling paths', async () => {
    // Drift is discovered twice in a row (3 -> 4, then 4 -> 5), and the
    // walk must still land on each real event exactly once.
    const fetchMock = vi.fn(async (url: string) => {
      const page = pageOf(url);
      if (page === 1) return pageResponse([issueEvent(1)], 3);
      if (page === 3) return pageResponse([issueEvent(3)], 4);
      if (page === 4) return pageResponse([issueEvent(4)], 5);
      if (page === 5) return pageResponse([issueEvent(5)], 5);
      if (page === 2) return pageResponse([issueEvent(2)], 5);
      throw new Error(`unexpected page ${page}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await walkNewEvents('acme', 'widget', 'token', 0);

    expect(events.map((event) => event.id)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(events.map((event) => event.id)).size).toBe(5);
  });
});

describe('fetchPullRequestBaseRef', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the base ref on a 2xx response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { base: { ref: 'feature/grpc-kafka' } }));
    vi.stubGlobal('fetch', fetchMock);

    const baseRef = await fetchPullRequestBaseRef('aklivity', 'zilla', 174, 'token');

    expect(baseRef).toBe('feature/grpc-kafka');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/aklivity/zilla/pulls/174',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
    );
  });

  it('returns undefined on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, {})));
    expect(await fetchPullRequestBaseRef('aklivity', 'zilla', 999999, 'token')).toBeUndefined();
  });

  it('throws GithubRateLimitError on a primary rate-limit response, not undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => primaryRateLimitResponse()));
    await expect(fetchPullRequestBaseRef('aklivity', 'zilla', 174, 'token')).rejects.toThrow(GithubRateLimitError);
  });

  it('throws GithubRateLimitError on a secondary (abuse-detection) rate-limit response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => secondaryRateLimitResponse()));
    await expect(fetchPullRequestBaseRef('aklivity', 'zilla', 174, 'token')).rejects.toThrow(GithubRateLimitError);
  });

  it('throws GithubRateLimitError on a 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429, {})));
    await expect(fetchPullRequestBaseRef('aklivity', 'zilla', 174, 'token')).rejects.toThrow(GithubRateLimitError);
  });
});

describe('findSquashMergePr', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the number of the first matching merged PR, filtering by both head and base', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(200, { items: [{ number: 225 }] }));
    vi.stubGlobal('fetch', fetchMock);

    const prNumber = await findSquashMergePr('aklivity', 'zilla', 'feature/grpc-kafka', 'develop', 'token');

    expect(prNumber).toBe(225);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('search/issues?q=');
    expect(decodeURIComponent(url)).toContain('repo:aklivity/zilla type:pr is:merged head:feature/grpc-kafka base:develop');
  });

  it('returns undefined when no PR matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { items: [] })));
    expect(await findSquashMergePr('aklivity', 'zilla', 'feature/never-merged', 'develop', 'token')).toBeUndefined();
  });

  it('returns undefined on an ordinary 403 (e.g. token lacks scope), not a rate-limit shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { message: 'Resource not accessible by integration' })));
    expect(await findSquashMergePr('aklivity', 'zilla', 'feature/grpc-kafka', 'develop', 'token')).toBeUndefined();
  });

  it('throws GithubRateLimitError on a rate-limit response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => primaryRateLimitResponse()));
    await expect(findSquashMergePr('aklivity', 'zilla', 'feature/grpc-kafka', 'develop', 'token')).rejects.toThrow(GithubRateLimitError);
  });
});

describe('fetchDefaultBranch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the default branch on a 2xx response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { default_branch: 'develop' }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchDefaultBranch('aklivity', 'zilla', 'token')).toBe('develop');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/aklivity/zilla',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
    );
  });

  it('returns undefined on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, {})));
    expect(await fetchDefaultBranch('aklivity', 'nonexistent', 'token')).toBeUndefined();
  });

  it('throws GithubRateLimitError on a rate-limit response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => primaryRateLimitResponse()));
    await expect(fetchDefaultBranch('aklivity', 'zilla', 'token')).rejects.toThrow(GithubRateLimitError);
  });
});
