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
