import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitFixture {
  dir: string;
  commit(message: string): Promise<string>;
  tag(name: string, date: string): Promise<void>;
  branch(name: string): Promise<void>;
  checkout(name: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createGitFixture(): Promise<GitFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-test-'));

  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileAsync('git', args, { cwd: dir, env: { ...process.env, ...env } });

  await git(['init', '--initial-branch=develop']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);

  let counter = 0;

  return {
    dir,
    async commit(message: string): Promise<string> {
      counter += 1;
      const fileName = `file-${counter}.txt`;
      await writeFile(join(dir, fileName), message);
      await git(['add', fileName]);
      const isoDate = new Date(2024, 0, counter).toISOString();
      await git(['commit', '-m', message], {
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_DATE: isoDate,
      });
      const { stdout } = await git(['rev-parse', 'HEAD']);
      return stdout.trim();
    },
    async tag(name: string, date: string): Promise<void> {
      await git(['tag', '-a', name, '-m', name], {
        GIT_COMMITTER_DATE: date,
      });
    },
    async branch(name: string): Promise<void> {
      await git(['branch', name]);
    },
    async checkout(name: string): Promise<void> {
      await git(['checkout', name]);
    },
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
