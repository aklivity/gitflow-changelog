import type { PathClassification } from './types.js';

export interface ClassificationPatterns {
  featurePaths: string[];
  testPaths: string[];
}

// Matches the layout shared by the repos this ships for today (runtime/,
// specs/, incubator/) — override via config for a differently-shaped repo.
export const DEFAULT_CLASSIFICATION_PATTERNS: ClassificationPatterns = {
  featurePaths: ['runtime/**/src/main/**', 'specs/**', 'incubator/**/src/main/**'],
  testPaths: ['**/src/test/**'],
};

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

function matchesAny(path: string, patterns: string[]): boolean {
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
