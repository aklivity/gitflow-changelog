import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { toMergeReportOptions } from './merge-report-config.js';
import { mergeReport } from './merge-report.js';
import { renderMergeReport } from './render/merge-report.js';

export async function runMergeReportCli(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      token: { type: 'string' },
      source: { type: 'string' },
      targets: { type: 'string' },
      'git-dir': { type: 'string' },
      'cache-path': { type: 'string' },
      'merge-ignore-path': { type: 'string' },
      'config-path': { type: 'string' },
      'exclude-labels': { type: 'string' },
      output: { type: 'string', default: 'merge-report.md' },
    },
  });

  const options = await toMergeReportOptions({
    owner: values.owner,
    repo: values.repo,
    token: values.token ?? process.env.GITHUB_TOKEN,
    source: values.source,
    targets: values.targets,
    gitDir: values['git-dir'],
    cachePath: values['cache-path'],
    mergeIgnorePath: values['merge-ignore-path'],
    configPath: values['config-path'],
    excludeLabels: values['exclude-labels'],
  });

  const result = await mergeReport(options);
  const markdown = renderMergeReport(result, { owner: options.owner, repo: options.repo, source: options.source });

  await writeFile(values.output as string, markdown, 'utf8');
}
