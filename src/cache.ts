import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

// Schema version is baked into the cache file itself (in addition to the
// actions/cache *key*, which callers should also version) so a format
// change cold-starts cleanly instead of silently misreading stale data.
export const CACHE_SCHEMA_VERSION = 1;

const CacheEntrySchema = z.object({
  kind: z.enum(['issue', 'pr']),
  title: z.string(),
  login: z.string(),
  bot: z.boolean(),
  labels: z.array(z.string()),
  sha: z.string().optional(),
});
export type CacheEntry = z.infer<typeof CacheEntrySchema>;

const CacheFileSchema = z.object({
  schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
  lastEventId: z.number().int().nonnegative(),
  entries: z.record(z.string(), CacheEntrySchema),
});
export type CacheFile = z.infer<typeof CacheFileSchema>;

export function emptyCache(): CacheFile {
  return { schemaVersion: CACHE_SCHEMA_VERSION, lastEventId: 0, entries: {} };
}

export async function loadCache(path: string): Promise<CacheFile> {
  let raw: string;
  try
  {
    raw = await readFile(path, 'utf8');
  }
  catch
  {
    return emptyCache();
  }

  const parsed = CacheFileSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : emptyCache();
}

export async function saveCache(path: string, cache: CacheFile): Promise<void> {
  await writeFile(path, JSON.stringify(cache, null, 2), 'utf8');
}
