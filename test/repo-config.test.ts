import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRepoConfig } from '../src/repo-config.js';

describe('loadRepoConfig classification/upstream', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-repo-config-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to no classification and no upstream sources when unset', async () => {
    await writeFile(join(dir, '.gitflow-changelog.yml'), 'tag-pattern: foo\n', 'utf8');

    const config = await loadRepoConfig(dir, '.gitflow-changelog.yml');

    expect(config.classification).toBeUndefined();
    expect(config.upstream).toBeUndefined();
  });

  it('parses classification and a single upstream source', async () => {
    await writeFile(
      join(dir, '.gitflow-changelog.yml'),
      [
        'classification: none',
        'upstream:',
        '  - repo: aklivity/zilla',
        '    dependency-version-file: pom.xml',
        '    dependency-version-property: zilla.version',
        '    classification: maven',
      ].join('\n'),
      'utf8',
    );

    const config = await loadRepoConfig(dir, '.gitflow-changelog.yml');

    expect(config.classification).toBe('none');
    expect(config.upstream).toEqual([
      {
        repo: 'aklivity/zilla',
        'dependency-version-file': 'pom.xml',
        'dependency-version-property': 'zilla.version',
        classification: 'maven',
      },
    ]);
  });

  it('rejects an invalid classification level', async () => {
    await writeFile(join(dir, '.gitflow-changelog.yml'), 'classification: bogus\n', 'utf8');

    await expect(loadRepoConfig(dir, '.gitflow-changelog.yml')).rejects.toThrow();
  });

  it('rejects an upstream entry missing a required field', async () => {
    await writeFile(
      join(dir, '.gitflow-changelog.yml'),
      ['upstream:', '  - repo: aklivity/zilla', '    classification: path'].join('\n'),
      'utf8',
    );

    await expect(loadRepoConfig(dir, '.gitflow-changelog.yml')).rejects.toThrow();
  });
});
