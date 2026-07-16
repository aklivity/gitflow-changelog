import { describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn((..._args: unknown[]) => {
  const callback = _args.at(-1) as (err: unknown, result: { stdout: string; stderr: string }) => void;
  callback(null, { stdout: '', stderr: '' });
});

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { cloneRepo } = await import('../src/git.js');

describe('cloneRepo', () => {
  it('disables credential-helper interaction for the clone', async () => {
    await cloneRepo('acme', 'engine', '/tmp/wherever', 'tok');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args.slice(0, 3)).toEqual(['-c', 'credential.helper=', 'clone']);
  });

  it('embeds the token in the clone URL, not as a separate credential', async () => {
    await cloneRepo('acme', 'engine', '/tmp/wherever', 'tok');

    const args = execFileMock.mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain('https://x-access-token:tok@github.com/acme/engine.git');
  });
});
