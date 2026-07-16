import { describe, expect, it } from 'vitest';
import { classifyPaths, DEFAULT_CLASSIFICATION_PATTERNS, featurePathsFromModules } from '../src/classification.js';
import type { MavenModule } from '../src/maven.js';

describe('classifyPaths', () => {
  it('classifies as feature when any path matches a feature pattern', () => {
    expect(classifyPaths(['runtime/binding-kafka/src/main/java/Foo.java'])).toBe('feature');
  });

  it('classifies as feature even when the diff also touches excluded paths', () => {
    const paths = [
      'runtime/binding-kafka/src/main/java/Foo.java',
      '.github/workflows/build.yml',
      'NOTICE',
    ];
    expect(classifyPaths(paths)).toBe('feature');
  });

  it('classifies as test-only when every path is under a test directory', () => {
    const paths = [
      'runtime/binding-kafka/src/test/java/FooTest.java',
      'runtime/binding-kafka/src/test/java/BarTest.java',
    ];
    expect(classifyPaths(paths)).toBe('test-only');
  });

  it('classifies as feature when a specs/ path is touched, even under a test-shaped subpath', () => {
    // specs/** has no src/main restriction (matching the design doc's own
    // example patterns) — spec scripts and their ITs are both "real" for
    // this repo family, unlike runtime/**/src/test/**.
    expect(classifyPaths(['specs/binding-kafka.spec/src/test/java/BarIT.java'])).toBe('feature');
  });

  it('classifies as noise when no path matches feature or test patterns', () => {
    const paths = ['.github/workflows/build.yml', 'NOTICE', 'docs/README.md'];
    expect(classifyPaths(paths)).toBe('noise');
  });

  it('classifies as noise when there are no changed paths at all', () => {
    expect(classifyPaths([])).toBe('noise');
  });

  it('matches specs/** and incubator/**/src/main/** as feature by default', () => {
    expect(classifyPaths(['specs/binding-kafka.spec/src/main/scripts/foo.rpt'])).toBe('feature');
    expect(classifyPaths(['incubator/binding-new/src/main/java/Foo.java'])).toBe('feature');
  });

  it('respects custom patterns over the defaults', () => {
    const patterns = { featurePaths: ['lib/**'], testPaths: ['test/**'] };
    expect(classifyPaths(['runtime/binding-kafka/src/main/java/Foo.java'], patterns)).toBe('noise');
    expect(classifyPaths(['lib/foo.ts'], patterns)).toBe('feature');
    expect(classifyPaths(['test/foo.test.ts'], patterns)).toBe('test-only');
  });

  it('mixed test and noise paths (no feature match) classify as noise, not test-only', () => {
    const paths = ['runtime/binding-kafka/src/test/java/FooTest.java', 'README.md'];
    expect(classifyPaths(paths)).toBe('noise');
  });

  it('does not mutate the default patterns object across calls', () => {
    classifyPaths(['runtime/binding-kafka/src/main/java/Foo.java']);
    expect(DEFAULT_CLASSIFICATION_PATTERNS.featurePaths).toEqual([
      'runtime/**/src/main/**',
      'specs/**',
      'incubator/**/src/main/**',
    ]);
  });
});

describe('featurePathsFromModules', () => {
  it('derives a src/main glob per discovered module directory, nested or top-level alike', () => {
    const modules: MavenModule[] = [
      { dir: 'runtime/binding-kafka', artifactId: 'binding-kafka', dependencies: [] },
      { dir: 'manager', artifactId: 'manager', dependencies: [] },
    ];
    expect(featurePathsFromModules(modules)).toEqual([
      'runtime/binding-kafka/src/main/**',
      'manager/src/main/**',
    ]);
  });

  it('a change under a top-level module\'s own src/main now classifies as feature, with no runtime/ knowledge', () => {
    const modules: MavenModule[] = [{ dir: 'manager', artifactId: 'manager', dependencies: [] }];
    const patterns = { featurePaths: featurePathsFromModules(modules), testPaths: DEFAULT_CLASSIFICATION_PATTERNS.testPaths };
    expect(classifyPaths(['manager/src/main/java/io/example/Foo.java'], patterns)).toBe('feature');
  });

  it('a module\'s own test-only sources still classify as test-only, not blanket feature', () => {
    const modules: MavenModule[] = [{ dir: 'specs/binding-kafka.spec', artifactId: 'binding-kafka.spec', dependencies: [] }];
    const patterns = { featurePaths: featurePathsFromModules(modules), testPaths: DEFAULT_CLASSIFICATION_PATTERNS.testPaths };
    expect(classifyPaths(['specs/binding-kafka.spec/src/test/java/BarIT.java'], patterns)).toBe('test-only');
  });

  it('handles a module at the checkout root (empty dir) without a leading slash', () => {
    const modules: MavenModule[] = [{ dir: '', artifactId: 'root', dependencies: [] }];
    expect(featurePathsFromModules(modules)).toEqual(['src/main/**']);
  });
});
