import { fetchPullRequestFiles } from './drivers/github.js';
import type { GitOptions } from './git.js';
import { showFile } from './git.js';
import { classifyPaths, DEFAULT_CLASSIFICATION_PATTERNS } from './classification.js';
import type { ClassificationPatterns } from './classification.js';
import { moduleDirFromPath, readDependencyVersion } from './maven.js';
import type { ClassificationLevel, Entry, PlacementResult, UpstreamConfig } from './types.js';

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

// Pairs each of this repo's own placement buckets with the dependency
// version pinned at that point vs. the version pinned at the tag
// immediately before it — using the full allTags sequence, not the
// (possibly sparser) buckets list, so a tag with no entries of its own
// still counts as a valid boundary. Computed fresh per release tag rather
// than once off current HEAD, so a later dependency change never
// retroactively reclassifies an already-published historical release.
export async function computeVersionRanges(
  placement: PlacementResult,
  headRef: string,
  file: string,
  property: string,
  gitOptions: GitOptions,
): Promise<VersionRange[]> {
  const ranges: VersionRange[] = [];
  for (const bucket of placement.buckets)
  {
    const ref = bucket.tag?.name ?? headRef;
    const toVersion = await readVersionAtRef(ref, file, property, gitOptions);
    if (toVersion === undefined)
    {
      continue;
    }

    const tagIndex = bucket.tag ? placement.allTags.findIndex((tag) => tag.name === bucket.tag?.name) : -1;
    const previousTag = bucket.tag ? placement.allTags[tagIndex + 1] : placement.allTags[0];
    const fromVersion = previousTag ? await readVersionAtRef(previousTag.name, file, property, gitOptions) : undefined;

    ranges.push({ bucketTag: bucket.tag?.name ?? null, fromVersion, toVersion });
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

  const filtered: Entry[] = [];
  for (const entry of pullRequests)
  {
    const paths = await fetchPullRequestFiles(options.owner, options.repo, entry.number, options.token);
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
  upstreamPlacement: PlacementResult;
  headRef: string;
  gitDir: string;
  gitOptions: GitOptions;
  dependencySet?: Set<string>;
  moduleArtifactIds?: Map<string, string>;
  token: string;
  patterns?: ClassificationPatterns;
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
  for (const range of ranges)
  {
    if (range.fromVersion === range.toVersion)
    {
      continue;
    }
    const candidates = selectUpstreamEntries(options.upstreamPlacement, range.fromVersion, range.toVersion);
    const entries = await filterForFoldIn(candidates, {
      level: options.upstream.classification,
      owner: upstreamOwner,
      repo: upstreamRepo,
      token: options.token,
      patterns: options.patterns,
      dependencySet: options.dependencySet,
      moduleArtifactIds: options.moduleArtifactIds,
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
