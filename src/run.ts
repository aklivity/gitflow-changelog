import { join } from 'node:path';
import { loadCache, saveCache } from './cache.js';
import { resolveUpstreamConfig } from './discover-upstream.js';
import { GithubDriver } from './drivers/github.js';
import { cloneOrUpdateRepo } from './git.js';
import { expandTransitiveDependencySet, indexMavenModules, readDependencySet } from './maven.js';
import { EMPTY_OVERRIDES, loadOverrides } from './overrides.js';
import { place } from './placement.js';
import type { FoldInsByBucket } from './render/default.js';
import { render } from './render/default.js';
import { resolveHashes } from './resolve.js';
import { loadRepoConfig } from './repo-config.js';
import type { FoldInSection } from './upstream.js';
import { computeFoldIn } from './upstream.js';
import type { DriverOptions, ExplicitUpstreamConfig, UpstreamConfig } from './types.js';

export interface RunOptions {
  owner: string;
  repo: string;
  token: string;
  ref: string;
  gitDir: string;
  cachePath: string;
  overridesPath?: string;
  tagPattern: RegExp;
  enhancementLabels: string[];
  bugLabels: string[];
  excludeLabels: string[];
  format: string;
  upstream: UpstreamConfig[];
  upstreamCacheDir: string;
}

export interface RunResult {
  markdown: string;
  warnings: string[];
}

const RENDERERS: Record<string, typeof render> = {
  default: render,
};

function addFoldIn(byBucket: FoldInsByBucket, bucketTag: string | null, section: FoldInSection): void {
  const sections = byBucket.get(bucketTag) ?? [];
  sections.push(section);
  byBucket.set(bucketTag, sections);
}

// computeVersionRanges evaluates every tag in allTags, not just tags that
// already have a native bucket, so a release with zero native entries can
// still absorb qualifying upstream content. placement.buckets omits such a
// release entirely — this fills in an empty Bucket for any tag foldIns has
// content for, in the same newest-first order as allTags, so render() has
// something to attach the heading and fold-in note to.
function withFoldInOnlyBuckets(placement: Awaited<ReturnType<typeof place>>, foldIns: FoldInsByBucket): Awaited<ReturnType<typeof place>> {
  const nativeByTag = new Map(placement.buckets.map((bucket) => [bucket.tag?.name ?? null, bucket]));
  const buckets = [];

  if (nativeByTag.has(null) || foldIns.has(null))
  {
    buckets.push(nativeByTag.get(null) ?? { tag: null, entries: [] });
  }
  for (const tag of placement.allTags)
  {
    const native = nativeByTag.get(tag.name);
    if (native)
    {
      buckets.push(native);
    }
    else if (foldIns.has(tag.name))
    {
      buckets.push({ tag, entries: [] });
    }
  }

  return { ...placement, buckets };
}

// Fold-in needs the upstream repo's own full git history (tags + ancestry),
// not just what the GitHub API returns — the consuming repo's checkout
// (options.gitDir) has none of that. The clone lives under
// options.upstreamCacheDir rather than a throwaway temp dir, and
// cloneOrUpdateRepo fetches instead of re-cloning once it's there — the
// point of a stable path is that a caller can persist it across runs (e.g.
// via actions/cache) so a full history transfer only happens once, not on
// every single run. Reads the upstream's own .gitflow-changelog.yml so its
// label categorization stays owned by that repo, same as any direct run
// against it would use — fold-in itself places upstream entries globally,
// unscoped by any tag pattern (see placeUpstreamGlobally in upstream.ts).
async function computeUpstreamFoldIn(
  upstream: ExplicitUpstreamConfig,
  ownPlacement: Awaited<ReturnType<typeof place>>,
  options: RunOptions,
): Promise<Map<string | null, FoldInSection>> {
  const [upstreamOwner, upstreamRepo] = upstream.repo.split('/');
  const upstreamDir = join(options.upstreamCacheDir, `${upstreamOwner}-${upstreamRepo}`);

  await cloneOrUpdateRepo(upstreamOwner, upstreamRepo, upstreamDir, options.token);

  const upstreamFileConfig = await loadRepoConfig(upstreamDir, '.gitflow-changelog.yml');
  const upstreamCachePath = `${options.cachePath}.upstream-${upstreamOwner}-${upstreamRepo}.json`;
  const upstreamCache = await loadCache(upstreamCachePath);
  const upstreamDriverOptions: DriverOptions = {
    owner: upstreamOwner,
    repo: upstreamRepo,
    token: options.token,
    enhancementLabels: upstreamFileConfig['enhancement-labels'] ?? ['enhancement'],
    bugLabels: upstreamFileConfig['bug-labels'] ?? ['bug'],
    excludeLabels: upstreamFileConfig['exclude-labels'] ?? ['duplicate', 'invalid', 'wontfix'],
  };

  const upstreamDriver = new GithubDriver(upstreamCache);
  const upstreamEntries = await upstreamDriver.fetchEntries(upstreamDriverOptions);

  const { resolved: upstreamResolved } = await resolveHashes(
    { entries: upstreamEntries, overrides: EMPTY_OVERRIDES, ref: 'HEAD', hashFallbackCache: upstreamCache.hashFallbacks },
    { cwd: upstreamDir },
  );

  const groupId = upstream['maven-group-id'] ?? `io.aklivity.${upstreamRepo}`;
  const modules = upstream.classification === 'maven'
    ? await indexMavenModules(upstreamDir, groupId)
    : undefined;
  const directDependencySet = upstream.classification === 'maven'
    ? await readDependencySet(options.gitDir, groupId)
    : undefined;
  // Expanded here, once per upstream per run, rather than inside
  // filterForFoldIn per entry — the upstream's own module graph doesn't
  // change within a single run, so there's no reason to re-walk it per PR.
  const dependencySet = directDependencySet && modules
    ? expandTransitiveDependencySet(directDependencySet, modules)
    : directDependencySet;

  const sections = await computeFoldIn({
    upstream,
    placement: ownPlacement,
    upstreamEntries: upstreamResolved,
    upstreamGitOptions: { cwd: upstreamDir },
    headRef: options.ref,
    gitDir: options.gitDir,
    gitOptions: { cwd: options.gitDir },
    dependencySet,
    modules,
    prFilesCache: upstreamCache.prFiles,
    token: options.token,
  });

  // Saved after computeFoldIn, not right after fetchEntries — filterForFoldIn
  // mutates upstreamCache.prFiles in place as it fetches, and those newly
  // cached file lists need to make it into the persisted cache too.
  await saveCache(upstreamCachePath, upstreamCache);
  return sections;
}

export async function run(options: RunOptions): Promise<RunResult> {
  const renderer = RENDERERS[options.format];
  if (!renderer)
  {
    throw new Error(`Unknown format "${options.format}"; supported formats: ${Object.keys(RENDERERS).join(', ')}`);
  }

  const cache = await loadCache(options.cachePath);
  const driverOptions: DriverOptions = {
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    enhancementLabels: options.enhancementLabels,
    bugLabels: options.bugLabels,
    excludeLabels: options.excludeLabels,
  };

  const driver = new GithubDriver(cache);
  const entries = await driver.fetchEntries(driverOptions);
  await saveCache(options.cachePath, cache);

  const overrides = await loadOverrides(options.overridesPath);
  const { resolved, unresolved, warnings } = await resolveHashes(
    { entries, overrides, ref: options.ref, hashFallbackCache: cache.hashFallbacks },
    { cwd: options.gitDir },
  );

  // Re-saved here (in addition to the earlier save right after
  // fetchEntries) because resolveHashes mutates cache.hashFallbacks in
  // place as it discovers history-rewrite substitutions — those need to
  // reach disk too, not just the entries/lastEventId snapshot taken before
  // resolution ran.
  await saveCache(options.cachePath, cache);

  const placement = await place(
    { entries: resolved, ref: options.ref, tagPattern: options.tagPattern },
    { cwd: options.gitDir },
  );
  placement.unresolved = unresolved;

  const foldIns: FoldInsByBucket = new Map();
  for (const upstreamConfig of options.upstream)
  {
    const { config: upstream, warning } = await resolveUpstreamConfig(upstreamConfig, options.gitDir);
    if (warning !== undefined)
    {
      warnings.push(warning);
    }
    if (upstream === undefined)
    {
      continue;
    }

    const sections = await computeUpstreamFoldIn(upstream, placement, options);
    for (const [bucketTag, section] of sections)
    {
      addFoldIn(foldIns, bucketTag, section);
    }
  }

  const renderPlacement = withFoldInOnlyBuckets(placement, foldIns);
  const markdown = renderer(renderPlacement, { owner: options.owner, repo: options.repo }, foldIns);

  return { markdown, warnings };
}
