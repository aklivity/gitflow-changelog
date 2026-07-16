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

export async function searchCommitsReferencing(
  issueNumber: number,
  ref: string,
  options: GitOptions,
): Promise<string[]> {
  const pattern = String.raw`(^|[^0-9])#${issueNumber}([^0-9]|$)`;
  const result = await runAllowFailure(
    ['log', ref, '--format=%H', '--extended-regexp', `--grep=${pattern}`],
    options,
  );
  if (result.code !== 0)
  {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
