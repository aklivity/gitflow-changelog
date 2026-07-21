import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ClassificationLevel, UpstreamConfig } from './types.js';

const RepoConfigSchema = z.object({
  'tag-pattern': z.string().optional(),
  'enhancement-labels': z.array(z.string()).optional(),
  'bug-labels': z.array(z.string()).optional(),
  'exclude-labels': z.array(z.string()).optional(),
  format: z.string().optional(),
  classification: ClassificationLevel.optional(),
  upstream: z.array(UpstreamConfig).optional(),
  // merge-report's branch-topology discovery — repo-wide policy the same
  // way tag-pattern is: which branch is the mainline, and what a
  // maintenance branch's name looks like (must capture the version as the
  // first group, compared numerically to order support branches).
  'mainline-branch': z.string().optional(),
  'support-branch-pattern': z.string().optional(),
  // merge-report false-positive filtering, applied cheapest-first before
  // falling through to exclude-labels/the ignore-list. exclude-paths has a
  // safe built-in default (see merge-report-config.ts); exclude-message-
  // patterns has none — those strings are a repo's own release-automation
  // convention, never assumed.
  'exclude-paths': z.array(z.string()).optional(),
  'exclude-message-patterns': z.array(z.string()).optional(),
  'subject-match': z.boolean().optional(),
  'subject-match-min-overlap': z.number().optional(),
  // Trusts an explicit `Ports: <sha>` trailer in a target-branch commit's
  // body as an outright match — the escape hatch for a port whose content
  // is a deliberate subset/superset of the original, which changes both
  // patch-id and subject enough that neither of the checks above can
  // recognize the pairing on their own.
  'ports-trailer': z.boolean().optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const EMPTY_REPO_CONFIG: RepoConfig = {};

// Policy settings (which tags get a section, how issues/PRs are categorized,
// which renderer to use) live in a file committed to the consuming repo,
// not as action inputs repeated at every call site. Unlike ref/token/cache
// paths, these don't vary by call site — a repo has one changelog policy,
// not one per prepare/finalize step or per branch — so a single file avoids
// the same setting drifting out of sync across N copies of a release
// workflow. Per-invocation settings still belong as action inputs.
export async function loadRepoConfig(gitDir: string, configPath: string): Promise<RepoConfig> {
  let raw: string;
  try
  {
    raw = await readFile(join(gitDir, configPath), 'utf8');
  }
  catch
  {
    return EMPTY_REPO_CONFIG;
  }

  return RepoConfigSchema.parse(parse(raw) ?? {});
}
