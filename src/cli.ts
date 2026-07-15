#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { toRunOptions } from './config.js';
import { run } from './run.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      token: { type: 'string' },
      ref: { type: 'string' },
      'git-dir': { type: 'string' },
      'cache-path': { type: 'string' },
      'overrides-path': { type: 'string' },
      'tag-pattern': { type: 'string' },
      'enhancement-labels': { type: 'string' },
      'bug-labels': { type: 'string' },
      'exclude-labels': { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string', default: 'CHANGELOG.md' },
    },
  });

  const options = toRunOptions({
    owner: values.owner,
    repo: values.repo,
    token: values.token ?? process.env.GITHUB_TOKEN,
    ref: values.ref,
    gitDir: values['git-dir'],
    cachePath: values['cache-path'],
    overridesPath: values['overrides-path'],
    tagPattern: values['tag-pattern'],
    enhancementLabels: values['enhancement-labels'],
    bugLabels: values['bug-labels'],
    excludeLabels: values['exclude-labels'],
    format: values.format,
  });

  const { markdown, warnings } = await run(options);

  for (const warning of warnings)
  {
    process.stderr.write(`warning: ${warning}\n`);
  }

  await writeFile(values.output as string, markdown, 'utf8');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
