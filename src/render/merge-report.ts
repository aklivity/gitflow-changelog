import { escapeTitle } from './default.js';
import type { MergeReportEntry, MergeReportResult } from '../merge-report.js';

export interface MergeReportRenderOptions {
  owner: string;
  repo: string;
  source: string;
}

function commitUrl(sha: string, options: MergeReportRenderOptions): string {
  return `https://github.com/${options.owner}/${options.repo}/commit/${sha}`;
}

function renderRow(entry: MergeReportEntry, options: MergeReportRenderOptions): string {
  const shortSha = entry.sha.slice(0, 7);
  const age = entry.ageDays === 1 ? '1 day' : `${entry.ageDays} days`;
  return `| ${age} | ${entry.target} | [\`${shortSha}\`](${commitUrl(entry.sha, options)}) | ${escapeTitle(entry.subject)} |`;
}

// No age cutoff, no truncation — every outstanding entry is listed,
// oldest-first, so the report is always the complete picture; any
// pass/fail behavior belongs to the caller (fail-on-outstanding-after-days),
// not to what's rendered here.
export function renderMergeReport(result: MergeReportResult, options: MergeReportRenderOptions): string {
  const lines = [`# Merge report: ${options.source}`, ''];

  if (result.outstanding.length === 0)
  {
    lines.push(`Nothing outstanding — every commit on \`${options.source}\` has an equivalent on every target branch.`);
    return `${lines.join('\n')}\n`;
  }

  lines.push('| Age | Target | Commit | Subject |', '|---|---|---|---|');
  for (const entry of result.outstanding)
  {
    lines.push(renderRow(entry, options));
  }

  return `${lines.join('\n')}\n`;
}
