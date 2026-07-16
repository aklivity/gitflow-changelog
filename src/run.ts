import { join } from 'node:path';
import { loadCache, saveCache } from './cache.js';
import { GithubDriver } from './drivers/github.js';
import { cloneOrUpdateRepo } from './git.js';
import { readDependencySet, readModuleArtifactIds } from './maven.js';
import { EMPTY_OVERRIDES, loadOverrides } from './overrides.js';
import { place } from './placement.js';
import type { FoldInsByBucket } from './render/default.js';
import { render } from './render/default.js';
import { resolveHashes } from './resolve.js';
import { loadRepoConfig } from './repo-config.js';
import type { FoldInSection } from './upstream.js';
import { computeFoldIn } from './upstream.js';
import type { DriverOptions, UpstreamConfig } from './types.js';

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
// tag pattern and label categorization stay owned by that repo, same as any
// direct run against it would use.
async function computeUpstreamFoldIn(
  upstream: UpstreamConfig,
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
  await saveCache(upstreamCachePath, upstreamCache);

  const { resolved: upstreamResolved } = await resolveHashes(
    { entries: upstreamEntries, overrides: EMPTY_OVERRIDES, ref: 'HEAD' },
    { cwd: upstreamDir },
  );

  const dependencySet = upstream.classification === 'maven'
    ? await readDependencySet(options.gitDir, upstream['maven-group-id'] ?? `io.aklivity.${upstreamRepo}`)
    : undefined;
  const moduleArtifactIds = upstream.classification === 'maven'
    ? await readModuleArtifactIds(upstreamDir)
    : undefined;

  return await computeFoldIn({
    upstream,
    placement: ownPlacement,
    upstreamEntries: upstreamResolved,
    upstreamTagPattern: new RegExp(upstreamFileConfig['tag-pattern'] || '.*'),
    upstreamGitOptions: { cwd: upstreamDir },
    headRef: options.ref,
    gitDir: options.gitDir,
    gitOptions: { cwd: options.gitDir },
    dependencySet,
    moduleArtifactIds,
    token: options.token,
  });
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
    { entries, overrides, ref: options.ref },
    { cwd: options.gitDir },
  );

  const placement = await place(
    { entries: resolved, ref: options.ref, tagPattern: options.tagPattern },
    { cwd: options.gitDir },
  );
  placement.unresolved = unresolved;

  const foldIns: FoldInsByBucket = new Map();
  for (const upstream of options.upstream)
  {
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
