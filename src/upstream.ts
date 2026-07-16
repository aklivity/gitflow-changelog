import { fetchPullRequestFiles } from './drivers/github.js';
import type { GitOptions } from './git.js';
import { showFile } from './git.js';
import { classifyPaths, DEFAULT_CLASSIFICATION_PATTERNS } from './classification.js';
import type { ClassificationPatterns } from './classification.js';
import { moduleDirFromPath, readDependencyVersion } from './maven.js';
import { place } from './placement.js';
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

// Entries from the upstream repo's own placement that fall strictly after
// fromVersion (exclusive) and up to and including toVersion — found by tag
// name, not by re-deriving ancestry a second time. Assumes fromVersion and
// toVersion, when present, correspond to real tags in the upstream repo's
// own placement (true whenever a consumer only ever pins an actually
// released version, which is the normal case).
export function selectUpstreamEntries(
  upstreamPlacement: PlacementResult,
  fromVersion: string | undefined,
  toVersion: string,
): Entry[] {
  const toIndex = upstreamPlacement.buckets.findIndex((bucket) => bucket.tag?.name === toVersion);
  if (toIndex === -1)
  {
    return [];
  }
  const fromIndex = fromVersion
    ? upstreamPlacement.buckets.findIndex((bucket) => bucket.tag?.name === fromVersion)
    : upstreamPlacement.buckets.length;
  const upperBound = fromIndex === -1 ? upstreamPlacement.buckets.length : fromIndex;

  const entries: Entry[] = [];
  for (let index = toIndex; index < upperBound; index += 1)
  {
    entries.push(...upstreamPlacement.buckets[index].entries);
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
  upstreamTagPattern: RegExp;
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

// Places the upstream repo's own entries scoped to a specific pinned
// version tag, not to the upstream's default branch. A tag's own history
// already includes everything that shipped in it — including a commit that
// only ever landed on the upstream's own maintenance branch (e.g. a
// support/1.x-only backport that was never merged forward to develop) —
// so scoping ancestry to the tag itself finds that content regardless of
// which upstream branch produced it. This is the mechanism that lets a
// consumer fold in the right entries for both an upstream develop-line
// version and a later upstream support-line version without either side
// needing to know which branch the other is on. Different ranges can pin
// different upstream versions, so this is computed fresh per distinct
// toVersion rather than once for the whole run — memoized since multiple
// ranges (e.g. Unreleased and the latest tag) commonly share one.
async function placeUpstreamAt(
  ref: string,
  upstreamEntries: Entry[],
  upstreamTagPattern: RegExp,
  upstreamGitOptions: GitOptions,
  cache: Map<string, PlacementResult>,
): Promise<PlacementResult> {
  const cached = cache.get(ref);
  if (cached)
  {
    return cached;
  }
  const computed = await place({ entries: upstreamEntries, ref, tagPattern: upstreamTagPattern }, upstreamGitOptions);
  cache.set(ref, computed);
  return computed;
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

  const placementByVersion = new Map<string, PlacementResult>();
  const sections = new Map<string | null, FoldInSection>();
  for (const range of ranges)
  {
    const upstreamPlacement = await placeUpstreamAt(
      range.toVersion,
      options.upstreamEntries,
      options.upstreamTagPattern,
      options.upstreamGitOptions,
      placementByVersion,
    );
    const candidates = selectUpstreamEntries(upstreamPlacement, range.fromVersion, range.toVersion);
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
