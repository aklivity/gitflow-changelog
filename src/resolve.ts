import type { GitOptions } from './git.js';
import { commitExists, searchCommitsReferencing } from './git.js';
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
}

// §6: a recorded merge_commit_sha / closing commit_id can point at a commit
// that no longer exists in this repo at all — distinct from "a valid commit
// that just isn't reachable from this branch," which placement.ts handles
// on its own as a legitimate drop. Resolution order, highest precedence
// first: checked-in override → as-is if already valid → heuristic search of
// commit messages referencing the same number → flagged unresolved.
export async function resolveHashes(input: ResolveInput, gitOptions: GitOptions): Promise<ResolveResult> {
  const resolved: Entry[] = [];
  const unresolved: UnresolvedEntry[] = [];
  const warnings: string[] = [];

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

    const candidates = await searchCommitsReferencing(entry.number, input.ref, gitOptions);
    if (candidates.length === 1)
    {
      const [candidate] = candidates;
      warnings.push(
        `${entry.kind} #${entry.number}: recorded commit ${entry.sha} does not exist in this repository ` +
          `(likely history rewrite); auto-substituted ${candidate}, found by scanning commit messages for ` +
          `"#${entry.number}". If this recurs, add an explicit override for #${entry.number} to the ` +
          'changelog-hash-overrides file.',
      );
      resolved.push({ ...entry, sha: candidate });
      continue;
    }

    const reason = candidates.length === 0 ? 'not-found-anywhere' : 'ambiguous-candidates';
    const candidateDescription = candidates.length === 0
      ? 'no candidate commit references it'
      : `${candidates.length} candidate commits reference it ambiguously`;
    warnings.push(
      `${entry.kind} #${entry.number}: recorded commit ${entry.sha} does not exist in this repository and ` +
        `${candidateDescription}; dropping this entry. Add an explicit override for #${entry.number} to the ` +
        'changelog-hash-overrides file to fix this.',
    );
    unresolved.push({ entry, reason, candidates });
  }

  return { resolved, unresolved, warnings };
}
