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
  excludePaths?: string;
  excludeMessagePatterns?: string;
  subjectMatch?: string;
  subjectMatchMinOverlap?: string;
  portsTrailer?: string;
}

// Safe across any consuming repo: CI config, generated changelog content,
// and this tool's own config files are never customer-facing, regardless
// of what the repo actually does. Anything narrower than "every path
// matches" (e.g. a bare examples/ or docs/ change) is deliberately left
// out — a docs-only gap is exactly the kind of thing merge-report exists
// to catch, so it must stay visible by default.
const DEFAULT_EXCLUDE_PATHS = ['.github/**', 'CHANGELOG.md', '.gitflow-changelog*.yml'];

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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '')
  {
    return fallback;
  }
  return value.toLowerCase() === 'true';
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
  // with it. mainline-branch/support-branch-pattern and the filtering
  // options below are merge-report-only, but still repo-wide policy in the
  // same sense tag-pattern is, so they live alongside it rather than in a
  // third place.
  const fileConfig = await loadRepoConfig(gitDir, raw.configPath ?? '.gitflow-changelog.yml');

  const sources = splitList(raw.sources);
  if (sources.length > 0 && !raw.target)
  {
    throw new Error('sources only applies alongside target — it replaces that one target\'s auto-computed sources');
  }

  const excludePaths = splitList(raw.excludePaths);
  const excludeMessagePatterns = splitList(raw.excludeMessagePatterns);
  const overlapInput = raw.subjectMatchMinOverlap ? Number(raw.subjectMatchMinOverlap) : undefined;

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
    excludePaths: excludePaths.length > 0 ? excludePaths : fileConfig['exclude-paths'] ?? DEFAULT_EXCLUDE_PATHS,
    excludeMessagePatterns: excludeMessagePatterns.length > 0
      ? excludeMessagePatterns
      : fileConfig['exclude-message-patterns'] ?? [],
    subjectMatch: raw.subjectMatch !== undefined
      ? parseBoolean(raw.subjectMatch, true)
      : fileConfig['subject-match'] ?? true,
    subjectMatchMinOverlap: overlapInput ?? fileConfig['subject-match-min-overlap'] ?? 0.3,
    portsTrailer: raw.portsTrailer !== undefined
      ? parseBoolean(raw.portsTrailer, true)
      : fileConfig['ports-trailer'] ?? true,
  };
}
