import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMergeIgnore } from '../src/merge-ignore.js';

describe('loadMergeIgnore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-merge-ignore-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty map when no path is given', async () => {
    expect(await loadMergeIgnore(undefined)).toEqual(new Map());
  });

  it('returns an empty map when the file does not exist', async () => {
    expect(await loadMergeIgnore(join(dir, 'missing.yml'))).toEqual(new Map());
  });

  it('parses sha-keyed entries with their reason', async () => {
    const path = join(dir, '.gitflow-changelog-merge-ignore.yml');
    await writeFile(
      path,
      [
        'merge-ignore:',
        '  a18bdc1c3db328f6f66f53ac84e1eec4f360ce38: "branch-scoped SNAPSHOT reset, not applicable to develop"',
      ].join('\n'),
      'utf8',
    );

    const ignore = await loadMergeIgnore(path);

    expect(ignore.get('a18bdc1c3db328f6f66f53ac84e1eec4f360ce38')).toBe(
      'branch-scoped SNAPSHOT reset, not applicable to develop',
    );
  });
});
