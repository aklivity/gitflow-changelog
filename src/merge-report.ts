import { matchesAny } from './classification.js';
import { loadCache, saveCache } from './cache.js';
import { excludedShas, updateCache } from './drivers/github.js';
import {
  commitDate,
  filesChangedInCommit,
  findCommitsContainingSubject,
  listBranches,
  resolveRef,
  scanPortsTrailers,
  unmatchedCommits,
} from './git.js';
import type { CherryCommit } from './git.js';
import { loadMergeIgnore } from './merge-ignore.js';
import { portsTrailerMatches } from './ports-trailer.js';
import { fileOverlap, normalizeSubject } from './subject-match.js';
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
  // A candidate is dropped if EVERY changed path matches one of these globs
  // — conservative: one file outside the set still shows up. Deliberately
  // separate from classification.ts's DEFAULT_CLASSIFICATION_PATTERNS,
  // which is tuned for "does this belong in the customer changelog" and
  // treats examples/docs as noise — merge-report needs the opposite call,
  // since a docs-only gap is exactly the kind of thing that must stay
  // visible.
  excludePaths: string[];
  // Regexes tested against the full commit subject. No built-in default —
  // scoped to a repo's own literal, deterministically machine-generated
  // commit messages (e.g. a release workflow's fixed "Prepare release "
  // template), never a general human/bot commit-message convention.
  excludeMessagePatterns: string[];
  // Second-opinion check for the dominant false-positive shape patch-id
  // comparison can't see past: a backport PR renumbered on the target
  // branch, with enough incidental diff drift to change the patch-id even
  // though it's the same fix. See subject-match.ts.
  subjectMatch: boolean;
  subjectMatchMinOverlap: number;
  // Trusts an explicit `Ports: <sha>` trailer in a target-branch commit's
  // body as an outright match for that sha — the escape hatch for a port
  // whose content is a deliberate subset/superset of the original (e.g. it
  // drops a version bump the target branch doesn't need), which changes
  // both patch-id and subject enough that neither of the other heuristics
  // can recognize the pairing on their own. See ports-trailer.ts.
  portsTrailer: boolean;
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

function isPathExcluded(files: string[], excludePaths: string[]): boolean {
  return files.length > 0 && excludePaths.length > 0 && files.every((file) => matchesAny(file, excludePaths));
}

// Cheapest-first: label/ignore-list lookups, the ports-trailer check, and a
// message-pattern test are plain in-memory checks (portsTrailerValues is
// scanned once per target, before this runs per-candidate — see mergeReport
// below); path-exclude costs one git call; subject-match costs a git log
// walk plus two more git calls, so it only ever runs once nothing cheaper
// has already resolved the candidate.
async function isExcluded(
  candidate: CherryCommit,
  targetRef: string,
  excludedLabelShas: Set<string>,
  ignoredShas: Map<string, string>,
  portsTrailerValues: string[],
  options: MergeReportOptions,
): Promise<boolean> {
  if (excludedLabelShas.has(candidate.sha) || ignoredShas.has(candidate.sha))
  {
    return true;
  }
  if (options.portsTrailer && portsTrailerMatches(candidate.sha, portsTrailerValues))
  {
    return true;
  }
  if (options.excludeMessagePatterns.some((pattern) => new RegExp(pattern).test(candidate.subject)))
  {
    return true;
  }

  const files = await filesChangedInCommit(candidate.sha, { cwd: options.gitDir });
  if (isPathExcluded(files, options.excludePaths))
  {
    return true;
  }

  if (!options.subjectMatch)
  {
    return false;
  }

  const normalized = normalizeSubject(candidate.subject);
  const found = await findCommitsContainingSubject(targetRef, normalized, { cwd: options.gitDir });
  const exact = found.find((commit) => normalizeSubject(commit.subject) === normalized);
  if (!exact)
  {
    return false;
  }

  const targetFiles = await filesChangedInCommit(exact.sha, { cwd: options.gitDir });
  return fileOverlap(files, targetFiles) >= options.subjectMatchMinOverlap;
}

export async function mergeReport(options: MergeReportOptions, now: Date = new Date()): Promise<MergeReportResult> {
  const cache = await loadCache(options.cachePath);
  await updateCache(cache, options);
  await saveCache(options.cachePath, cache);

  const excludedLabelShas = excludedShas(cache, options.excludeLabels);
  const ignoredShas = await loadMergeIgnore(options.mergeIgnorePath);
  const topology = await discoverTopology(options);

  const outstanding: MergeReportEntry[] = [];
  for (const { target, sources } of topology)
  {
    const targetRef = await resolveRef(target, { cwd: options.gitDir });
    // Scanned once per target rather than once per candidate — see the
    // isExcluded ordering comment above.
    const portsTrailerValues = options.portsTrailer ? await scanPortsTrailers(targetRef, { cwd: options.gitDir }) : [];
    for (const source of sources)
    {
      const sourceRef = await resolveRef(source, { cwd: options.gitDir });
      const candidates = await unmatchedCommits(targetRef, sourceRef, { cwd: options.gitDir });
      for (const candidate of candidates)
      {
        if (await isExcluded(candidate, targetRef, excludedLabelShas, ignoredShas, portsTrailerValues, options))
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
