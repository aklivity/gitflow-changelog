import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const OverridesSchema = z.object({
  'hash-overrides': z.record(z.string(), z.string()).default({}),
});

// Keyed by the broken/recorded commit sha itself, not by (kind, number) —
// an issue auto-closed by a merged PR has its sha backfilled from that
// PR's own commit (see applyClosingReferences in drivers/github.ts), so
// the two entries always carry the identical sha and always want the
// identical replacement. A single sha-to-sha mapping covers both without
// requiring a human to enumerate every affected PR/issue number by hand.
export type HashOverrides = Map<string, string>;

export const EMPTY_OVERRIDES: HashOverrides = new Map();

export async function loadOverrides(path: string | undefined): Promise<HashOverrides> {
  if (!path)
  {
    return EMPTY_OVERRIDES;
  }

  let raw: string;
  try
  {
    raw = await readFile(path, 'utf8');
  }
  catch
  {
    return EMPTY_OVERRIDES;
  }

  const parsed = OverridesSchema.parse(parse(raw) ?? {});
  return new Map(Object.entries(parsed['hash-overrides']));
}

export function overrideFor(entry: { sha: string }, overrides: HashOverrides): string | undefined {
  return overrides.get(entry.sha);
}
