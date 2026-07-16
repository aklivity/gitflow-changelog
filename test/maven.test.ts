import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MavenModule } from '../src/maven.js';
import {
  expandTransitiveDependencySet,
  indexMavenModules,
  readDependencyArtifactIds,
  readDependencyEdges,
  readDependencySet,
  readDependencyVersion,
  readModuleArtifactId,
  resolveModule,
} from '../src/maven.js';

const APP_ROOT_POM = `<?xml version="1.0"?>
<project>
  <artifactId>app</artifactId>
  <properties>
    <engine.version>1.2.6</engine.version>
  </properties>
</project>
`;

function moduleAPom(): string {
  return `<?xml version="1.0"?>
<project>
  <artifactId>module-a</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.acme.engine</groupId>
      <artifactId>module-b</artifactId>
    </dependency>
    <dependency>
      <groupId>com.acme.engine</groupId>
      <artifactId>engine</artifactId>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
    </dependency>
  </dependencies>
</project>
`;
}

function moduleCPom(): string {
  return `<?xml version="1.0"?>
<project>
  <artifactId>module-c</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.acme.engine</groupId>
      <artifactId>engine</artifactId>
    </dependency>
  </dependencies>
</project>
`;
}

function moduleWithScopesPom(): string {
  return `<?xml version="1.0"?>
<project>
  <artifactId>module-scopes</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.acme.engine</groupId>
      <artifactId>default-scope-dep</artifactId>
    </dependency>
    <dependency>
      <groupId>com.acme.engine</groupId>
      <artifactId>provided-dep</artifactId>
      <scope>provided</scope>
    </dependency>
    <dependency>
      <groupId>com.acme.engine</groupId>
      <artifactId>runtime-dep</artifactId>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>com.acme.engine</groupId>
      <artifactId>test-dep</artifactId>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.acme.engine</groupId>
      <artifactId>system-dep</artifactId>
      <scope>system</scope>
    </dependency>
  </dependencies>
</project>
`;
}

describe('readDependencyVersion', () => {
  it('reads a property value from the properties block', () => {
    expect(readDependencyVersion(APP_ROOT_POM, 'engine.version')).toBe('1.2.6');
  });

  it('returns undefined for a missing property', () => {
    expect(readDependencyVersion(APP_ROOT_POM, 'missing.property')).toBeUndefined();
  });
});

describe('readModuleArtifactId', () => {
  it("reads the module's own artifactId", () => {
    expect(readModuleArtifactId(moduleAPom())).toBe('module-a');
  });
});

describe('readDependencyEdges', () => {
  it('resolves an unspecified scope to compile, matching Maven\'s own default', () => {
    const edges = readDependencyEdges(moduleWithScopesPom(), 'com.acme.engine');
    expect(edges).toContainEqual({ artifactId: 'default-scope-dep', scope: 'compile' });
  });

  it('preserves provided and runtime scope as-is', () => {
    const edges = readDependencyEdges(moduleWithScopesPom(), 'com.acme.engine');
    expect(edges).toContainEqual({ artifactId: 'provided-dep', scope: 'provided' });
    expect(edges).toContainEqual({ artifactId: 'runtime-dep', scope: 'runtime' });
  });

  it('excludes test and system scoped dependencies — never pulled in by a dependent', () => {
    const edges = readDependencyEdges(moduleWithScopesPom(), 'com.acme.engine');
    expect(edges.map((edge) => edge.artifactId)).not.toContain('test-dep');
    expect(edges.map((edge) => edge.artifactId)).not.toContain('system-dep');
  });
});

describe('readDependencyArtifactIds', () => {
  it('returns only artifactIds under the given groupId', () => {
    expect(readDependencyArtifactIds(moduleAPom(), 'com.acme.engine')).toEqual([
      'module-b',
      'engine',
    ]);
  });

  it('returns an empty array when there are no matching dependencies', () => {
    expect(readDependencyArtifactIds(moduleAPom(), 'com.nonexistent')).toEqual([]);
  });

  it('excludes test/system scope but keeps provided/runtime/default', () => {
    expect(readDependencyArtifactIds(moduleWithScopesPom(), 'com.acme.engine')).toEqual([
      'default-scope-dep',
      'provided-dep',
      'runtime-dep',
    ]);
  });
});

describe('resolveModule', () => {
  const modules: MavenModule[] = [
    { dir: 'runtime/module-a', artifactId: 'module-a', dependencies: [] },
    { dir: 'runtime/module-a/nested', artifactId: 'module-a-nested', dependencies: [] },
    { dir: 'manager', artifactId: 'manager', dependencies: [] },
    { dir: '', artifactId: 'root', dependencies: [] },
  ];

  it('resolves a path under runtime/<module>', () => {
    expect(resolveModule('runtime/module-a/src/main/java/Foo.java', modules)?.artifactId).toBe('module-a');
  });

  it('resolves a path under a top-level (non-runtime/) module directory', () => {
    expect(resolveModule('manager/src/main/java/Foo.java', modules)?.artifactId).toBe('manager');
  });

  it('picks the longest (most specific) matching module directory', () => {
    expect(resolveModule('runtime/module-a/nested/src/main/java/Bar.java', modules)?.artifactId).toBe('module-a-nested');
  });

  it('falls back to a checkout-root module only when nothing more specific matches', () => {
    expect(resolveModule('cloud/docker-image/pom.xml', modules)?.artifactId).toBe('root');
  });

  it('returns undefined when no module (including no root module) matches', () => {
    const noRoot = modules.filter((module) => module.dir !== '');
    expect(resolveModule('cloud/docker-image/pom.xml', noRoot)).toBeUndefined();
  });
});

describe('expandTransitiveDependencySet', () => {
  const modules: MavenModule[] = [
    { dir: 'a', artifactId: 'a', dependencies: [{ artifactId: 'b', scope: 'compile' }] },
    {
      dir: 'b',
      artifactId: 'b',
      dependencies: [
        { artifactId: 'b.spec', scope: 'provided' },
        { artifactId: 'c', scope: 'runtime' },
      ],
    },
    { dir: 'b.spec', artifactId: 'b.spec', dependencies: [] },
    { dir: 'c', artifactId: 'c', dependencies: [] },
  ];

  it('expands through compile and runtime edges to the full transitive closure', () => {
    expect(expandTransitiveDependencySet(new Set(['a']), modules)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('does not propagate through a provided-scoped edge — e.g. a module\'s own .spec codegen sibling', () => {
    const result = expandTransitiveDependencySet(new Set(['a']), modules);
    expect(result.has('b.spec')).toBe(false);
  });

  it('is a no-op for an artifactId not present in the module index', () => {
    expect(expandTransitiveDependencySet(new Set(['unknown-artifact']), modules)).toEqual(new Set(['unknown-artifact']));
  });

  it('does not loop forever on a dependency cycle', () => {
    const cyclic: MavenModule[] = [
      { dir: 'x', artifactId: 'x', dependencies: [{ artifactId: 'y', scope: 'compile' }] },
      { dir: 'y', artifactId: 'y', dependencies: [{ artifactId: 'x', scope: 'compile' }] },
    ];
    expect(expandTransitiveDependencySet(new Set(['x']), cyclic)).toEqual(new Set(['x', 'y']));
  });
});

describe('readDependencySet, indexMavenModules (filesystem)', () => {
  let gitDir: string;

  beforeEach(async () => {
    gitDir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-maven-test-'));
    await mkdir(join(gitDir, 'runtime', 'module-a'), { recursive: true });
    await mkdir(join(gitDir, 'runtime', 'module-c'), { recursive: true });
    await mkdir(join(gitDir, 'manager'), { recursive: true });
    await mkdir(join(gitDir, 'cloud', 'docker-image'), { recursive: true });
    await writeFile(join(gitDir, 'runtime', 'module-a', 'pom.xml'), moduleAPom(), 'utf8');
    await writeFile(join(gitDir, 'runtime', 'module-c', 'pom.xml'), moduleCPom(), 'utf8');
    // A top-level module outside runtime/ entirely — e.g. zilla's own
    // `manager` — must be discovered exactly like a runtime/* module, with
    // no hardcoded directory-depth assumption.
    await writeFile(
      join(gitDir, 'manager', 'pom.xml'),
      `<?xml version="1.0"?>
<project>
  <artifactId>manager</artifactId>
  <dependencies>
    <dependency><groupId>com.acme.engine</groupId><artifactId>engine</artifactId></dependency>
  </dependencies>
</project>
`,
      'utf8',
    );
    // A bundling pom that ships a module purely by listing it as a
    // dependency (e.g. a Docker image's pom), never referenced by any of
    // the repo's own runtime/*/pom.xml files — must still be scanned,
    // since bundling it in is genuine real usage.
    await writeFile(
      join(gitDir, 'cloud', 'docker-image', 'pom.xml'),
      `<?xml version="1.0"?>
<project>
  <artifactId>docker-image</artifactId>
  <dependencies>
    <dependency><groupId>com.acme.engine</groupId><artifactId>module-x</artifactId></dependency>
  </dependencies>
</project>
`,
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(gitDir, { recursive: true, force: true });
  });

  it('unions dependency artifactIds across every pom.xml in the repo, bundling poms included', async () => {
    const dependencySet = await readDependencySet(gitDir, 'com.acme.engine');
    expect(dependencySet).toEqual(new Set(['module-b', 'engine', 'module-x']));
  });

  it('skips .git, target, and node_modules directories', async () => {
    await mkdir(join(gitDir, '.git', 'modules'), { recursive: true });
    await mkdir(join(gitDir, 'runtime', 'module-a', 'target'), { recursive: true });
    await mkdir(join(gitDir, 'node_modules', 'some-pkg'), { recursive: true });
    const decoyPom = `<?xml version="1.0"?>
<project>
  <artifactId>decoy</artifactId>
  <dependencies>
    <dependency><groupId>com.acme.engine</groupId><artifactId>decoy-artifact</artifactId></dependency>
  </dependencies>
</project>
`;
    await writeFile(join(gitDir, '.git', 'modules', 'pom.xml'), decoyPom, 'utf8');
    await writeFile(join(gitDir, 'runtime', 'module-a', 'target', 'pom.xml'), decoyPom, 'utf8');
    await writeFile(join(gitDir, 'node_modules', 'some-pkg', 'pom.xml'), decoyPom, 'utf8');

    const dependencySet = await readDependencySet(gitDir, 'com.acme.engine');
    expect(dependencySet.has('decoy-artifact')).toBe(false);
  });

  it('indexes every module by its real pom.xml directory, runtime/* and top-level alike', async () => {
    const modules = await indexMavenModules(gitDir, 'com.acme.engine');
    const byDir = new Map(modules.map((module) => [module.dir, module.artifactId]));
    expect(byDir.get('runtime/module-a')).toBe('module-a');
    expect(byDir.get('runtime/module-c')).toBe('module-c');
    expect(byDir.get('manager')).toBe('manager');
    expect(byDir.get('cloud/docker-image')).toBe('docker-image');
  });

  it("captures each module's own same-groupId dependency edges with scope", async () => {
    const modules = await indexMavenModules(gitDir, 'com.acme.engine');
    const moduleA = modules.find((module) => module.dir === 'runtime/module-a');
    expect(moduleA?.dependencies).toEqual([
      { artifactId: 'module-b', scope: 'compile' },
      { artifactId: 'engine', scope: 'compile' },
    ]);
  });

  it('a changed path under the top-level manager module resolves via the index, not a runtime/ assumption', async () => {
    const modules = await indexMavenModules(gitDir, 'com.acme.engine');
    expect(resolveModule('manager/src/main/java/io/example/Foo.java', modules)?.artifactId).toBe('manager');
  });

  it('returns empty results when there is no maven content at all', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-maven-empty-'));
    try
    {
      expect(await readDependencySet(emptyDir, 'com.acme.engine')).toEqual(new Set());
      expect(await indexMavenModules(emptyDir, 'com.acme.engine')).toEqual([]);
    }
    finally
    {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
