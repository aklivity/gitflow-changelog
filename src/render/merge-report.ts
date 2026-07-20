import { escapeTitle } from './default.js';
import type { MergeReportEntry, MergeReportResult } from '../merge-report.js';

export interface MergeReportRenderOptions {
  owner: string;
  repo: string;
}

function commitUrl(sha: string, options: MergeReportRenderOptions): string {
  return `https://github.com/${options.owner}/${options.repo}/commit/${sha}`;
}

function renderRow(entry: MergeReportEntry, options: MergeReportRenderOptions): string {
  const shortSha = entry.sha.slice(0, 7);
  const age = entry.ageDays === 1 ? '1 day' : `${entry.ageDays} days`;
  return `| ${age} | ${entry.source} | [\`${shortSha}\`](${commitUrl(entry.sha, options)}) | ${escapeTitle(entry.subject)} |`;
}

// No age cutoff, no truncation — every outstanding entry is listed,
// oldest-first, so the report is always the complete picture; any
// pass/fail behavior belongs to the caller (fail-on-outstanding-after-days),
// not to what's rendered here. Every discovered target gets its own
// section, including one with nothing outstanding — an explicit "clean" is
// the point (e.g. the lowest support branch, which has no sources at all
// and is trivially clean by definition), not something worth omitting.
export function renderMergeReport(result: MergeReportResult, options: MergeReportRenderOptions): string {
  const lines = ['# Merge report', ''];

  for (const { target, sources } of result.topology)
  {
    const entries = result.outstanding.filter((entry) => entry.target === target);
    lines.push(`## ${target}`, '');

    if (sources.length === 0)
    {
      lines.push('No sources to check — nothing can be outstanding here.', '');
      continue;
    }
    if (entries.length === 0)
    {
      lines.push(`Nothing outstanding from ${sources.join(', ')}.`, '');
      continue;
    }

    lines.push('| Age | Source | Commit | Subject |', '|---|---|---|---|');
    for (const entry of entries)
    {
      lines.push(renderRow(entry, options));
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
