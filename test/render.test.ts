import { describe, expect, it } from 'vitest';
import { escapeTitle, render } from '../src/render/default.js';
import type { Entry, PlacementResult } from '../src/types.js';

const OPTIONS = { owner: 'aklivity', repo: 'zilla' };

function entry(overrides: Partial<Entry>): Entry {
  return {
    number: 1,
    kind: 'issue',
    category: 'issue',
    title: 'title',
    login: 'octocat',
    bot: false,
    sha: 'deadbeef',
    ...overrides,
  };
}

describe('escapeTitle', () => {
  it('escapes markdown special characters', () => {
    expect(escapeTitle('fix [foo] (bar) *baz* _qux_ #1')).toBe(
      'fix \\[foo\\] \\(bar\\) \\*baz\\* \\_qux\\_ \\#1',
    );
  });

  it('leaves inline code spans untouched', () => {
    expect(escapeTitle('use `foo[bar]` in config')).toBe('use `foo[bar]` in config');
  });
});

describe('render', () => {
  it('renders sections in gcg-compatible order with escaping and author links', () => {
    const placement: PlacementResult = {
      dropped: [],
      unresolved: [],
      buckets: [
        {
          tag: null,
          entries: [entry({ number: 10, kind: 'pr', category: 'enhancement', title: 'Add [feature]' })],
        },
        {
          tag: { name: 'v1.1.0', sha: 'aaa', date: '2024-02-01T00:00:00+00:00' },
          entries: [
            entry({ number: 5, kind: 'issue', category: 'bug', title: 'Fix bug' }),
            entry({ number: 6, kind: 'pr', category: 'issue', title: 'Merged pr', login: 'dependabot[bot]', bot: true }),
          ],
        },
        {
          tag: { name: 'v1.0.0', sha: 'bbb', date: '2024-01-01T00:00:00+00:00' },
          entries: [entry({ number: 1, kind: 'issue', category: 'issue', title: 'Closed issue' })],
        },
      ],
    };

    const markdown = render(placement, OPTIONS);

    expect(markdown).toContain('## [Unreleased](https://github.com/aklivity/zilla/tree/HEAD)');
    expect(markdown).toContain('[Full Changelog](https://github.com/aklivity/zilla/compare/v1.1.0...HEAD)');
    expect(markdown).toContain('**Implemented enhancements:**');
    expect(markdown).toContain('- Add \\[feature\\] [\\#10](https://github.com/aklivity/zilla/pull/10)');

    expect(markdown).toContain('## [v1.1.0](https://github.com/aklivity/zilla/tree/v1.1.0) (2024-02-01)');
    expect(markdown).toContain('[Full Changelog](https://github.com/aklivity/zilla/compare/v1.0.0...v1.1.0)');
    expect(markdown).toContain('**Fixed bugs:**');
    expect(markdown).toContain('- Fix bug [\\#5](https://github.com/aklivity/zilla/issues/5)');
    expect(markdown).toContain('**Merged pull requests:**');
    expect(markdown).toContain(
      '- Merged pr [\\#6](https://github.com/aklivity/zilla/pull/6) ([dependabot[bot]](https://github.com/apps/dependabot))',
    );

    expect(markdown).toContain('## [v1.0.0](https://github.com/aklivity/zilla/tree/v1.0.0) (2024-01-01)');
    expect(markdown).not.toContain('compare/undefined');
    expect(markdown).toContain('**Closed issues:**');
    expect(markdown).toContain('- Closed issue [\\#1](https://github.com/aklivity/zilla/issues/1)');

    const v100Index = markdown.indexOf('## [v1.0.0]');
    expect(markdown.slice(v100Index, v100Index + 200)).not.toContain('Full Changelog');
  });
});
