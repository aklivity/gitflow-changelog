import { describe, expect, it } from 'vitest';
import { classifyPaths, DEFAULT_CLASSIFICATION_PATTERNS } from '../src/classification.js';

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
