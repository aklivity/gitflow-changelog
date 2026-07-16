import { fetchPullRequestFiles } from './drivers/github.js';
import type { GitOptions, TagInfo } from './git.js';
import { listTags, showFile, tagsContaining } from './git.js';
import { classifyPaths, DEFAULT_CLASSIFICATION_PATTERNS } from './classification.js';
import type { ClassificationPatterns } from './classification.js';
import { moduleDirFromPath, readDependencyVersion } from './maven.js';
import type { ClassificationLevel, Entry, PlacementResult, Tag, UpstreamConfig } from './types.js';

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
// including toVersion out of an already-computed UpstreamPlacement — pure
// index arithmetic against the precomputed tag/entry map, no git calls.
// Newest-tag-first within the range, matching the order a rendered fold-in
// section expects.
export function selectEntriesInRange(
  placement: UpstreamPlacement,
  fromVersion: string | undefined,
  toVersion: string,
): Entry[] {
  const toIndex = placement.tagsByDateAsc.findIndex((tag) => tag.name === toVersion);
  if (toIndex === -1)
  {
    return [];
  }
  const fromIndex = fromVersion ? placement.tagsByDateAsc.findIndex((tag) => tag.name === fromVersion) : -1;

  const entries: Entry[] = [];
  for (let index = toIndex; index > fromIndex; index -= 1)
  {
    entries.push(...(placement.entriesByTag.get(placement.tagsByDateAsc[index].name) ?? []));
  }
  return entries;
}

export interface FoldInFilterOptions {
  level: ClassificationLevel;
  owner: string;
  repo: string;
  token: string;
  patterns?: ClassificationPatterns;
  dependencySet?: Set<string>;
  moduleArtifactIds?: Map<string, string>;
  // Keyed by PR number, shared with the caller (mutated in place) so a
  // fetched file list survives beyond this call — a merged PR's files never
  // change, so once fetched a number never needs fetching again.
  prFilesCache?: Record<string, string[]>;
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

// Only pull requests carry a diff to classify — issues have no file list
// of their own, so `none`/`path`/`maven` filtering only ever drops or
// keeps PR-kind entries; issue-kind entries are outside this feature's
// scope entirely (a changelog fold-in is about absorbed *code*, and an
// issue by itself never represents shipped code).
export async function filterForFoldIn(entries: Entry[], options: FoldInFilterOptions): Promise<Entry[]> {
  const pullRequests = entries.filter((entry) => entry.kind === 'pr');
  if (options.level === 'none')
  {
    return pullRequests;
  }

  const pathsByNumber = await resolvePullRequestFiles(pullRequests, options);

  const filtered: Entry[] = [];
  for (const entry of pullRequests)
  {
    const paths = pathsByNumber.get(entry.number) ?? [];
    const classification = classifyPaths(paths, options.patterns ?? DEFAULT_CLASSIFICATION_PATTERNS);
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
      const moduleDir = moduleDirFromPath(path);
      const artifactId = moduleDir ? options.moduleArtifactIds?.get(moduleDir) : undefined;
      return artifactId !== undefined && (options.dependencySet?.has(artifactId) ?? false);
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
  upstream: UpstreamConfig;
  placement: PlacementResult;
  upstreamEntries: Entry[];
  upstreamGitOptions: GitOptions;
  headRef: string;
  gitDir: string;
  gitOptions: GitOptions;
  dependencySet?: Set<string>;
  moduleArtifactIds?: Map<string, string>;
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
    const candidates = selectEntriesInRange(upstreamPlacement, range.fromVersion, range.toVersion);
    const entries = await filterForFoldIn(candidates, {
      level: options.upstream.classification,
      owner: upstreamOwner,
      repo: upstreamRepo,
      token: options.token,
      patterns: options.patterns,
      dependencySet: options.dependencySet,
      moduleArtifactIds: options.moduleArtifactIds,
      prFilesCache: options.prFilesCache,
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
