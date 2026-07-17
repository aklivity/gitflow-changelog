import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findGroupVersionSource, readDependencyVersion } from './maven.js';
import { extractGithubRepo, fetchPom } from './registry.js';
import type { ExplicitUpstreamConfig, MavenDiscoveredUpstreamConfig, UpstreamConfig } from './types.js';

export interface ResolveUpstreamResult {
  // undefined when discovery couldn't produce a usable config — the caller
  // skips this upstream entry for this run rather than failing the whole
  // changelog over one unreachable/misconfigured dependency.
  config: ExplicitUpstreamConfig | undefined;
  warning?: string;
}

function isMavenDiscovered(upstream: UpstreamConfig): upstream is MavenDiscoveredUpstreamConfig {
  return 'maven' in upstream;
}

// Turns a {maven: {groupId, artifactId}} upstream entry into the explicit
// {repo, dependency-version-file, dependency-version-property,
// classification: 'maven'} shape the rest of the fold-in pipeline already
// expects — resolving both pieces from Maven metadata that already
// exists, rather than requiring a human to have hand-derived and copied
// them into config (see the design rationale on MavenDiscoveredUpstreamConfig
// in types.ts). An already-explicit entry passes through unchanged, with
// zero extra I/O.
export async function resolveUpstreamConfig(upstream: UpstreamConfig, gitDir: string): Promise<ResolveUpstreamResult> {
  if (!isMavenDiscovered(upstream))
  {
    return { config: upstream };
  }

  const { groupId, artifactId } = upstream.maven;
  const label = `${groupId}:${artifactId}`;

  const source = await findGroupVersionSource(gitDir, groupId);
  if (source === undefined)
  {
    return {
      config: undefined,
      warning: `upstream maven ${label}: no dependency under groupId "${groupId}" with a property-pinned ` +
        'version was found in this checkout; skipping. (A literal, non-property <version> isn\'t supported for ' +
        'discovery yet — add an explicit repo/dependency-version-file/dependency-version-property entry instead.)',
    };
  }

  const pomXml = await readFile(join(gitDir, source.file), 'utf8');
  const version = readDependencyVersion(pomXml, source.property);
  if (version === undefined)
  {
    return {
      config: undefined,
      warning: `upstream maven ${label}: property "${source.property}" was found in ${source.file} once but ` +
        'could not re-read; skipping.',
    };
  }

  const upstreamPomXml = await fetchPom(groupId, artifactId, version);
  const repo = upstreamPomXml === undefined ? undefined : extractGithubRepo(upstreamPomXml);
  if (repo === undefined)
  {
    return {
      config: undefined,
      warning: `upstream maven ${label}: could not discover a github.com <scm> URL from its published pom at ` +
        `version ${version}; skipping. (Non-GitHub or missing <scm> upstreams aren't supported yet — this tool's ` +
        'driver is GitHub-API-based.)',
    };
  }

  return {
    config: {
      repo,
      'dependency-version-file': source.file,
      'dependency-version-property': source.property,
      classification: 'maven',
      'maven-group-id': groupId,
    },
  };
}
