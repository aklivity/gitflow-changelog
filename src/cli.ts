#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { toRunOptions } from './config.js';
import { runMergeReportCli } from './merge-report-cli.js';
import { run } from './run.js';

async function main(): Promise<void> {
  // `merge-report` is a sibling subcommand, not a flag — anything else
  // (including no positional arg at all) keeps today's flat-flags
  // changelog behavior unchanged, so existing callers see no difference.
  if (process.argv[2] === 'merge-report')
  {
    await runMergeReportCli(process.argv.slice(3));
    return;
  }

  const { values } = parseArgs({
    options: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      token: { type: 'string' },
      ref: { type: 'string' },
      'git-dir': { type: 'string' },
      'cache-path': { type: 'string' },
      'overrides-path': { type: 'string' },
      'config-path': { type: 'string' },
      'upstream-cache-dir': { type: 'string' },
      'tag-pattern': { type: 'string' },
      'enhancement-labels': { type: 'string' },
      'bug-labels': { type: 'string' },
      'exclude-labels': { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string', default: 'CHANGELOG.md' },
    },
  });

  const options = await toRunOptions({
    owner: values.owner,
    repo: values.repo,
    token: values.token ?? process.env.GITHUB_TOKEN,
    ref: values.ref,
    gitDir: values['git-dir'],
    cachePath: values['cache-path'],
    overridesPath: values['overrides-path'],
    configPath: values['config-path'],
    upstreamCacheDir: values['upstream-cache-dir'],
    tagPattern: values['tag-pattern'],
    enhancementLabels: values['enhancement-labels'],
    bugLabels: values['bug-labels'],
    excludeLabels: values['exclude-labels'],
    format: values.format,
  });

  const { markdown, warnings, completenessIssues } = await run(options);

  for (const warning of warnings)
  {
    process.stderr.write(`warning: ${warning}\n`);
  }

  // Written regardless of completenessIssues below — see action.ts for why.
  await writeFile(values.output as string, markdown, 'utf8');

  if (completenessIssues.length > 0)
  {
    const details = completenessIssues.map((issue) => `#${issue.number} (${issue.sha})`).join(', ');
    process.stderr.write(
      `error: changelog completeness check failed: git history shows ${completenessIssues.length} merged PR(s) ` +
        `in this release that never appeared in the fetched entries — ${details}. ${values.output as string} was ` +
        'still written with whatever entries were found, but it is missing these.\n',
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
