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

const ZILLA_PLUS_ROOT_POM = `<?xml version="1.0"?>
<project>
  <artifactId>zilla-plus</artifactId>
  <properties>
    <zilla.version>1.2.6</zilla.version>
  </properties>
</project>
`;

function bindingKafkaProxyPom(): string {
  return `<?xml version="1.0"?>
<project>
  <artifactId>binding-kafka-proxy</artifactId>
  <dependencies>
    <dependency>
      <groupId>io.aklivity.zilla</groupId>
      <artifactId>binding-kafka</artifactId>
    </dependency>
    <dependency>
      <groupId>io.aklivity.zilla</groupId>
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

function guardApiKeysPom(): string {
  return `<?xml version="1.0"?>
<project>
  <artifactId>guard-api-keys</artifactId>
  <dependencies>
    <dependency>
      <groupId>io.aklivity.zilla</groupId>
      <artifactId>engine</artifactId>
    </dependency>
  </dependencies>
</project>
`;
}

describe('readDependencyVersion', () => {
  it('reads a property value from the properties block', () => {
    expect(readDependencyVersion(ZILLA_PLUS_ROOT_POM, 'zilla.version')).toBe('1.2.6');
  });

  it('returns undefined for a missing property', () => {
    expect(readDependencyVersion(ZILLA_PLUS_ROOT_POM, 'missing.property')).toBeUndefined();
  });
});

describe('readModuleArtifactId', () => {
  it("reads the module's own artifactId", () => {
    expect(readModuleArtifactId(bindingKafkaProxyPom())).toBe('binding-kafka-proxy');
  });
});

describe('readDependencyArtifactIds', () => {
  it('returns only artifactIds under the given groupId', () => {
    expect(readDependencyArtifactIds(bindingKafkaProxyPom(), 'io.aklivity.zilla')).toEqual([
      'binding-kafka',
      'engine',
    ]);
  });

  it('returns an empty array when there are no matching dependencies', () => {
    expect(readDependencyArtifactIds(bindingKafkaProxyPom(), 'com.nonexistent')).toEqual([]);
  });
});

describe('moduleDirFromPath', () => {
  it('extracts the runtime module directory from a changed path', () => {
    expect(moduleDirFromPath('runtime/binding-kafka/src/main/java/Foo.java')).toBe('binding-kafka');
  });

  it('returns the bare module name for a path with no deeper nesting', () => {
    expect(moduleDirFromPath('runtime/binding-kafka')).toBe('binding-kafka');
  });

  it('returns undefined for a path outside runtime/', () => {
    expect(moduleDirFromPath('specs/binding-kafka.spec/pom.xml')).toBeUndefined();
  });
});

describe('readDependencySet and readModuleArtifactIds (filesystem)', () => {
  let gitDir: string;

  beforeEach(async () => {
    gitDir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-maven-test-'));
    await mkdir(join(gitDir, 'runtime', 'binding-kafka-proxy'), { recursive: true });
    await mkdir(join(gitDir, 'runtime', 'guard-api-keys'), { recursive: true });
    await mkdir(join(gitDir, 'cloud', 'docker-image'), { recursive: true });
    await writeFile(join(gitDir, 'runtime', 'binding-kafka-proxy', 'pom.xml'), bindingKafkaProxyPom(), 'utf8');
    await writeFile(join(gitDir, 'runtime', 'guard-api-keys', 'pom.xml'), guardApiKeysPom(), 'utf8');
    // A bundling pom referencing far more artifacts than any single module
    // actually depends on — must never be scanned, since runtime/*/pom.xml
    // is the only glob read.
    await writeFile(
      join(gitDir, 'cloud', 'docker-image', 'pom.xml'),
      `<?xml version="1.0"?>
<project>
  <artifactId>docker-image</artifactId>
  <dependencies>
    <dependency><groupId>io.aklivity.zilla</groupId><artifactId>binding-http</artifactId></dependency>
  </dependencies>
</project>
`,
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(gitDir, { recursive: true, force: true });
  });

  it('unions dependency artifactIds across every runtime/*/pom.xml, excluding docker-image', async () => {
    const dependencySet = await readDependencySet(gitDir, 'io.aklivity.zilla');
    expect(dependencySet).toEqual(new Set(['binding-kafka', 'engine']));
  });

  it('maps each runtime module directory to its own declared artifactId', async () => {
    const artifactIdsByDir = await readModuleArtifactIds(gitDir);
    expect(artifactIdsByDir.get('binding-kafka-proxy')).toBe('binding-kafka-proxy');
    expect(artifactIdsByDir.get('guard-api-keys')).toBe('guard-api-keys');
  });

  it('returns empty results when there is no runtime/ directory at all', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-maven-empty-'));
    try
    {
      expect(await readDependencySet(emptyDir, 'io.aklivity.zilla')).toEqual(new Set());
      expect(await readModuleArtifactIds(emptyDir)).toEqual(new Map());
    }
    finally
    {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
