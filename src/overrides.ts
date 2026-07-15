import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const OverridesSchema = z.object({
  'pr-overrides': z.record(z.string(), z.string()).default({}),
  'issue-overrides': z.record(z.string(), z.string()).default({}),
});

export interface HashOverrides {
  prOverrides: Map<number, string>;
  issueOverrides: Map<number, string>;
}

export const EMPTY_OVERRIDES: HashOverrides = {
  prOverrides: new Map(),
  issueOverrides: new Map(),
};

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
  return {
    prOverrides: new Map(Object.entries(parsed['pr-overrides']).map(([number, sha]) => [Number(number), sha])),
    issueOverrides: new Map(
      Object.entries(parsed['issue-overrides']).map(([number, sha]) => [Number(number), sha]),
    ),
  };
}

export function overrideFor(entry: { number: number; kind: 'issue' | 'pr' }, overrides: HashOverrides): string | undefined {
  const table = entry.kind === 'pr' ? overrides.prOverrides : overrides.issueOverrides;
  return table.get(entry.number);
}
