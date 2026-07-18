import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_SCHEMA_VERSION, emptyCache, loadCache, saveCache } from '../src/cache.js';

describe('cache — prFiles', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-cache-test-'));
    path = join(dir, '.gitflow-changelog-cache.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to an empty object on a freshly created cache', () => {
    expect(emptyCache().prFiles).toEqual({});
  });

  it('round-trips populated entries through save and load', async () => {
    const cache = emptyCache();
    cache.prFiles['1990'] = ['runtime/binding-kafka/src/main/java/Foo.java'];

    await saveCache(path, cache);
    const reloaded = await loadCache(path);

    expect(reloaded.prFiles).toEqual({ 1990: ['runtime/binding-kafka/src/main/java/Foo.java'] });
  });

  it('defaults to an empty object when reading a cache file written before prFiles existed', async () => {
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, lastEventId: 42, entries: { '1': { kind: 'pr', title: 't', login: 'octocat', bot: false, labels: [] } } }),
      'utf8',
    );

    const reloaded = await loadCache(path);

    expect(reloaded.prFiles).toEqual({});
    expect(reloaded.lastEventId).toBe(42);
  });
});

describe('cache — prBaseRefs / squashMergePrs', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-cache-test-'));
    path = join(dir, '.gitflow-changelog-cache.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to empty objects on a freshly created cache', () => {
    expect(emptyCache().prBaseRefs).toEqual({});
    expect(emptyCache().squashMergePrs).toEqual({});
  });

  it('round-trips populated entries through save and load', async () => {
    const cache = emptyCache();
    cache.prBaseRefs['174'] = 'feature/grpc-kafka';
    cache.squashMergePrs['feature/grpc-kafka'] = 225;

    await saveCache(path, cache);
    const reloaded = await loadCache(path);

    expect(reloaded.prBaseRefs).toEqual({ 174: 'feature/grpc-kafka' });
    expect(reloaded.squashMergePrs).toEqual({ 'feature/grpc-kafka': 225 });
  });

  it('defaults to empty objects when reading a cache file written before they existed', async () => {
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, lastEventId: 42, entries: {} }),
      'utf8',
    );

    const reloaded = await loadCache(path);

    expect(reloaded.prBaseRefs).toEqual({});
    expect(reloaded.squashMergePrs).toEqual({});
  });
});
