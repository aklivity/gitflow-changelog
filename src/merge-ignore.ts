import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const MergeIgnoreSchema = z.object({
  'merge-ignore': z.record(z.string(), z.string()).default({}),
});

// Keyed by the broken/unmatched commit sha itself, value is a required
// human-written reason — a commit-message convention (`build(deps):`,
// "backport of #NNNN") isn't a reliable enough signal to filter on: some
// genuine backports carry no marker at all, and message conventions drift
// over time in ways a checked-in, reviewed file doesn't.
export type MergeIgnore = Map<string, string>;

export const EMPTY_MERGE_IGNORE: MergeIgnore = new Map();

export async function loadMergeIgnore(path: string | undefined): Promise<MergeIgnore> {
  if (!path)
  {
    return EMPTY_MERGE_IGNORE;
  }

  let raw: string;
  try
  {
    raw = await readFile(path, 'utf8');
  }
  catch
  {
    return EMPTY_MERGE_IGNORE;
  }

  const parsed = MergeIgnoreSchema.parse(parse(raw) ?? {});
  return new Map(Object.entries(parsed['merge-ignore']));
}
