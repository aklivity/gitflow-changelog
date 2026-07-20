import { writeFile } from 'node:fs/promises';
import * as core from '@actions/core';
import { toMergeReportOptions } from './merge-report-config.js';
import { mergeReport } from './merge-report.js';
import { renderMergeReport } from './render/merge-report.js';

async function main(): Promise<void> {
  const options = await toMergeReportOptions({
    owner: core.getInput('owner', { required: true }),
    repo: core.getInput('repo', { required: true }),
    token: core.getInput('token', { required: true }),
    gitDir: core.getInput('git-dir') || undefined,
    cachePath: core.getInput('cache-path') || undefined,
    mergeIgnorePath: core.getInput('merge-ignore-path') || undefined,
    configPath: core.getInput('config-path') || undefined,
    excludeLabels: core.getInput('exclude-labels') || undefined,
    mainlineBranch: core.getInput('mainline-branch') || undefined,
    supportBranchPattern: core.getInput('support-branch-pattern') || undefined,
    target: core.getInput('target') || undefined,
    sources: core.getInput('sources') || undefined,
  });

  const outputPath = core.getInput('output-path') || 'merge-report.md';
  const failAfterDays = Number(core.getInput('fail-on-outstanding-after-days') || '14');

  const result = await mergeReport(options);
  const markdown = renderMergeReport(result, { owner: options.owner, repo: options.repo });

  await writeFile(outputPath, markdown, 'utf8');
  core.setOutput('merge-report-path', outputPath);

  // core.summary is the only channel here that's actually visible without a
  // human going looking for it — a job summary alone still isn't pushed to
  // anyone, but the run's own pass/fail *is* something GitHub notifies on
  // by default for a scheduled workflow, so failing past the threshold is
  // what turns "the report exists" into "someone finds out."
  await core.summary.addHeading('merge-report').addRaw(markdown).write();

  const stale = result.outstanding.filter((entry) => entry.ageDays > failAfterDays);
  if (stale.length > 0)
  {
    core.setFailed(
      `${stale.length} commit(s) have been outstanding for more than ${failAfterDays} days ` +
      `without an equivalent on their target branch — see the job summary for the full list.`,
    );
  }
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
