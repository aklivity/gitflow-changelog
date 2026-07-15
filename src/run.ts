import { loadCache, saveCache } from './cache.js';
import { GithubDriver } from './drivers/github.js';
import { loadOverrides } from './overrides.js';
import { place } from './placement.js';
import { render } from './render/default.js';
import { resolveHashes } from './resolve.js';
import type { DriverOptions } from './types.js';

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
}

export interface RunResult {
  markdown: string;
  warnings: string[];
}

const RENDERERS: Record<string, typeof render> = {
  default: render,
};

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

  const markdown = renderer(placement, { owner: options.owner, repo: options.repo });

  return { markdown, warnings };
}
