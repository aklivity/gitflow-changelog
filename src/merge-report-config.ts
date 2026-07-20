import { loadRepoConfig } from './repo-config.js';
import type { MergeReportOptions } from './merge-report.js';

export interface RawMergeReportInputs {
  owner?: string;
  repo?: string;
  token?: string;
  gitDir?: string;
  cachePath?: string;
  mergeIgnorePath?: string;
  configPath?: string;
  excludeLabels?: string;
  mainlineBranch?: string;
  supportBranchPattern?: string;
  target?: string;
  sources?: string;
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

  const gitDir = raw.gitDir ?? process.cwd();
  // Same policy file the changelog command reads — exclude-labels is one
  // shared vocabulary (e.g. `dependencies`, `wontfix`) rather than a
  // second, merge-report-only config surface that could drift out of sync
  // with it. mainline-branch/support-branch-pattern are merge-report-only,
  // but still repo-wide policy in the same sense tag-pattern is, so they
  // live alongside it rather than in a third place.
  const fileConfig = await loadRepoConfig(gitDir, raw.configPath ?? '.gitflow-changelog.yml');

  const sources = splitList(raw.sources);
  if (sources.length > 0 && !raw.target)
  {
    throw new Error('sources only applies alongside target — it replaces that one target\'s auto-computed sources');
  }

  return {
    owner: raw.owner,
    repo: raw.repo,
    token: raw.token,
    gitDir,
    cachePath: raw.cachePath ?? '.gitflow-changelog-cache.json',
    mergeIgnorePath: raw.mergeIgnorePath ?? '.gitflow-changelog-merge-ignore.yml',
    excludeLabels: splitList(raw.excludeLabels).length > 0
      ? splitList(raw.excludeLabels)
      : fileConfig['exclude-labels'] ?? ['duplicate', 'invalid', 'wontfix'],
    mainline: raw.mainlineBranch || fileConfig['mainline-branch'] || 'develop',
    supportPattern: new RegExp(raw.supportBranchPattern || fileConfig['support-branch-pattern'] || '^support/(\\d+)\\.x$'),
    target: raw.target || undefined,
    sources: sources.length > 0 ? sources : undefined,
  };
}
