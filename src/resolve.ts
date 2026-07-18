import type { HashFallback, SquashMergeCache } from './cache.js';
import { fetchDefaultBranch, fetchPullRequestBaseRef, findSquashMergePr, GithubRateLimitError } from './drivers/github.js';
import type { GitOptions } from './git.js';
import { commitExists, scanCommitsReferencingNumbers } from './git.js';
import type { HashOverrides } from './overrides.js';
import { overrideFor } from './overrides.js';
import type { Entry, UnresolvedEntry } from './types.js';

export interface ResolveResult {
  resolved: Entry[];
  unresolved: UnresolvedEntry[];
  warnings: string[];
}

export interface GithubContext {
  owner: string;
  repo: string;
  token: string;
}

export interface ResolveInput {
  entries: Entry[];
  overrides: HashOverrides;
  ref: string;
  // Keyed by `${kind}:${number}`, mutated in place as fallback resolutions
  // are discovered — same "caller persists it across runs" contract as
  // `prFilesCache` in upstream.ts. Omit for a one-shot resolve with no
  // persistence (e.g. tests).
  hashFallbackCache?: Record<string, HashFallback>;
  // Enables the tier-4 squash-merge fallback below — omit for a pure-local
  // resolve (e.g. tests) with no GitHub API access.
  github?: GithubContext;
  squashMergeCache?: SquashMergeCache;
}

function fallbackCacheKey(entry: { number: number; kind: 'issue' | 'pr' }): string {
  return `${entry.kind}:${entry.number}`;
}

function emptySquashMergeCache(): SquashMergeCache {
  return { prBaseRefs: {}, squashMergePrs: {} };
}

async function resolveBaseRef(entry: Entry, github: GithubContext, squashCache: SquashMergeCache): Promise<string | undefined> {
  const key = String(entry.number);
  const cached = squashCache.prBaseRefs[key];
  if (cached)
  {
    return cached;
  }
  const baseRef = await fetchPullRequestBaseRef(github.owner, github.repo, entry.number, github.token);
  if (baseRef)
  {
    squashCache.prBaseRefs[key] = baseRef;
  }
  return baseRef;
}

// A squash-merge PR's own base isn't reliably one branch or the other: it
// might target `ref` directly (a feature branch squashed straight into the
// maintenance branch being processed), or it might target the repo's
// default branch with `ref` only inheriting the result via ancestry (the
// confirmed aklivity/zilla case — feature/support-catalog-handler-validate
// squashed into develop, later reachable from support/1.x too). Try `ref`
// first — cheapest when `ref` already is the default branch, since that's
// a single query — then fall back to `defaultBranch` only if that missed
// and the two actually differ.
async function resolveSquashMergePr(
  baseRef: string,
  ref: string,
  defaultBranch: string,
  github: GithubContext,
  squashCache: SquashMergeCache,
): Promise<number | undefined> {
  const cached = squashCache.squashMergePrs[baseRef];
  if (cached)
  {
    return cached;
  }

  const mergeTargets = ref === defaultBranch ? [ref] : [ref, defaultBranch];
  for (const target of mergeTargets)
  {
    const prNumber = await findSquashMergePr(github.owner, github.repo, baseRef, target, github.token);
    if (prNumber)
    {
      squashCache.squashMergePrs[baseRef] = prNumber;
      return prNumber;
    }
  }
  return undefined;
}

interface SquashMergeCandidate {
  resolvedSha: string;
  baseRef: string;
  squashPrNumber: number;
}

// Only meaningful for PR entries: a PR merged into a long-lived feature
// branch (base ref) that was itself later squash-merged has its own commit
// permanently flattened away, but the squash-merge PR's number survives in
// commit messages and is already present in referencingByNumber (the
// single history scan tier 3 already ran) — so no second git operation is
// needed here, only the GitHub lookups to find which number to look up.
async function resolveViaSquashMerge(
  entry: Entry,
  ref: string,
  defaultBranch: string,
  github: GithubContext,
  squashCache: SquashMergeCache,
  referencingByNumber: Map<number, string[]>,
): Promise<SquashMergeCandidate | undefined> {
  const baseRef = await resolveBaseRef(entry, github, squashCache);
  if (!baseRef || baseRef === ref || baseRef === defaultBranch)
  {
    return undefined;
  }

  const squashPrNumber = await resolveSquashMergePr(baseRef, ref, defaultBranch, github, squashCache);
  if (!squashPrNumber)
  {
    return undefined;
  }

  const candidates = referencingByNumber.get(squashPrNumber) ?? [];
  if (candidates.length !== 1)
  {
    return undefined;
  }

  return { resolvedSha: candidates[0], baseRef, squashPrNumber };
}

// §6: a recorded merge_commit_sha / closing commit_id can point at a commit
// that no longer exists in this repo at all — distinct from "a valid commit
// that just isn't reachable from this branch," which placement.ts handles
// on its own as a legitimate drop. Resolution order, highest precedence
// first: checked-in override → as-is if already valid → cached fallback
// (revalidated, since a *further* rewrite could invalidate it) → a single
// history scan shared by every entry still needing one → a squash-merge
// lookup for PR entries the scan didn't resolve → flagged unresolved.
//
// The scan itself (scanCommitsReferencingNumbers) runs at most once per
// call, regardless of how many entries need it — see issue #13. Entries
// resolved via cache or override never trigger it at all.
//
// Within a single call, once any entry's original sha resolves to a
// replacement (via any tier), that mapping is reused for every other entry
// recorded with the identical original sha — most commonly an issue and
// the PR whose merge closed it, which always share a sha via
// applyClosingReferences in drivers/github.ts. This lets an issue resolve
// for free off its closing PR's squash-merge lookup, without needing (or
// even being able, since issues have no base ref) a lookup of its own.
export async function resolveHashes(input: ResolveInput, gitOptions: GitOptions): Promise<ResolveResult> {
  const resolved: Entry[] = [];
  const warnings: string[] = [];
  const cache = input.hashFallbackCache ?? {};
  const squashCache = input.squashMergeCache ?? emptySquashMergeCache();
  const resolvedShaThisRun = new Map<string, string>();

  const pending: Entry[] = [];
  for (const entry of input.entries)
  {
    const override = overrideFor(entry, input.overrides);
    if (override)
    {
      resolved.push({ ...entry, sha: override });
      continue;
    }

    if (await commitExists(entry.sha, gitOptions))
    {
      resolved.push(entry);
      continue;
    }

    const cached = cache[fallbackCacheKey(entry)];
    if (cached && cached.originalSha === entry.sha && (await commitExists(cached.resolvedSha, gitOptions)))
    {
      warnings.push(
        `${entry.kind} #${entry.number}: recorded commit ${entry.sha} does not exist in this repository ` +
          `(likely history rewrite); reusing cached substitute ${cached.resolvedSha} from a previous run. ` +
          `If this is wrong, add an explicit override for ${entry.sha} to the changelog-hash-overrides file.`,
      );
      resolved.push({ ...entry, sha: cached.resolvedSha });
      resolvedShaThisRun.set(entry.sha, cached.resolvedSha);
      continue;
    }

    pending.push(entry);
  }

  const referencingByNumber = pending.length > 0
    ? await scanCommitsReferencingNumbers(input.ref, gitOptions)
    : new Map<number, string[]>();

  const stillPending: Entry[] = [];
  for (const entry of pending)
  {
    const candidates = referencingByNumber.get(entry.number) ?? [];
    if (candidates.length === 1)
    {
      const [candidate] = candidates;
      warnings.push(
        `${entry.kind} #${entry.number}: recorded commit ${entry.sha} does not exist in this repository ` +
          `(likely history rewrite); auto-substituted ${candidate}, found by scanning commit messages for ` +
          `"#${entry.number}". If this recurs, add an explicit override for ${entry.sha} to the ` +
          'changelog-hash-overrides file.',
      );
      cache[fallbackCacheKey(entry)] = { originalSha: entry.sha, resolvedSha: candidate };
      resolvedShaThisRun.set(entry.sha, candidate);
      resolved.push({ ...entry, sha: candidate });
      continue;
    }

    stillPending.push(entry);
  }

  // Fetched at most once per call, and only if at least one PR entry could
  // actually use it — most runs never reach tier 4 at all.
  //
  // `rateLimited` short-circuits the rest of tier 4 for this call the
  // moment GitHub signals rate-limit exhaustion (GithubRateLimitError) —
  // silently continuing to attempt lookups per remaining entry would (a)
  // report a false "no candidate commit references it" for every one of
  // them, when the real reason is "we couldn't check," and (b) keep
  // spending calls against an already-exhausted quota. Anything already
  // written into `squashCache`/`cache` before the limit was hit stays
  // there — the caller's persisted cache file only grows more useful for
  // the next run, it's never rolled back.
  let rateLimited = false;
  let defaultBranch: string | undefined;
  if (input.github && stillPending.some((entry) => entry.kind === 'pr'))
  {
    try
    {
      defaultBranch = await fetchDefaultBranch(input.github.owner, input.github.repo, input.github.token);
    }
    catch (error)
    {
      if (!(error instanceof GithubRateLimitError))
      {
        throw error;
      }
      rateLimited = true;
    }
  }

  const unresolvedCandidates: Entry[] = [];
  for (const entry of stillPending)
  {
    if (!rateLimited && input.github && defaultBranch && entry.kind === 'pr')
    {
      try
      {
        const squashCandidate = await resolveViaSquashMerge(entry, input.ref, defaultBranch, input.github, squashCache, referencingByNumber);
        if (squashCandidate)
        {
          warnings.push(
            `${entry.kind} #${entry.number}: recorded commit ${entry.sha} does not exist in this repository ` +
              `(likely squash-merged via a long-lived branch); auto-substituted ${squashCandidate.resolvedSha}, found ` +
              `via the squash-merge of base branch "${squashCandidate.baseRef}" in #${squashCandidate.squashPrNumber}. ` +
              `If this is wrong, add an explicit override for ${entry.sha} to the changelog-hash-overrides file.`,
          );
          cache[fallbackCacheKey(entry)] = { originalSha: entry.sha, resolvedSha: squashCandidate.resolvedSha };
          resolvedShaThisRun.set(entry.sha, squashCandidate.resolvedSha);
          resolved.push({ ...entry, sha: squashCandidate.resolvedSha });
          continue;
        }
      }
      catch (error)
      {
        if (!(error instanceof GithubRateLimitError))
        {
          throw error;
        }
        rateLimited = true;
      }
    }

    unresolvedCandidates.push(entry);
  }

  if (rateLimited)
  {
    warnings.push(
      'GitHub API rate limit hit while resolving squash-merge fallbacks; skipping this tier for the rest of this ' +
        'run rather than reporting the remaining entries as unresolvable. Any base refs and squash-merge PR ' +
        'numbers already discovered this run are still cached, so the next run resumes from there instead of ' +
        'starting over.',
    );
  }

  const unresolved: UnresolvedEntry[] = [];
  for (const entry of unresolvedCandidates)
  {
    const reusedSha = resolvedShaThisRun.get(entry.sha);
    if (reusedSha)
    {
      resolved.push({ ...entry, sha: reusedSha });
      continue;
    }

    const candidates = referencingByNumber.get(entry.number) ?? [];
    const reason = candidates.length === 0 ? 'not-found-anywhere' : 'ambiguous-candidates';
    const candidateDescription = candidates.length === 0
      ? 'no candidate commit references it'
      : `${candidates.length} candidate commits reference it ambiguously`;
    warnings.push(
      `${entry.kind} #${entry.number}: recorded commit ${entry.sha} does not exist in this repository and ` +
        `${candidateDescription}; dropping this entry. Add an explicit override for ${entry.sha} to the ` +
        'changelog-hash-overrides file to fix this.',
    );
    unresolved.push({ entry, reason, candidates });
  }

  return { resolved, unresolved, warnings };
}
