import { loadCache, saveCache } from './cache.js';
import { excludedShas, updateCache } from './drivers/github.js';
import { commitDate, listBranches, resolveRef, unmatchedCommits } from './git.js';
import { loadMergeIgnore } from './merge-ignore.js';
import { computeTopology } from './topology.js';
import type { BranchTopology } from './topology.js';

export interface MergeReportOptions {
  owner: string;
  repo: string;
  token: string;
  gitDir: string;
  cachePath: string;
  mergeIgnorePath?: string;
  excludeLabels: string[];
  mainline: string;
  supportPattern: RegExp;
  // Narrows the sweep to a single target instead of the full topology —
  // for on-demand debugging ("just check support/2.x"). `sources`, if also
  // given, replaces that target's auto-computed sources entirely; without
  // it, the target's normal auto-computed sources still apply. Leaving
  // both unset is the default, parameter-free full sweep.
  target?: string;
  sources?: string[];
}

export interface MergeReportEntry {
  target: string;
  source: string;
  sha: string;
  subject: string;
  ageDays: number;
}

export interface MergeReportResult {
  // Every discovered (target, sources) pair, even one with no outstanding
  // entries — the renderer uses this to say a branch is explicitly clean
  // rather than silently omitting it.
  topology: BranchTopology[];
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

async function discoverTopology(options: MergeReportOptions): Promise<BranchTopology[]> {
  const branches = await listBranches(/.*/, { cwd: options.gitDir });
  const relevant = branches.filter((name) => name === options.mainline || options.supportPattern.test(name));
  const full = computeTopology(relevant, options.mainline, options.supportPattern);

  if (!options.target)
  {
    return full;
  }
  if (options.sources)
  {
    return [{ target: options.target, sources: options.sources }];
  }
  return [full.find((entry) => entry.target === options.target) ?? { target: options.target, sources: [] }];
}

export async function mergeReport(options: MergeReportOptions, now: Date = new Date()): Promise<MergeReportResult> {
  const cache = await loadCache(options.cachePath);
  await updateCache(cache, options);
  await saveCache(options.cachePath, cache);

  const excluded = excludedShas(cache, options.excludeLabels);
  const ignored = await loadMergeIgnore(options.mergeIgnorePath);
  const topology = await discoverTopology(options);

  const outstanding: MergeReportEntry[] = [];
  for (const { target, sources } of topology)
  {
    const targetRef = await resolveRef(target, { cwd: options.gitDir });
    for (const source of sources)
    {
      const sourceRef = await resolveRef(source, { cwd: options.gitDir });
      const candidates = await unmatchedCommits(targetRef, sourceRef, { cwd: options.gitDir });
      for (const candidate of candidates)
      {
        if (excluded.has(candidate.sha) || ignored.has(candidate.sha))
        {
          continue;
        }
        const date = await commitDate(candidate.sha, { cwd: options.gitDir });
        outstanding.push({ target, source, sha: candidate.sha, subject: candidate.subject, ageDays: daysSince(date, now) });
      }
    }
  }

  outstanding.sort((a, b) => b.ageDays - a.ageDays);
  return { topology, outstanding };
}
