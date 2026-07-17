import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser();

interface PomDependency {
  groupId?: string;
  artifactId?: string;
  scope?: string;
  version?: unknown;
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

export interface DependencyEdge {
  artifactId: string;
  // Defaults to 'compile' when unspecified, matching Maven's own default.
  scope: string;
  // Raw <version> text as written in the pom — e.g. "${zilla.version}" or a
  // literal "1.2.6" — undefined when the dependency carries no explicit
  // version at all (inherited from a parent's dependencyManagement). Used
  // by findGroupVersionSource to discover which property pins a groupId's
  // version, rather than requiring it to be hand-specified in config.
  version?: string;
}

// A dependency scoped 'test' or 'system' is never pulled in by whatever
// depends on the declaring module — Maven doesn't resolve it onto that
// consumer's classpath, so neither should this analysis. Every other scope
// (compile, runtime, provided, and plain unscoped/default) represents a
// real, resolved dependency of the declaring module itself; the further
// question of whether that dependency also propagates on to the declaring
// module's own consumers is a separate, narrower rule — see
// expandTransitiveDependencySet.
const EXCLUDED_SCOPES = new Set(['test', 'system']);

// Every same-groupId dependency edge a pom.xml declares, with scope
// resolved to Maven's own default ('compile') when the <scope> element is
// absent. Test/system-scoped dependencies are dropped here, at the source,
// so no caller needs to re-derive that exclusion itself.
export function readDependencyEdges(pomXml: string, groupId: string): DependencyEdge[] {
  return asList(parsePom(pomXml).dependencies?.dependency)
    .filter((dependency) => dependency.groupId === groupId && dependency.artifactId !== undefined)
    .map((dependency) => ({
      artifactId: dependency.artifactId as string,
      scope: dependency.scope ?? 'compile',
      version: dependency.version === undefined ? undefined : String(dependency.version),
    }))
    .filter((edge) => !EXCLUDED_SCOPES.has(edge.scope));
}

// Every artifactId this pom declares a dependency on under the given
// groupId, e.g. every io.aklivity.zilla:* artifact a runtime module
// actually builds against.
export function readDependencyArtifactIds(pomXml: string, groupId: string): string[] {
  return readDependencyEdges(pomXml, groupId).map((edge) => edge.artifactId);
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

const PROPERTY_PLACEHOLDER = /^\$\{([^}]+)\}$/;

export interface GroupVersionSource {
  // Repo-relative, POSIX-separated — the pom.xml that defines the property
  // pinning this groupId's version, not necessarily the one declaring the
  // dependency itself (e.g. a submodule depending on ${zilla.version}, a
  // property defined only at the repo root).
  file: string;
  property: string;
}

// Discovers which property pins every io.aklivity.<x>-style groupId's
// version in a checkout, instead of requiring a human to already know and
// hand-specify it in config (dependency-version-file/-property). Every
// artifact under one groupId is assumed to share one version — true for
// every Aklivity repo (e.g. zilla-plus depends on many io.aklivity.zilla:*
// artifacts, all via the single ${zilla.version} property) — so the first
// dependency edge found under groupId with a property-form <version> (as
// opposed to a literal, or none at all — inherited from a parent's
// dependencyManagement, unsupported here) settles it. The property itself
// is looked up in the declaring pom's own <properties> first, then the
// repo root pom.xml as a fallback, matching the real two-level inheritance
// this convention actually relies on (declaring modules rarely redefine a
// shared version property locally; it's normally set once at the root and
// inherited).
export async function findGroupVersionSource(gitDir: string, groupId: string): Promise<GroupVersionSource | undefined> {
  const pomPaths = await findPomFiles(gitDir);
  const rootPomPath = join(gitDir, 'pom.xml');
  const rootPomXml = await readFile(rootPomPath, 'utf8').catch(() => undefined);

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

    for (const edge of readDependencyEdges(pomXml, groupId))
    {
      const property = edge.version === undefined ? undefined : PROPERTY_PLACEHOLDER.exec(edge.version)?.[1];
      if (property === undefined)
      {
        continue;
      }

      const file = relative(gitDir, pomPath).split(sep).join('/');
      if (readDependencyVersion(pomXml, property) !== undefined)
      {
        return { file, property };
      }
      if (rootPomXml !== undefined && readDependencyVersion(rootPomXml, property) !== undefined)
      {
        return { file: 'pom.xml', property };
      }
    }
  }
  return undefined;
}

export interface MavenModule {
  // Relative to the checkout root, POSIX-separated (e.g. "runtime/binding-tcp"
  // or "manager" for a top-level module) — never assumes any particular
  // parent directory, so a module living outside runtime/ is discovered
  // exactly the same way as one inside it.
  dir: string;
  artifactId: string;
  // This module's own same-groupId dependency edges, for walking the
  // upstream's internal module graph — see expandTransitiveDependencySet.
  dependencies: DependencyEdge[];
}

// Indexes every Maven module in a checkout — real module discovery from
// wherever a pom.xml actually sits, not a guessed directory convention like
// "one level under runtime/". Reuses the same unrestricted tree walk
// readDependencySet already relies on.
export async function indexMavenModules(gitDir: string, groupId: string): Promise<MavenModule[]> {
  const pomPaths = await findPomFiles(gitDir);

  const modules: MavenModule[] = [];
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
    const artifactId = readModuleArtifactId(pomXml);
    if (artifactId === undefined)
    {
      continue;
    }
    const dir = relative(gitDir, dirname(pomPath)).split(sep).join('/');
    modules.push({ dir, artifactId, dependencies: readDependencyEdges(pomXml, groupId) });
  }
  return modules;
}

// Resolves a changed file path to the Maven module that owns it — the
// indexed module whose own directory is the longest (most specific)
// matching prefix of the path, i.e. actual nearest-enclosing-module
// ownership rather than a hardcoded layout assumption. A module at the
// checkout root (dir === '') matches every path, so it only ever wins when
// nothing more specific does.
export function resolveModule(path: string, modules: MavenModule[]): MavenModule | undefined {
  let best: MavenModule | undefined;
  for (const module of modules)
  {
    const prefix = module.dir ? `${module.dir}/` : '';
    if (path.startsWith(prefix) && (best === undefined || module.dir.length > best.dir.length))
    {
      best = module;
    }
  }
  return best;
}

// A dependency scoped 'provided' (or 'test'/'system', already excluded from
// DependencyEdge entirely) is resolved for the declaring module itself but
// never propagates on to whatever depends on that module — this is Maven's
// own documented scope-transitivity rule, not a heuristic. Only 'compile'
// and 'runtime' edges carry a dependency's relevance forward transitively.
const PROPAGATING_SCOPES = new Set(['compile', 'runtime']);

// Expands a downstream repo's directly-declared upstream artifactIds to
// their full transitive closure, using the upstream's own internal module
// graph: if the downstream depends on module A, and A depends on module B
// via a propagating (compile/runtime) edge, a change to B is exactly as
// relevant as a change to A. A provided-scoped edge (e.g. a runtime module's
// reference to its own codegen-only .spec sibling) stops the walk there,
// matching Maven's real transitivity semantics with no naming convention or
// build-plugin awareness required.
export function expandTransitiveDependencySet(direct: Set<string>, modules: MavenModule[]): Set<string> {
  const byArtifactId = new Map(modules.map((module) => [module.artifactId, module]));
  const result = new Set(direct);
  const queue = [...direct];

  while (queue.length > 0)
  {
    const artifactId = queue.shift() as string;
    const module = byArtifactId.get(artifactId);
    if (module === undefined)
    {
      continue;
    }
    for (const edge of module.dependencies)
    {
      if (!PROPAGATING_SCOPES.has(edge.scope) || result.has(edge.artifactId))
      {
        continue;
      }
      result.add(edge.artifactId);
      queue.push(edge.artifactId);
    }
  }
  return result;
}
