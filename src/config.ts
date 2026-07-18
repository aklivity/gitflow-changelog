import { loadRepoConfig } from './repo-config.js';
import type { RunOptions } from './run.js';

export interface RawInputs {
  owner?: string;
  repo?: string;
  token?: string;
  ref?: string;
  gitDir?: string;
  cachePath?: string;
  overridesPath?: string;
  configPath?: string;
  upstreamCacheDir?: string;
  tagPattern?: string;
  enhancementLabels?: string;
  bugLabels?: string;
  excludeLabels?: string;
  format?: string;
}

function splitLabels(value: string | undefined, fallback: string[]): string[] {
  if (!value)
  {
    return fallback;
  }
  return value
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

export async function toRunOptions(raw: RawInputs): Promise<RunOptions> {
  if (!raw.owner || !raw.repo)
  {
    throw new Error('owner and repo are required');
  }
  if (!raw.token)
  {
    throw new Error('token is required');
  }

  const gitDir = raw.gitDir ?? process.cwd();
  const fileConfig = await loadRepoConfig(gitDir, raw.configPath ?? '.gitflow-changelog.yml');

  return {
    owner: raw.owner,
    repo: raw.repo,
    token: raw.token,
    ref: raw.ref ?? 'HEAD',
    gitDir,
    cachePath: raw.cachePath ?? '.gitflow-changelog-cache.json',
    // Auto-loaded like configPath's own default below — loadOverrides
    // already treats a missing file as "no overrides" (same try/catch
    // idiom loadRepoConfig uses), so a repo with no override file sees no
    // behavior change, and one that commits this file gets it picked up
    // with no workflow wiring at all.
    overridesPath: raw.overridesPath ?? '.gitflow-changelog-hash-overrides.yml',
    tagPattern: new RegExp(raw.tagPattern || fileConfig['tag-pattern'] || '.*'),
    enhancementLabels: splitLabels(raw.enhancementLabels, fileConfig['enhancement-labels'] ?? ['enhancement']),
    bugLabels: splitLabels(raw.bugLabels, fileConfig['bug-labels'] ?? ['bug']),
    excludeLabels: splitLabels(raw.excludeLabels, fileConfig['exclude-labels'] ?? ['duplicate', 'invalid', 'wontfix']),
    format: raw.format || fileConfig.format || 'default',
    upstream: fileConfig.upstream ?? [],
    upstreamCacheDir: raw.upstreamCacheDir ?? '.gitflow-changelog-upstream',
  };
}
