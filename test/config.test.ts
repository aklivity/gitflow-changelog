import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toRunOptions } from '../src/config.js';

describe('toRunOptions config-file precedence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-config-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to built-in defaults when neither input nor file set anything', async () => {
    const options = await toRunOptions({ owner: 'o', repo: 'r', token: 't', gitDir: dir });

    expect(options.tagPattern).toEqual(/.*/);
    expect(options.enhancementLabels).toEqual(['enhancement']);
    expect(options.bugLabels).toEqual(['bug']);
    expect(options.excludeLabels).toEqual(['duplicate', 'invalid', 'wontfix']);
    expect(options.format).toBe('default');
  });

  it('uses the config file when no action input is set', async () => {
    await writeFile(
      join(dir, '.gitflow-changelog.yml'),
      [
        "tag-pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
        'enhancement-labels: [feature]',
        'bug-labels: [defect]',
        'exclude-labels: [wontfix]',
        'format: default',
      ].join('\n'),
      'utf8',
    );

    const options = await toRunOptions({ owner: 'o', repo: 'r', token: 't', gitDir: dir });

    expect(options.tagPattern).toEqual(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(options.enhancementLabels).toEqual(['feature']);
    expect(options.bugLabels).toEqual(['defect']);
    expect(options.excludeLabels).toEqual(['wontfix']);
  });

  it('lets an explicit action input override the config file', async () => {
    await writeFile(join(dir, '.gitflow-changelog.yml'), "tag-pattern: '^v'\n", 'utf8');

    const options = await toRunOptions({ owner: 'o', repo: 'r', token: 't', gitDir: dir, tagPattern: '^[0-9]' });

    expect(options.tagPattern).toEqual(/^[0-9]/);
  });

  it('honors a custom config-path', async () => {
    await writeFile(join(dir, 'custom.yml'), 'format: default\ntag-pattern: foo\n', 'utf8');

    const options = await toRunOptions({ owner: 'o', repo: 'r', token: 't', gitDir: dir, configPath: 'custom.yml' });

    expect(options.tagPattern).toEqual(/foo/);
  });
});
