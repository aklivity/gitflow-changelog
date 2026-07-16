import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  moduleDirFromPath,
  readDependencyArtifactIds,
  readDependencySet,
  readDependencyVersion,
  readModuleArtifactId,
  readModuleArtifactIds,
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
});

describe('moduleDirFromPath', () => {
  it('extracts the runtime module directory from a changed path', () => {
    expect(moduleDirFromPath('runtime/module-a/src/main/java/Foo.java')).toBe('module-a');
  });

  it('returns the bare module name for a path with no deeper nesting', () => {
    expect(moduleDirFromPath('runtime/module-a')).toBe('module-a');
  });

  it('returns undefined for a path outside runtime/', () => {
    expect(moduleDirFromPath('specs/module-a.spec/pom.xml')).toBeUndefined();
  });
});

describe('readDependencySet and readModuleArtifactIds (filesystem)', () => {
  let gitDir: string;

  beforeEach(async () => {
    gitDir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-maven-test-'));
    await mkdir(join(gitDir, 'runtime', 'module-a'), { recursive: true });
    await mkdir(join(gitDir, 'runtime', 'module-c'), { recursive: true });
    await mkdir(join(gitDir, 'cloud', 'docker-image'), { recursive: true });
    await writeFile(join(gitDir, 'runtime', 'module-a', 'pom.xml'), moduleAPom(), 'utf8');
    await writeFile(join(gitDir, 'runtime', 'module-c', 'pom.xml'), moduleCPom(), 'utf8');
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

  it('maps each runtime module directory to its own declared artifactId', async () => {
    const artifactIdsByDir = await readModuleArtifactIds(gitDir);
    expect(artifactIdsByDir.get('module-a')).toBe('module-a');
    expect(artifactIdsByDir.get('module-c')).toBe('module-c');
  });

  it('returns empty results when there is no runtime/ directory at all', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-maven-empty-'));
    try
    {
      expect(await readDependencySet(emptyDir, 'com.acme.engine')).toEqual(new Set());
      expect(await readModuleArtifactIds(emptyDir)).toEqual(new Map());
    }
    finally
    {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
