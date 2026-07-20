import { loadCache, saveCache } from './cache.js';
import { excludedShas, updateCache } from './drivers/github.js';
import { commitDate, unmatchedCommits } from './git.js';
import { loadMergeIgnore } from './merge-ignore.js';

export interface MergeReportOptions {
  owner: string;
  repo: string;
  token: string;
  source: string;
  targets: string[];
  gitDir: string;
  cachePath: string;
  mergeIgnorePath?: string;
  excludeLabels: string[];
}

export interface MergeReportEntry {
  target: string;
  sha: string;
  subject: string;
  ageDays: number;
}

export interface MergeReportResult {
  // Every outstanding entry across every target, sorted oldest-first by
  // ageDays. Deliberately unfiltered by age — a cutoff here would hide a
  // real gap that's one day short of an arbitrary threshold. Age is only
  // ever used downstream (fail-on-outstanding-after-days), never to decide
  // what's visible in the report itself.
  outstanding: MergeReportEntry[];
}

function daysSince(isoDate: string, now: Date): number {
  const committed = new Date(isoDate);
  const ms = now.getTime() - committed.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export async function mergeReport(options: MergeReportOptions, now: Date = new Date()): Promise<MergeReportResult> {
  const cache = await loadCache(options.cachePath);
  await updateCache(cache, options);
  await saveCache(options.cachePath, cache);

  const excluded = excludedShas(cache, options.excludeLabels);
  const ignored = await loadMergeIgnore(options.mergeIgnorePath);

  const outstanding: MergeReportEntry[] = [];
  for (const target of options.targets)
  {
    const candidates = await unmatchedCommits(target, options.source, { cwd: options.gitDir });
    for (const candidate of candidates)
    {
      if (excluded.has(candidate.sha) || ignored.has(candidate.sha))
      {
        continue;
      }
      const date = await commitDate(candidate.sha, { cwd: options.gitDir });
      outstanding.push({ target, sha: candidate.sha, subject: candidate.subject, ageDays: daysSince(date, now) });
    }
  }

  outstanding.sort((a, b) => b.ageDays - a.ageDays);
  return { outstanding };
}
