import type { GitOptions } from './git.js';
import { listCommitSubjects } from './git.js';

// GitHub's own commit-message conventions for "this commit is the result of
// merging PR #NNN" — a trailing "(#NNN)" on a squash-merge subject, or the
// "Merge pull request #NNN from ..." subject a real merge commit gets.
// Deliberately narrow: scanning full commit *bodies* for any "#NNN"
// reference (like scanCommitsReferencingNumbers in git.ts, used for a
// different purpose — resolving a *known* entry's rewritten sha) would
// match "Fixes #1070"/"Related: #929" style prose too, which refers to
// issues the commit *closes or discusses*, not PRs the commit *is*. Only
// the subject-line conventions below are an unambiguous "this commit ==
// PR #NNN" signal.
const SQUASH_MERGE_SUFFIX = /\(#(\d+)\)\s*$/;
const MERGE_COMMIT_PREFIX = /^Merge pull request #(\d+) from /;

function extractMergedPrNumber(subject: string): number | undefined {
  const squash = subject.match(SQUASH_MERGE_SUFFIX);
  if (squash)
  {
    return Number(squash[1]);
  }
  const merge = subject.match(MERGE_COMMIT_PREFIX);
  return merge ? Number(merge[1]) : undefined;
}

export interface CompletenessIssue {
  number: number;
  sha: string;
}

// Independent ground-truth safety net: rather than trusting the driver's
// own fetch (a repo-wide, paginated, cached, eventually-consistent feed —
// see walkNewEvents in drivers/github.ts, which has no test coverage of its
// page-boundary "stop at the first empty page" logic), this asks git
// directly which PRs actually merged in `range` and confirms every one of
// them is a *known* number — present somewhere in the driver's fetched
// entries, resolved or not, regardless of whether it ends up rendered.
//
// This is what would have caught aklivity/zilla-plus#1073 and #1075: both
// squash-merged into support/1.x with a "(#NNN)" subject, both correctly
// contained by the 1.4.3 tag (confirmed directly with `git tag --contains`),
// yet neither ever appeared in the changelog action's fetched entries or
// its warnings — the 1.4.3 release shipped with a silently incomplete
// CHANGELOG.md and a fully green workflow. A gap here is deliberately fatal
// (see run.ts/action.ts) rather than an ignorable warning: a wrong
// changelog is worse than a failed build, because a failed build can't be
// missed.
//
// `knownNumbers` deliberately does not distinguish "never fetched" from
// "fetched but excluded by label" — a real label-excluded PR that also
// happens to squash-merge with a matching subject would trip this check
// too. That's an accepted false-positive: this function exists to make
// missing coverage loud, and a maintainer confirming "yes, that one's
// intentionally excluded" is a small, one-time cost next to another
// silently wrong release.
export async function checkCompleteness(
  range: string,
  knownNumbers: ReadonlySet<number>,
  gitOptions: GitOptions,
): Promise<CompletenessIssue[]> {
  const commits = await listCommitSubjects(range, gitOptions);
  const issues: CompletenessIssue[] = [];
  const seen = new Set<number>();

  for (const { sha, subject } of commits)
  {
    const number = extractMergedPrNumber(subject);
    if (number === undefined || knownNumbers.has(number) || seen.has(number))
    {
      continue;
    }
    seen.add(number);
    issues.push({ number, sha });
  }

  return issues.sort((a, b) => a.number - b.number);
}
