import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitOptions {
  cwd: string;
}

async function run(args: string[], options: GitOptions): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function runAllowFailure(args: string[], options: GitOptions): Promise<{ code: number; stdout: string }> {
  try
  {
    const stdout = await run(args, options);
    return { code: 0, stdout };
  }
  catch (error)
  {
    const err = error as { code?: number; stdout?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '' };
  }
}

export async function commitExists(sha: string, options: GitOptions): Promise<boolean> {
  const result = await runAllowFailure(['cat-file', '-e', `${sha}^{commit}`], options);
  return result.code === 0;
}

export async function isAncestor(sha: string, ref: string, options: GitOptions): Promise<boolean> {
  const result = await runAllowFailure(['merge-base', '--is-ancestor', sha, ref], options);
  return result.code === 0;
}

export async function tagsContaining(sha: string, options: GitOptions): Promise<string[]> {
  const stdout = await run(['tag', '--contains', sha], options);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Every tag that is an ancestor of (reachable from) `ref`, in a single git
// call — the batched form of asking isAncestor(tag, ref) for every tag one
// at a time. Used to check many candidate tags against one ancestry
// boundary at once (see selectEntriesInRange in upstream.ts) instead of
// spawning a separate `merge-base --is-ancestor` per candidate.
export async function tagsMergedInto(ref: string, options: GitOptions): Promise<Set<string>> {
  const stdout = await run(['tag', '--merged', ref], options);
  return new Set(
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

export interface TagInfo {
  name: string;
  sha: string;
  date: string;
}

export async function listTags(pattern: RegExp, options: GitOptions): Promise<TagInfo[]> {
  const stdout = await run(
    ['for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(creatordate:iso-strict)', 'refs/tags'],
    options,
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, sha, date] = line.split('\t');
      return { name, sha, date };
    })
    .filter((tag) => pattern.test(tag.name));
}

// Reads a file's content at a specific ref (a tag, branch, or HEAD) without
// checking it out — used to read a dependency-pinned version from a pom.xml
// as it existed at a past release tag, not just the current working tree.
// Returns undefined if the ref or path doesn't exist (e.g. the file didn't
// exist yet at that tag).
export async function showFile(ref: string, path: string, options: GitOptions): Promise<string | undefined> {
  const result = await runAllowFailure(['show', `${ref}:${path}`], options);
  return result.code === 0 ? result.stdout : undefined;
}

// `-c credential.helper=` disables credential-helper interaction for the
// commands below. Without it, a caller running inside a job that already
// has `credential.helper store` configured globally (a common pattern for
// authenticating a separate git push elsewhere in the same job, e.g. a
// release workflow pushing with a dedicated PAT) would have this repo's
// URL-embedded token silently persisted into that same shared credential
// store on success — git's "store" helper caches *any* credential it sees
// succeed, not just ones it was asked to look up. Since both credentials
// share the `github.com` host key, that overwrites the caller's own token
// with this one, corrupting unrelated git operations later in the same job.
async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', ['-c', 'credential.helper=', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
}

async function isExistingClone(dir: string): Promise<boolean> {
  try
  {
    await access(join(dir, '.git'));
    return true;
  }
  catch
  {
    return false;
  }
}

// Clones a repo the first time `dir` is used, and updates it in place on
// every call after that — full history either way (fold-in placement needs
// the upstream repo's complete tag and ancestry graph, not just its recent
// commits, and maven-level classification reads files from a real working
// tree, not just refs). The point of reusing `dir` across calls is that
// `git fetch` only transfers objects the local clone doesn't already have —
// the expensive part of a full clone is the one-time network cost of
// getting history the local copy has never seen, not re-deriving ancestry
// locally, which is fast once the objects are already on disk. Callers are
// expected to persist `dir` across runs (e.g. via actions/cache) for this
// to pay off; called against a fresh empty `dir` every time, it degrades to
// exactly the old always-clone behavior.
export async function cloneOrUpdateRepo(owner: string, repo: string, dir: string, token: string): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  if (!(await isExistingClone(dir)))
  {
    // `git clone` creates the leaf directory itself but not missing
    // parents, and refuses to clone into a non-empty one — pre-creating an
    // empty `dir` (recursive, so parents come along too) and cloning into
    // it as "." (rather than passing `dir` itself as the clone target,
    // which would resolve relative to `cwd` and land one level too deep
    // for a relative path) satisfies both.
    await mkdir(dir, { recursive: true });
    await runGit(['clone', '--quiet', url, '.'], dir);
    return;
  }

  await runGit(['remote', 'set-url', 'origin', url], dir);
  await runGit(['fetch', '--quiet', '--tags', '--prune', 'origin'], dir);
  await runGit(['remote', 'set-head', 'origin', '-a'], dir);
  // --short on refs/remotes/origin/HEAD returns "origin/<branch>" (only the
  // refs/remotes/ prefix is stripped, not the remote name) — strip it too,
  // or the checkout below builds "origin/origin/<branch>" and fails.
  const { stdout } = await execFileAsync('git', ['-C', dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const defaultBranch = stdout.trim().replace(/^origin\//, '');
  await runGit(['checkout', '--quiet', '-B', defaultBranch, `origin/${defaultBranch}`], dir);
}

// Field/record separators unlikely to appear in a commit message, used to
// split `git log`'s single stdout blob back into (sha, body) pairs below.
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

// Extracts every "#<number>" commit-message reference reachable from `ref`
// in a single history walk, bucketed by number (newest commit first within
// each bucket, matching git log's default order). Used to resolve the
// "recorded commit no longer exists in this repo, likely history rewrite"
// fallback in resolve.ts for every affected entry at once, instead of one
// `git log --grep` walk (and thus one full history scan) per entry — see
// issue #13.
export async function scanCommitsReferencingNumbers(ref: string, options: GitOptions): Promise<Map<number, string[]>> {
  const byNumber = new Map<number, string[]>();
  const result = await runAllowFailure(['log', ref, `--format=%H${FIELD_SEP}%B${RECORD_SEP}`], options);
  if (result.code !== 0)
  {
    return byNumber;
  }

  const pattern = /(?<![0-9])#([0-9]+)(?![0-9])/g;
  for (const record of result.stdout.split(RECORD_SEP))
  {
    const trimmed = record.trim();
    const separatorIndex = trimmed.indexOf(FIELD_SEP);
    if (separatorIndex === -1)
    {
      continue;
    }

    const sha = trimmed.slice(0, separatorIndex);
    const body = trimmed.slice(separatorIndex + 1);
    const seen = new Set<number>();
    for (const match of body.matchAll(pattern))
    {
      const number = Number(match[1]);
      if (seen.has(number))
      {
        continue;
      }
      seen.add(number);
      const bucket = byNumber.get(number) ?? [];
      bucket.push(sha);
      byNumber.set(number, bucket);
    }
  }
  return byNumber;
}

// Files touched by a single commit, diffed against its first parent — this
// covers both an ordinary commit (its only parent) and a merge commit (the
// net change the merge brought in on the mainline), which is what a direct
// "closed by commit_id" issue-closing commit or a squash-merge commit
// actually represents. Used to classify a fold-in issue entry whose sha
// doesn't match any fetched PR's merge commit (see resolveModule/
// filterForFoldIn in upstream.ts) without needing a GitHub API call.
export async function filesChangedInCommit(sha: string, options: GitOptions): Promise<string[]> {
  const result = await runAllowFailure(['diff', '--name-only', `${sha}^`, sha], options);
  if (result.code !== 0)
  {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface CherryCommit {
  sha: string;
  subject: string;
}

// Parses `git cherry -v <target> <source>` and returns only the commits on
// `source` marked '+' — patch content with no equivalent anywhere in
// `target`'s history. Deliberately drops the '-' side (a patch-id match):
// a commit re-applied under a new SHA on `source` — the normal shape of a
// cherry-pick or an independently re-landed fix — is already present in
// `target` in every way that matters here, even though a plain ancestry
// diff (`git log target..source`) would still flag it as missing.
export async function unmatchedCommits(target: string, source: string, options: GitOptions): Promise<CherryCommit[]> {
  const stdout = await run(['cherry', '-v', target, source], options);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('+ '))
    .map((line) => {
      const withoutMarker = line.slice(2);
      const spaceIndex = withoutMarker.indexOf(' ');
      return { sha: withoutMarker.slice(0, spaceIndex), subject: withoutMarker.slice(spaceIndex + 1) };
    });
}

export async function commitDate(sha: string, options: GitOptions): Promise<string> {
  const stdout = await run(['show', '-s', '--format=%cI', sha], options);
  return stdout.trim();
}

// Every local branch and every origin remote-tracking branch, deduped down
// to short names (the "origin/" prefix stripped) and filtered to `pattern`.
// A typical CI checkout only has one local branch, with everything else
// present as origin/<name> after a fetch — reading both refs/heads and
// refs/remotes/origin means merge-report's branch discovery works the same
// way against that shape and against a plain local clone (e.g. a test
// fixture with no remote at all, where every branch is local).
export async function listBranches(pattern: RegExp, options: GitOptions): Promise<string[]> {
  const stdout = await run(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'], options);
  const names = new Set(
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== 'origin/HEAD')
      .map((name) => name.replace(/^origin\//, '')),
  );
  return [...names].filter((name) => pattern.test(name));
}

async function refExists(ref: string, options: GitOptions): Promise<boolean> {
  const result = await runAllowFailure(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], options);
  return result.code === 0;
}

// Resolves a branch's short name (as returned by listBranches) to a ref
// git commands can actually operate on. Prefers origin/<name> — the shape
// every branch except the checked-out one has in a normal CI checkout — and
// falls back to the bare name for a plain local clone (no origin remote at
// all, e.g. a test fixture) where the bare name is all that exists.
export async function resolveRef(name: string, options: GitOptions): Promise<string> {
  const withOrigin = `origin/${name}`;
  return (await refExists(withOrigin, options)) ? withOrigin : name;
}

export interface CommitSubject {
  sha: string;
  subject: string;
}

// A field separator unlikely to appear in a subject line, used to split
// git log's single stdout blob back into (sha, subject) pairs.
const SUBJECT_FIELD_SEP = '\x1f';

// `--grep` is a substring/regex match, not an exact one — this deliberately
// returns every loose candidate rather than trying to decide exactness
// itself, so callers (subject-match.ts) own the normalization+equality
// check against what they searched for.
export async function findCommitsContainingSubject(
  ref: string,
  substring: string,
  options: GitOptions,
): Promise<CommitSubject[]> {
  const result = await runAllowFailure(
    ['log', ref, '--fixed-strings', `--grep=${substring}`, `--format=%H${SUBJECT_FIELD_SEP}%s`],
    options,
  );
  if (result.code !== 0)
  {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const sepIndex = line.indexOf(SUBJECT_FIELD_SEP);
      return { sha: line.slice(0, sepIndex), subject: line.slice(sepIndex + 1) };
    });
}
