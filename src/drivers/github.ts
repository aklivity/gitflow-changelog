import type { CacheEntry, CacheFile } from '../cache.js';
import type { Category, DriverOptions, Driver, Entry } from '../types.js';

const API_BASE = 'https://api.github.com';
const PER_PAGE = 100;

interface GithubUser {
  login: string;
  type: string;
}

interface GithubIssueOrPr {
  number: number;
  title: string;
  user: GithubUser;
  labels: Array<{ name: string }>;
  pull_request?: { merged_at: string | null };
  body?: string | null;
}

interface GithubIssueEvent {
  id: number;
  event: string;
  commit_id: string | null;
  issue: GithubIssueOrPr;
  label?: { name: string };
  rename?: { from: string; to: string };
}

function extractLastPage(linkHeader: string | null): number | undefined {
  if (!linkHeader)
  {
    return undefined;
  }
  const match = linkHeader
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="last"'));
  if (!match)
  {
    return undefined;
  }
  const urlMatch = match.match(/<([^>]+)>/);
  if (!urlMatch)
  {
    return undefined;
  }
  const pageParam = new URL(urlMatch[1]).searchParams.get('page');
  return pageParam ? Number(pageParam) : undefined;
}

async function fetchEventsPage(
  owner: string,
  repo: string,
  page: number,
  token: string,
): Promise<{ events: GithubIssueEvent[]; lastPage: number | undefined }> {
  const url = `${API_BASE}/repos/${owner}/${repo}/issues/events?per_page=${PER_PAGE}&page=${page}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok)
  {
    throw new Error(`GitHub API error fetching issue events (page ${page}): ${response.status} ${response.statusText}`);
  }
  const events = (await response.json()) as GithubIssueEvent[];
  const lastPage = extractLastPage(response.headers.get('link'));
  return { events, lastPage };
}

// Repo-wide, incremental walk of /issues/events — a single bulk paginated
// feed that covers both issues and PRs (every PR is an issue under the
// hood), rather than one call per issue or a separate PR-only fetch.
export async function walkNewEvents(
  owner: string,
  repo: string,
  token: string,
  lastEventId: number,
): Promise<GithubIssueEvent[]> {
  const first = await fetchEventsPage(owner, repo, 1, token);
  const lastPage = first.lastPage ?? 1;

  if (lastPage === 1)
  {
    return first.events.filter((event) => event.id > lastEventId);
  }

  const collected: GithubIssueEvent[] = [];
  for (let page = lastPage; page >= 1; page -= 1)
  {
    const { events } = await fetchEventsPage(owner, repo, page, token);
    const newEvents = events.filter((event) => event.id > lastEventId);
    collected.push(...newEvents);
    if (newEvents.length === 0)
    {
      break;
    }
  }
  return collected.sort((a, b) => a.id - b.id);
}

function isBot(user: GithubUser): boolean {
  return user.type === 'Bot';
}

export function applyEvent(cache: CacheFile, event: GithubIssueEvent): void {
  const key = String(event.issue.number);
  const isPr = event.issue.pull_request !== undefined;
  const existing = cache.entries[key];

  const entry: CacheEntry = existing ?? {
    kind: isPr ? 'pr' : 'issue',
    title: event.issue.title,
    login: event.issue.user.login,
    bot: isBot(event.issue.user),
    labels: event.issue.labels.map((label) => label.name),
  };

  switch (event.event)
  {
    case 'closed':
      if (!isPr && event.commit_id)
      {
        entry.sha = event.commit_id;
      }
      break;
    case 'merged':
      if (isPr && event.commit_id)
      {
        entry.sha = event.commit_id;
      }
      break;
    case 'reopened':
      delete entry.sha;
      break;
    case 'labeled':
    case 'unlabeled':
      entry.labels = event.issue.labels.map((label) => label.name);
      break;
    case 'renamed':
      entry.title = event.rename?.to ?? entry.title;
      break;
    default:
      break;
  }

  cache.entries[key] = entry;
  cache.lastEventId = Math.max(cache.lastEventId, event.id);
}

const CLOSING_KEYWORDS = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;

function extractClosingReferences(body: string | null | undefined): number[] {
  if (!body)
  {
    return [];
  }
  return [...body.matchAll(CLOSING_KEYWORDS)].map((match) => Number(match[1]));
}

// The repo-wide /issues/events "closed" event only carries a commit_id when
// an issue is closed by a direct commit reference. An issue auto-closed by
// a merged pull request's closing keyword — the common case in a PR-driven
// repo — gets a "closed" event with commit_id: null, so without this it
// never resolves to a placeable sha and silently drops out of the
// changelog. Backfill from the merging PR's own commit_id instead.
export function applyClosingReferences(cache: CacheFile, events: GithubIssueEvent[]): void {
  for (const event of events)
  {
    const isPr = event.issue.pull_request !== undefined;
    if (event.event !== 'merged' || !isPr || !event.commit_id)
    {
      continue;
    }
    for (const closedNumber of extractClosingReferences(event.issue.body))
    {
      const closedEntry = cache.entries[String(closedNumber)];
      if (closedEntry && closedEntry.kind === 'issue' && !closedEntry.sha)
      {
        closedEntry.sha = event.commit_id;
      }
    }
  }
}

function categorize(labels: string[], options: DriverOptions): Category {
  if (labels.some((label) => options.excludeLabels.includes(label)))
  {
    return 'excluded';
  }
  if (labels.some((label) => options.enhancementLabels.includes(label)))
  {
    return 'enhancement';
  }
  if (labels.some((label) => options.bugLabels.includes(label)))
  {
    return 'bug';
  }
  return 'issue';
}

export function entriesFromCache(cache: CacheFile, options: DriverOptions): Entry[] {
  const entries: Entry[] = [];
  for (const [number, cacheEntry] of Object.entries(cache.entries))
  {
    if (!cacheEntry.sha)
    {
      continue;
    }
    const category = categorize(cacheEntry.labels, options);
    if (category === 'excluded')
    {
      continue;
    }
    entries.push({
      number: Number(number),
      kind: cacheEntry.kind,
      category,
      title: cacheEntry.title,
      login: cacheEntry.login,
      bot: cacheEntry.bot,
      sha: cacheEntry.sha,
    });
  }
  return entries;
}

export async function updateCache(
  cache: CacheFile,
  options: Pick<DriverOptions, 'owner' | 'repo' | 'token'>,
): Promise<CacheFile> {
  const events = await walkNewEvents(options.owner, options.repo, options.token, cache.lastEventId);
  for (const event of events)
  {
    applyEvent(cache, event);
  }
  applyClosingReferences(cache, events);
  return cache;
}

interface GithubPullRequestFile {
  filename: string;
}

// Not part of /issues/events or the PR object itself — a genuine extra
// per-item call, so callers should use this lazily (only for PRs a
// classification consumer actually needs), never eagerly for all history.
export async function fetchPullRequestFiles(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<string[]> {
  const filenames: string[] = [];
  for (let page = 1; ; page += 1)
  {
    const url = `${API_BASE}/repos/${owner}/${repo}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok)
    {
      throw new Error(`GitHub API error fetching PR files (${owner}/${repo}#${number}, page ${page}): ${response.status} ${response.statusText}`);
    }
    const files = (await response.json()) as GithubPullRequestFile[];
    filenames.push(...files.map((file) => file.filename));
    if (files.length < PER_PAGE)
    {
      break;
    }
  }
  return filenames;
}

export class GithubDriver implements Driver {
  private readonly cache: CacheFile;

  constructor(cache: CacheFile) {
    this.cache = cache;
  }

  async fetchEntries(options: DriverOptions): Promise<Entry[]> {
    await updateCache(this.cache, options);
    return entriesFromCache(this.cache, options);
  }
}
