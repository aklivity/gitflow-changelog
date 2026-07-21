import type { MavenModule } from './maven.js';
import type { PathClassification } from './types.js';

export interface ClassificationPatterns {
  featurePaths: string[];
  testPaths: string[];
}

// Fallback for when no Maven module index is available at all — a non-
// Maven upstream, or a 'path'-level classification, which doesn't resolve
// modules in the first place. Whenever a module index *is* available (any
// 'maven'-classified upstream), featurePathsFromModules below is strictly
// more precise and should be preferred; override via config for a
// differently-shaped non-Maven repo.
export const DEFAULT_CLASSIFICATION_PATTERNS: ClassificationPatterns = {
  featurePaths: ['runtime/**/src/main/**', 'specs/**', 'incubator/**/src/main/**'],
  testPaths: ['**/src/test/**'],
};

// Derives feature-path globs directly from the upstream's own discovered
// Maven modules (see maven.ts's indexMavenModules) instead of assuming a
// fixed top-level layout — works identically for a module nested under
// runtime/, or one living at the checkout root entirely (e.g. zilla's own
// `manager`), with no hardcoded directory-name knowledge at all. Restricted
// to each module's own src/main, the same semantics
// DEFAULT_CLASSIFICATION_PATTERNS already applied to runtime/incubator — a
// module's own test-only sources still classify as test-only/noise like
// any other module's, never blanket-included just because of which module
// they happen to sit in.
export function featurePathsFromModules(modules: MavenModule[]): string[] {
  return modules.map((module) => (module.dir ? `${module.dir}/src/main/**` : 'src/main/**'));
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1)
  {
    const char = pattern[i];
    if (char === '*')
    {
      if (pattern[i + 1] === '*')
      {
        source += '.*';
        i += 1;
      }
      else
      {
        source += '[^/]*';
      }
    }
    else if (char === '?')
    {
      source += '[^/]';
    }
    else if ('.+^${}()|[]\\'.includes(char))
    {
      source += `\\${char}`;
    }
    else
    {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

// A PR classifies as `feature` the moment ANY changed path matches a
// feature pattern, even if the same diff also touches excluded paths —
// inclusive-OR toward "real," not requiring every path clean. Only when
// every path is test-only, or no path matches either list, do the
// test-only/noise outcomes apply.
export function classifyPaths(
  paths: string[],
  patterns: ClassificationPatterns = DEFAULT_CLASSIFICATION_PATTERNS,
): PathClassification {
  if (paths.length === 0)
  {
    return 'noise';
  }
  if (paths.some((path) => matchesAny(path, patterns.featurePaths)))
  {
    return 'feature';
  }
  if (paths.every((path) => matchesAny(path, patterns.testPaths)))
  {
    return 'test-only';
  }
  return 'noise';
}
