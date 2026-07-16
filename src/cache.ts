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
  // Keyed by PR number. A merged PR's file list never changes, so unlike
  // `entries` (kept fresh via `lastEventId`) this never needs invalidation —
  // only ever grows. Optional + defaulted rather than added via a
  // schemaVersion bump, so existing cache files without it still parse and
  // don't force a full cold-start re-walk of the events cache.
  prFiles: z.record(z.string(), z.array(z.string())).optional().default({}),
});
export type CacheFile = z.infer<typeof CacheFileSchema>;

export function emptyCache(): CacheFile {
  return { schemaVersion: CACHE_SCHEMA_VERSION, lastEventId: 0, entries: {}, prFiles: {} };
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
