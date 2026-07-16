import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser();

interface PomDependency {
  groupId?: string;
  artifactId?: string;
}

interface PomProject {
  artifactId?: string;
  properties?: Record<string, unknown>;
  dependencies?: { dependency?: PomDependency | PomDependency[] };
}

function parsePom(pomXml: string): PomProject {
  const doc = parser.parse(pomXml) as { project?: PomProject };
  return doc.project ?? {};
}

function asList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined)
  {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// Reads a property value (e.g. <zilla.version>1.2.6</zilla.version>) from
// a pom.xml's <properties> block — the mechanism zilla-plus (and any
// similar downstream repo) uses to pin an upstream dependency version.
export function readDependencyVersion(pomXml: string, property: string): string | undefined {
  const value = parsePom(pomXml).properties?.[property];
  return value === undefined ? undefined : String(value);
}

// A module's own declared artifactId — never assume directory name equals
// artifactId, even when it does by convention.
export function readModuleArtifactId(pomXml: string): string | undefined {
  return parsePom(pomXml).artifactId;
}

// Every artifactId this pom declares a dependency on under the given
// groupId, e.g. every io.aklivity.zilla:* artifact a runtime module
// actually builds against.
export function readDependencyArtifactIds(pomXml: string, groupId: string): string[] {
  return asList(parsePom(pomXml).dependencies?.dependency)
    .filter((dependency) => dependency.groupId === groupId)
    .map((dependency) => dependency.artifactId)
    .filter((artifactId): artifactId is string => artifactId !== undefined);
}

const SKIP_DIRS = new Set(['.git', 'target', 'node_modules']);

async function findPomFiles(dir: string): Promise<string[]> {
  let entries;
  try
  {
    entries = await readdir(dir, { withFileTypes: true });
  }
  catch
  {
    return [];
  }

  const pomPaths: string[] = [];
  for (const entry of entries)
  {
    if (entry.isDirectory())
    {
      if (!SKIP_DIRS.has(entry.name))
      {
        pomPaths.push(...await findPomFiles(join(dir, entry.name)));
      }
    }
    else if (entry.name === 'pom.xml')
    {
      pomPaths.push(join(dir, entry.name));
    }
  }
  return pomPaths;
}

// The union of `<groupId>:*` artifacts declared across every pom.xml in a
// checkout, bundling/packaging poms included — a downstream repo that
// ships an upstream module purely by bundling it into a packaging pom
// (e.g. a Docker image's dependency list) rather than through a compile-
// time dependency in one of its own feature modules still genuinely ships
// that module, and the fold-in feature needs to recognize that as real
// usage, not filter it out as unrelated.
export async function readDependencySet(gitDir: string, groupId: string): Promise<Set<string>> {
  const pomPaths = await findPomFiles(gitDir);

  const artifactIds = new Set<string>();
  for (const pomPath of pomPaths)
  {
    let pomXml: string;
    try
    {
      pomXml = await readFile(pomPath, 'utf8');
    }
    catch
    {
      continue;
    }
    for (const artifactId of readDependencyArtifactIds(pomXml, groupId))
    {
      artifactIds.add(artifactId);
    }
  }
  return artifactIds;
}

// Maps each `runtime/<dir>/pom.xml` to that module's own declared
// artifactId, for translating a changed file path back to the artifact it
// belongs to.
export async function readModuleArtifactIds(gitDir: string): Promise<Map<string, string>> {
  const runtimeDir = join(gitDir, 'runtime');
  let moduleNames: string[];
  try
  {
    moduleNames = await readdir(runtimeDir);
  }
  catch
  {
    return new Map();
  }

  const artifactIdsByDir = new Map<string, string>();
  for (const moduleName of moduleNames)
  {
    const pomPath = join(runtimeDir, moduleName, 'pom.xml');
    let pomXml: string;
    try
    {
      pomXml = await readFile(pomPath, 'utf8');
    }
    catch
    {
      continue;
    }
    const artifactId = readModuleArtifactId(pomXml);
    if (artifactId)
    {
      artifactIdsByDir.set(moduleName, artifactId);
    }
  }
  return artifactIdsByDir;
}

// The runtime/<dir> a changed path belongs to, or undefined if the path
// isn't under runtime/ at all.
export function moduleDirFromPath(path: string): string | undefined {
  const prefix = 'runtime/';
  if (!path.startsWith(prefix))
  {
    return undefined;
  }
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}
