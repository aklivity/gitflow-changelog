import { execFile } from 'node:child_process';
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
