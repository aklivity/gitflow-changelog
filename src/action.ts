import { writeFile } from 'node:fs/promises';
import * as core from '@actions/core';
import { toRunOptions } from './config.js';
import { run } from './run.js';

async function main(): Promise<void> {
  const options = toRunOptions({
    owner: core.getInput('owner', { required: true }),
    repo: core.getInput('repo', { required: true }),
    token: core.getInput('token', { required: true }),
    ref: core.getInput('ref') || undefined,
    gitDir: core.getInput('git-dir') || undefined,
    cachePath: core.getInput('cache-path') || undefined,
    overridesPath: core.getInput('overrides-path') || undefined,
    tagPattern: core.getInput('tag-pattern') || undefined,
    enhancementLabels: core.getInput('enhancement-labels') || undefined,
    bugLabels: core.getInput('bug-labels') || undefined,
    excludeLabels: core.getInput('exclude-labels') || undefined,
    format: core.getInput('format') || undefined,
  });

  const outputPath = core.getInput('output-path') || 'CHANGELOG.md';

  const { markdown, warnings } = await run(options);

  for (const warning of warnings)
  {
    core.warning(warning);
  }

  await writeFile(outputPath, markdown, 'utf8');
  core.setOutput('changelog-path', outputPath);
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
