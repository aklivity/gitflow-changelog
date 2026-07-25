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

function collectNew(
  events: GithubIssueEvent[],
  lastEventId: number,
  seen: Set<number>,
  collected: GithubIssueEvent[],
): boolean {
  let addedAny = false;
  for (const event of events)
  {
    if (event.id > lastEventId && !seen.has(event.id))
    {
      seen.add(event.id);
      collected.push(event);
      addedAny = true;
    }
  }
  return addedAny;
}

// Walks pages `from` down to `downTo` (inclusive), newest-first, stopping
// early the first time a page yields nothing new — new events are always
// clustered near the end, so this avoids re-walking a large repo's entire
// history every run. `ceiling` tracks the highest page number known to
// exist; every fetched page's own Link header is re-checked against it, and
// if a page reports a HIGHER total than `ceiling.value`, the newly-revealed
// range is walked first (newest-first, same stopping rule, recursively) —
// covering an event that landed anywhere during this walk, not only one
// present before it started — before this call's own remaining pages
// continue from where they were.
//
// This is what a naive "compute the last page once, from the very first
// request, then walk that fixed range" version gets wrong on a live repo:
// if any new event lands between that first request and a later one in the
// same walk, the true last page grows, page boundaries shift, and whatever
// falls in the newly-revealed range is silently never fetched at any page
// number — see aklivity/zilla-plus#1073/#1075, both squash-merged within
// the same rough window of activity as a release run that missed them
// entirely, with no error or warning anywhere.
async function walkRange(
  owner: string,
  repo: string,
  token: string,
  lastEventId: number,
  from: number,
  downTo: number,
  ceiling: { value: number },
  seen: Set<number>,
  collected: GithubIssueEvent[],
): Promise<void> {
  for (let page = from; page >= downTo; page -= 1)
  {
    const { events, lastPage } = await fetchEventsPage(owner, repo, page, token);
    if (lastPage !== undefined && lastPage > ceiling.value)
    {
      const revealedFrom = lastPage;
      const revealedDownTo = ceiling.value + 1;
      ceiling.value = lastPage;
      await walkRange(owner, repo, token, lastEventId, revealedFrom, revealedDownTo, ceiling, seen, collected);
    }
    if (!collectNew(events, lastEventId, seen, collected))
    {
      return;
    }
  }
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
  const seen = new Set<number>();
  const collected: GithubIssueEvent[] = [];

  const first = await fetchEventsPage(owner, repo, 1, token);
  const ceiling = { value: first.lastPage ?? 1 };
  collectNew(first.events, lastEventId, seen, collected);

  if (ceiling.value > 1)
  {
    await walkRange(owner, repo, token, lastEventId, ceiling.value, 2, ceiling, seen, collected);
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

// Same event-sourced label state entriesFromCache reads, but answering a
// different question: not "how should this entry be categorized" (which
// only ever runs against this repo's own enhancement/bug/exclude labels),
// but "which commits, wherever they came from, are labeled in a way that
// says they don't need to go anywhere else" — merge-report's use case,
// where the label check has to run before any category is assigned and
// doesn't care about enhancement vs. bug. Keyed by sha, not issue/PR
// number, since that's what a `git cherry` candidate is identified by.
export function excludedShas(cache: CacheFile, excludeLabels: string[]): Set<string> {
  const shas = new Set<string>();
  for (const entry of Object.values(cache.entries))
  {
    if (entry.sha && entry.labels.some((label) => excludeLabels.includes(label)))
    {
      shas.add(entry.sha);
    }
  }
  return shas;
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

// Thrown by fetchDefaultBranch/fetchPullRequestBaseRef/findSquashMergePr
// instead of returning undefined, so callers (resolve.ts's squash-merge
// fallback tier) can tell "GitHub says this genuinely doesn't exist" apart
// from "we're rate-limited and have no idea" — treating the two the same
// would silently drop resolvable entries with a misleading "no candidate
// commit references it" warning for the rest of a rate-limited run.
export class GithubRateLimitError extends Error {
  constructor(url: string) {
    super(`GitHub API rate limit hit calling ${url}`);
    this.name = 'GithubRateLimitError';
  }
}

// GitHub signals primary rate-limit exhaustion as 403 with
// X-RateLimit-Remaining: 0, and secondary (abuse-detection) rate limits as
// 403 or 429 with a Retry-After header — both distinct from an ordinary
// 403 (e.g. token lacks scope) or 404 (genuinely not found), which should
// still resolve to undefined, not this error.
function isRateLimited(response: Response): boolean {
  if (response.status === 429)
  {
    return true;
  }
  return response.status === 403
    && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after') !== null);
}

interface GithubRepo {
  default_branch: string;
}

// Used by resolve.ts's squash-merge fallback tier to know which base ref
// actually matters for the "was this feature branch squash-merged into the
// real target?" search — a squash-merge PR's base is always the repo's
// default branch, regardless of which branch (develop, support/1.x, ...) is
// currently being generated a changelog for. Not cached by the caller since
// it's fetched at most once per resolveHashes call, only when at least one
// PR entry actually needs the squash-merge tier.
export async function fetchDefaultBranch(owner: string, repo: string, token: string): Promise<string | undefined> {
  const url = `${API_BASE}/repos/${owner}/${repo}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok)
  {
    if (isRateLimited(response))
    {
      throw new GithubRateLimitError(url);
    }
    return undefined;
  }
  const data = (await response.json()) as GithubRepo;
  return data.default_branch;
}

interface GithubPullRequest {
  base: { ref: string };
}

// Not part of /issues/events — a genuine extra per-item call, used lazily
// by resolve.ts's squash-merge fallback tier only for PR entries that have
// already failed every cheaper resolution tier. A merged PR's base ref
// never changes, so callers cache the result permanently.
export async function fetchPullRequestBaseRef(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<string | undefined> {
  const url = `${API_BASE}/repos/${owner}/${repo}/pulls/${number}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok)
  {
    if (isRateLimited(response))
    {
      throw new GithubRateLimitError(url);
    }
    return undefined;
  }
  const pr = (await response.json()) as GithubPullRequest;
  return pr.base.ref;
}

interface GithubSearchIssue {
  number: number;
}

interface GithubSearchResult {
  items: GithubSearchIssue[];
}

// Resolves the "long-lived feature branch later squash-merged" case: finds
// whichever PR merged `headRef` into `baseRef` (the branch being processed,
// e.g. "develop"), so its number can be looked up in the same
// commit-message history scan already run for every other entry (see
// scanCommitsReferencingNumbers), instead of a second git operation.
// GitHub's search index retains a merged PR's head/base branch names for
// the PR's lifetime, even after the branches themselves are deleted.
//
// `base:` is required, not just `head:` — a long-lived feature branch is
// typically built via a chain of PRs merged into *itself* (same head and
// base ref) before it's finally squash-merged into the real target branch,
// so `head:<headRef>` alone can match several merged PRs sharing that head
// ref; only the one whose base is actually `baseRef` is the squash-merge.
// Confirmed against the real aklivity/zilla history: searching bare
// `head:feature/grpc-kafka` for PR #174 returns 5 merged PRs (#174, #187,
// #199, #205, #225) that all share that head ref from being merged into
// each other; adding `base:develop` narrows it to exactly #225.
export async function findSquashMergePr(
  owner: string,
  repo: string,
  headRef: string,
  baseRef: string,
  token: string,
): Promise<number | undefined> {
  const query = `repo:${owner}/${repo} type:pr is:merged head:${headRef} base:${baseRef}`;
  const url = `${API_BASE}/search/issues?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok)
  {
    if (isRateLimited(response))
    {
      throw new GithubRateLimitError(url);
    }
    return undefined;
  }
  const result = (await response.json()) as GithubSearchResult;
  return result.items[0]?.number;
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
