import type { HashFallback } from './cache.js';
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

export interface ResolveInput {
  entries: Entry[];
  overrides: HashOverrides;
  ref: string;
  // Keyed by `${kind}:${number}`, mutated in place as fallback resolutions
  // are discovered — same "caller persists it across runs" contract as
  // `prFilesCache` in upstream.ts. Omit for a one-shot resolve with no
  // persistence (e.g. tests).
  hashFallbackCache?: Record<string, HashFallback>;
}

function fallbackCacheKey(entry: { number: number; kind: 'issue' | 'pr' }): string {
  return `${entry.kind}:${entry.number}`;
}

// §6: a recorded merge_commit_sha / closing commit_id can point at a commit
// that no longer exists in this repo at all — distinct from "a valid commit
// that just isn't reachable from this branch," which placement.ts handles
// on its own as a legitimate drop. Resolution order, highest precedence
// first: checked-in override → as-is if already valid → cached fallback
// (revalidated, since a *further* rewrite could invalidate it) → a single
// history scan shared by every entry still needing one → flagged unresolved.
//
// The scan itself (scanCommitsReferencingNumbers) runs at most once per
// call, regardless of how many entries need it — see issue #13. Entries
// resolved via cache or override never trigger it at all.
export async function resolveHashes(input: ResolveInput, gitOptions: GitOptions): Promise<ResolveResult> {
  const resolved: Entry[] = [];
  const unresolved: UnresolvedEntry[] = [];
  const warnings: string[] = [];
  const cache = input.hashFallbackCache ?? {};

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
      continue;
    }

    pending.push(entry);
  }

  const referencingByNumber = pending.length > 0
    ? await scanCommitsReferencingNumbers(input.ref, gitOptions)
    : new Map<number, string[]>();

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
      resolved.push({ ...entry, sha: candidate });
      continue;
    }

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
