import { fetchPullRequestFiles } from './drivers/github.js';
import type { GitOptions, TagInfo } from './git.js';
import { filesChangedInCommit, isAncestor, listTags, showFile, tagsContaining } from './git.js';
import { classifyPaths, DEFAULT_CLASSIFICATION_PATTERNS, featurePathsFromModules } from './classification.js';
import type { ClassificationPatterns } from './classification.js';
import type { MavenModule } from './maven.js';
import { readDependencyVersion, resolveModule } from './maven.js';
import type { ClassificationLevel, Entry, ExplicitUpstreamConfig, PlacementResult, Tag } from './types.js';

export interface VersionRange {
  bucketTag: string | null;
  fromVersion: string | undefined;
  toVersion: string;
}

// Reads the dependency-pinned version at a specific ref (a past release tag,
// or the current ref for the Unreleased bucket) — undefined if the file or
// property didn't exist yet at that point in history.
export async function readVersionAtRef(
  ref: string,
  file: string,
  property: string,
  gitOptions: GitOptions,
): Promise<string | undefined> {
  const pomXml = await showFile(ref, file, gitOptions);
  return pomXml === undefined ? undefined : readDependencyVersion(pomXml, property);
}

// Pairs every candidate bucket — Unreleased (headRef) plus every sectioned
// tag in allTags — with the dependency version pinned at that point vs. the
// version pinned at the tag immediately before it. Every tag is a
// candidate, not just tags that happen to have a native bucket already: a
// release with zero native entries can still have absorbed upstream
// content worth its own heading, so version-range computation must not be
// gated on native-entry presence. A range where nothing actually changed
// (fromVersion === toVersion) is dropped here rather than left for callers
// to filter — it isn't a range at all. Computed fresh per release tag
// rather than once off current HEAD, so a later dependency change never
// retroactively reclassifies an already-published historical release.
export async function computeVersionRanges(
  placement: PlacementResult,
  headRef: string,
  file: string,
  property: string,
  gitOptions: GitOptions,
): Promise<VersionRange[]> {
  const candidates: Array<{ bucketTag: string | null; ref: string; previousTag: Tag | undefined }> = [
    { bucketTag: null, ref: headRef, previousTag: placement.allTags[0] },
    ...placement.allTags.map((tag, index) => ({
      bucketTag: tag.name,
      ref: tag.name,
      previousTag: placement.allTags[index + 1],
    })),
  ];

  const ranges: VersionRange[] = [];
  for (const candidate of candidates)
  {
    const toVersion = await readVersionAtRef(candidate.ref, file, property, gitOptions);
    if (toVersion === undefined)
    {
      continue;
    }

    const fromVersion = candidate.previousTag
      ? await readVersionAtRef(candidate.previousTag.name, file, property, gitOptions)
      : undefined;
    if (fromVersion === toVersion)
    {
      continue;
    }

    ranges.push({ bucketTag: candidate.bucketTag, fromVersion, toVersion });
  }
  return ranges;
}

export interface UpstreamPlacement {
  // Every upstream tag, oldest first — no pattern or reachability filtering
  // (see placeUpstreamGlobally for why).
  tagsByDateAsc: TagInfo[];
  // Keyed by tag name: the entries first shipped in that tag (the earliest
  // tag, by date, whose history contains the entry's commit).
  entriesByTag: Map<string, Entry[]>;
}

// Places every upstream entry exactly once per run, globally — not once per
// consumer version range. This intentionally skips both filters place() (see
// placement.ts) applies for a repo's own rendered changelog:
//
// - No tag-pattern restriction: place()'s tagPattern decides which tags earn
//   their own heading in a *rendered* changelog. This structure is never
//   rendered directly — it's purely a lookup table for slicing fold-in
//   ranges — so there's no reason to exclude any tag as a candidate
//   boundary. A consumer's pinned dependency version (e.g. an upstream
//   alpha/rc build like "2.0.0-alpha-22") has no obligation to satisfy
//   upstream's own rendering pattern, and now doesn't need to.
// - No ref-reachability restriction: place() also scopes tags to
//   `reachableFrom(ref)`, which is what excludes a commit-only-on-a-
//   maintenance-branch backport unless placement is specifically re-scoped
//   to that branch's tag (the bug fixed by fold-in placement scoping to the
//   pinned tag itself, historically). `git tag --contains <sha>` is already
//   branch-agnostic — it answers "is this commit an ancestor of that tag,
//   on any line of history" — so picking the globally-earliest-by-date
//   containing tag for each entry already finds cross-branch content
//   correctly, with no per-branch or per-pinned-tag rescoping needed.
//
// Cost is O(upstream entries) — one `tagsContaining` call per entry — for
// the whole run, computed once and reused for every consumer version range,
// instead of a fresh full placement (or a fresh per-entry ancestry check)
// for every single range.
export async function placeUpstreamGlobally(entries: Entry[], gitOptions: GitOptions): Promise<UpstreamPlacement> {
  const tagsByDateAsc = (await listTags(/.*/, gitOptions)).sort((a, b) => a.date.localeCompare(b.date));

  const entriesByTag = new Map<string, Entry[]>();
  for (const entry of entries)
  {
    const containing = new Set(await tagsContaining(entry.sha, gitOptions));
    const firstTag = tagsByDateAsc.find((tag) => containing.has(tag.name));
    if (firstTag === undefined)
    {
      continue;
    }
    const bucket = entriesByTag.get(firstTag.name) ?? [];
    bucket.push(entry);
    entriesByTag.set(firstTag.name, bucket);
  }

  return { tagsByDateAsc, entriesByTag };
}

// Slices the entries strictly after fromVersion (exclusive) and up to and
// including toVersion out of an already-computed UpstreamPlacement.
// Newest-tag-first within the range, matching the order a rendered fold-in
// section expects.
//
// §36: date order between fromVersion and toVersion is only a candidate
// pre-filter, not sufficient on its own — an upstream that tags two
// parallel lines of history (e.g. a maintenance branch and its main
// development line) can interleave those tags' dates arbitrarily, so a
// pure date-window walk bleeds in tags (and their entries) from a branch
// this range has nothing to do with. A candidate tag only really belongs
// in (fromVersion, toVersion] when its commit is an ancestor of
// toVersion's commit and not an ancestor of fromVersion's commit — the
// same ancestry check already used elsewhere, applied here per candidate
// tag rather than per entry, so cost stays bounded by the number of tags
// between two dates, not the number of entries.
export async function selectEntriesInRange(
  placement: UpstreamPlacement,
  fromVersion: string | undefined,
  toVersion: string,
  gitOptions: GitOptions,
): Promise<Entry[]> {
  const toIndex = placement.tagsByDateAsc.findIndex((tag) => tag.name === toVersion);
  if (toIndex === -1)
  {
    return [];
  }
  const toTag = placement.tagsByDateAsc[toIndex];
  const fromIndex = fromVersion ? placement.tagsByDateAsc.findIndex((tag) => tag.name === fromVersion) : -1;
  const fromTag = fromIndex !== -1 ? placement.tagsByDateAsc[fromIndex] : undefined;

  const entries: Entry[] = [];
  for (let index = toIndex; index > fromIndex; index -= 1)
  {
    const candidate = placement.tagsByDateAsc[index];
    if (!(await isAncestor(candidate.sha, toTag.sha, gitOptions)))
    {
      continue;
    }
    if (fromTag && (await isAncestor(candidate.sha, fromTag.sha, gitOptions)))
    {
      continue;
    }
    entries.push(...(placement.entriesByTag.get(candidate.name) ?? []));
  }
  return entries;
}

export interface FoldInFilterOptions {
  level: ClassificationLevel;
  owner: string;
  repo: string;
  token: string;
  patterns?: ClassificationPatterns;
  // Already the full transitive closure — see expandTransitiveDependencySet
  // in maven.ts. Callers compute this once per run, not per entry.
  dependencySet?: Set<string>;
  modules?: MavenModule[];
  // Keyed by PR number, shared with the caller (mutated in place) so a
  // fetched file list survives beyond this call — a merged PR's files never
  // change, so once fetched a number never needs fetching again.
  prFilesCache?: Record<string, string[]>;
  // The upstream's own local clone — used to resolve an issue-kind entry's
  // file list via filesChangedInCommit when its sha doesn't match any
  // fetched PR's merge commit (see the comment on filterForFoldIn below).
  gitOptions: GitOptions;
}

const FETCH_CONCURRENCY = 8;

// Runs `fn` over `items` with at most `limit` calls in flight at once,
// preserving no particular order beyond "every item gets processed" — the
// caller only needs completion, not a returned array, so this is void.
async function forEachWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length)
    {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Resolves every PR's file list once, before any classification logic runs —
// cache hits are free, cache misses are fetched with bounded concurrency
// instead of one-at-a-time. Separated from filterForFoldIn so the
// classification pass below stays a plain synchronous loop.
async function resolvePullRequestFiles(
  pullRequests: Entry[],
  options: FoldInFilterOptions,
): Promise<Map<number, string[]>> {
  const resolved = new Map<number, string[]>();
  const toFetch: Entry[] = [];
  for (const entry of pullRequests)
  {
    const cached = options.prFilesCache?.[String(entry.number)];
    if (cached)
    {
      resolved.set(entry.number, cached);
    }
    else
    {
      toFetch.push(entry);
    }
  }

  await forEachWithConcurrency(toFetch, FETCH_CONCURRENCY, async (entry) => {
    const paths = await fetchPullRequestFiles(options.owner, options.repo, entry.number, options.token);
    resolved.set(entry.number, paths);
    if (options.prFilesCache)
    {
      options.prFilesCache[String(entry.number)] = paths;
    }
  });

  return resolved;
}

// An issue-kind entry has no file list of its own from the GitHub API, but
// by the time it reaches this function it always carries a resolved `sha`
// (resolveHashes drops anything that doesn't resolve to a real commit) —
// either its own direct closing commit, or, in the common "auto-closed by a
// merged PR" case, that PR's merge commit (backfilled by
// applyClosingReferences in drivers/github.ts). So an issue can be
// classified exactly like a PR: reuse the matching PR's already-fetched file
// list when its sha lines up with one in this same entry set (free — no
// extra fetch), otherwise fall back to a local `git diff` against the
// upstream clone for that specific commit.
async function resolveIssuePaths(
  issues: Entry[],
  pullRequests: Entry[],
  pathsByNumber: Map<number, string[]>,
  options: FoldInFilterOptions,
): Promise<Map<number, string[]>> {
  const prNumberBySha = new Map<string, number>();
  for (const pr of pullRequests)
  {
    prNumberBySha.set(pr.sha, pr.number);
  }

  const resolved = new Map<number, string[]>();
  await forEachWithConcurrency(issues, FETCH_CONCURRENCY, async (issue) => {
    const matchingPrNumber = prNumberBySha.get(issue.sha);
    const paths = matchingPrNumber !== undefined
      ? (pathsByNumber.get(matchingPrNumber) ?? [])
      : await filesChangedInCommit(issue.sha, options.gitOptions);
    resolved.set(issue.number, paths);
  });
  return resolved;
}

export async function filterForFoldIn(entries: Entry[], options: FoldInFilterOptions): Promise<Entry[]> {
  if (options.level === 'none')
  {
    return entries;
  }

  const pullRequests = entries.filter((entry) => entry.kind === 'pr');
  const issues = entries.filter((entry) => entry.kind === 'issue');
  const pathsByNumber = await resolvePullRequestFiles(pullRequests, options);
  const issuePathsByNumber = await resolveIssuePaths(issues, pullRequests, pathsByNumber, options);

  // An explicit override always wins. Otherwise, whenever a Maven module
  // index is available (any 'maven'-classified upstream) it's strictly more
  // precise than the hardcoded default — derived from the upstream's own
  // pom.xml layout instead of a guessed directory convention — so prefer
  // it; fall back to the hardcoded default only when there's no module
  // index at all (a 'path'-level or non-Maven upstream).
  const patterns = options.patterns
    ?? (options.modules ? { featurePaths: featurePathsFromModules(options.modules), testPaths: DEFAULT_CLASSIFICATION_PATTERNS.testPaths } : DEFAULT_CLASSIFICATION_PATTERNS);

  const filtered: Entry[] = [];
  for (const entry of entries)
  {
    const paths = entry.kind === 'pr' ? (pathsByNumber.get(entry.number) ?? []) : (issuePathsByNumber.get(entry.number) ?? []);
    const classification = classifyPaths(paths, patterns);
    if (classification !== 'feature')
    {
      continue;
    }

    if (options.level === 'path')
    {
      filtered.push(entry);
      continue;
    }

    const touchesDependency = paths.some((path) => {
      const module = options.modules ? resolveModule(path, options.modules) : undefined;
      return module !== undefined && (options.dependencySet?.has(module.artifactId) ?? false);
    });
    if (touchesDependency)
    {
      filtered.push(entry);
    }
  }
  return filtered;
}

export interface FoldInSection {
  repo: string;
  fromVersion: string | undefined;
  toVersion: string;
  entries: Entry[];
}

export interface ComputeFoldInOptions {
  upstream: ExplicitUpstreamConfig;
  placement: PlacementResult;
  upstreamEntries: Entry[];
  upstreamGitOptions: GitOptions;
  headRef: string;
  gitDir: string;
  gitOptions: GitOptions;
  dependencySet?: Set<string>;
  modules?: MavenModule[];
  token: string;
  patterns?: ClassificationPatterns;
  prFilesCache?: Record<string, string[]>;
}

// Ties the pieces together for one upstream source: a FoldInSection per
// bucket of this repo's own placement that has a version range to report,
// keyed by that bucket's tag name (or null for Unreleased).
export async function computeFoldIn(options: ComputeFoldInOptions): Promise<Map<string | null, FoldInSection>> {
  const [upstreamOwner, upstreamRepo] = options.upstream.repo.split('/');
  const ranges = await computeVersionRanges(
    options.placement,
    options.headRef,
    options.upstream['dependency-version-file'],
    options.upstream['dependency-version-property'],
    options.gitOptions,
  );

  const sections = new Map<string | null, FoldInSection>();
  if (ranges.length === 0)
  {
    return sections;
  }

  const upstreamPlacement = await placeUpstreamGlobally(options.upstreamEntries, options.upstreamGitOptions);

  for (const range of ranges)
  {
    const candidates = await selectEntriesInRange(upstreamPlacement, range.fromVersion, range.toVersion, options.upstreamGitOptions);
    const entries = await filterForFoldIn(candidates, {
      level: options.upstream.classification,
      owner: upstreamOwner,
      repo: upstreamRepo,
      token: options.token,
      patterns: options.patterns,
      dependencySet: options.dependencySet,
      modules: options.modules,
      prFilesCache: options.prFilesCache,
      gitOptions: options.upstreamGitOptions,
    });
    if (entries.length > 0)
    {
      sections.set(range.bucketTag, {
        repo: options.upstream.repo,
        fromVersion: range.fromVersion,
        toVersion: range.toVersion,
        entries,
      });
    }
  }
  return sections;
}
