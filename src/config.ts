import type { RunOptions } from './run.js';

export interface RawInputs {
  owner?: string;
  repo?: string;
  token?: string;
  ref?: string;
  gitDir?: string;
  cachePath?: string;
  overridesPath?: string;
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

export function toRunOptions(raw: RawInputs): RunOptions {
  if (!raw.owner || !raw.repo)
  {
    throw new Error('owner and repo are required');
  }
  if (!raw.token)
  {
    throw new Error('token is required');
  }

  return {
    owner: raw.owner,
    repo: raw.repo,
    token: raw.token,
    ref: raw.ref ?? 'HEAD',
    gitDir: raw.gitDir ?? process.cwd(),
    cachePath: raw.cachePath ?? '.gitflow-changelog-cache.json',
    overridesPath: raw.overridesPath,
    tagPattern: new RegExp(raw.tagPattern ?? '.*'),
    enhancementLabels: splitLabels(raw.enhancementLabels, ['enhancement']),
    bugLabels: splitLabels(raw.bugLabels, ['bug']),
    excludeLabels: splitLabels(raw.excludeLabels, ['duplicate', 'invalid', 'wontfix']),
    format: raw.format ?? 'default',
  };
}
