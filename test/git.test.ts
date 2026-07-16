import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn((..._args: unknown[]) => {
  const callback = _args.at(-1) as (err: unknown, result: { stdout: string; stderr: string }) => void;
  callback(null, { stdout: '', stderr: '' });
});

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { cloneOrUpdateRepo } = await import('../src/git.js');

describe('cloneOrUpdateRepo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-clone-test-'));
    execFileMock.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('clones fresh into an empty directory with no .git', async () => {
    await cloneOrUpdateRepo('acme', 'engine', dir, 'tok');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args.slice(0, 3)).toEqual(['-c', 'credential.helper=', 'clone']);
    expect(args).toContain('https://x-access-token:tok@github.com/acme/engine.git');
    // Clones into "." (the already-created dir via cwd), not `dir` itself as
    // the target — passing `dir` again would resolve relative to cwd and
    // land one level too deep for a relative path.
    expect(args.at(-1)).toBe('.');
  });

  it('creates missing parent directories before a fresh clone', async () => {
    const nested = join(dir, 'nested', 'acme-engine');

    await cloneOrUpdateRepo('acme', 'engine', nested, 'tok');

    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args.slice(0, 3)).toEqual(['-c', 'credential.helper=', 'clone']);
  });

  it('updates in place via fetch instead of re-cloning when a .git already exists', async () => {
    await mkdir(join(dir, '.git'));
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (err: unknown, result: { stdout: string; stderr: string }) => void;
      const argv = args[1] as string[];
      if (argv.includes('symbolic-ref'))
      {
        callback(null, { stdout: 'develop\n', stderr: '' });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    await cloneOrUpdateRepo('acme', 'engine', dir, 'tok');

    const calls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    expect(calls).toEqual([
      ['-c', 'credential.helper=', 'remote', 'set-url', 'origin', 'https://x-access-token:tok@github.com/acme/engine.git'],
      ['-c', 'credential.helper=', 'fetch', '--quiet', '--tags', '--prune', 'origin'],
      ['-c', 'credential.helper=', 'remote', 'set-head', 'origin', '-a'],
      ['-C', dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      ['-c', 'credential.helper=', 'checkout', '--quiet', '-B', 'develop', 'origin/develop'],
    ]);
  });
});
