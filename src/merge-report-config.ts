import { loadRepoConfig } from './repo-config.js';
import type { MergeReportOptions } from './merge-report.js';

export interface RawMergeReportInputs {
  owner?: string;
  repo?: string;
  token?: string;
  source?: string;
  targets?: string;
  gitDir?: string;
  cachePath?: string;
  mergeIgnorePath?: string;
  configPath?: string;
  excludeLabels?: string;
}

function splitList(value: string | undefined): string[] {
  if (!value)
  {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export async function toMergeReportOptions(raw: RawMergeReportInputs): Promise<MergeReportOptions> {
  if (!raw.owner || !raw.repo)
  {
    throw new Error('owner and repo are required');
  }
  if (!raw.token)
  {
    throw new Error('token is required');
  }
  if (!raw.source)
  {
    throw new Error('source is required');
  }
  const targets = splitList(raw.targets);
  if (targets.length === 0)
  {
    throw new Error('targets is required');
  }

  const gitDir = raw.gitDir ?? process.cwd();
  // Same policy file the changelog command reads — exclude-labels is one
  // shared vocabulary (e.g. `dependencies`, `wontfix`) rather than a
  // second, merge-report-only config surface that could drift out of sync
  // with it.
  const fileConfig = await loadRepoConfig(gitDir, raw.configPath ?? '.gitflow-changelog.yml');

  return {
    owner: raw.owner,
    repo: raw.repo,
    token: raw.token,
    source: raw.source,
    targets,
    gitDir,
    cachePath: raw.cachePath ?? '.gitflow-changelog-cache.json',
    mergeIgnorePath: raw.mergeIgnorePath ?? '.gitflow-changelog-merge-ignore.yml',
    excludeLabels: splitList(raw.excludeLabels).length > 0
      ? splitList(raw.excludeLabels)
      : fileConfig['exclude-labels'] ?? ['duplicate', 'invalid', 'wontfix'],
  };
}
