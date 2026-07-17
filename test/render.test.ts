import { describe, expect, it } from 'vitest';
import { escapeTitle, render } from '../src/render/default.js';
import type { Entry, PlacementResult } from '../src/types.js';

const OPTIONS = { owner: 'acme', repo: 'widget' };

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
      allTags: [],
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

    expect(markdown).toContain('## [Unreleased](https://github.com/acme/widget/tree/HEAD)');
    expect(markdown).toContain('[Full Changelog](https://github.com/acme/widget/compare/v1.1.0...HEAD)');
    expect(markdown).toContain('**Implemented enhancements:**');
    expect(markdown).toContain('- Add \\[feature\\] [\\#10](https://github.com/acme/widget/pull/10)');

    expect(markdown).toContain('## [v1.1.0](https://github.com/acme/widget/tree/v1.1.0) (2024-02-01)');
    expect(markdown).toContain('[Full Changelog](https://github.com/acme/widget/compare/v1.0.0...v1.1.0)');
    expect(markdown).toContain('**Fixed bugs:**');
    expect(markdown).toContain('- Fix bug [\\#5](https://github.com/acme/widget/issues/5)');
    expect(markdown).toContain('**Merged pull requests:**');
    expect(markdown).toContain(
      '- Merged pr [\\#6](https://github.com/acme/widget/pull/6) ([dependabot[bot]](https://github.com/apps/dependabot))',
    );

    expect(markdown).toContain('## [v1.0.0](https://github.com/acme/widget/tree/v1.0.0) (2024-01-01)');
    expect(markdown).not.toContain('compare/undefined');
    expect(markdown).toContain('**Closed issues:**');
    expect(markdown).toContain('- Closed issue [\\#1](https://github.com/acme/widget/issues/1)');

    const v100Index = markdown.indexOf('## [v1.0.0]');
    expect(markdown.slice(v100Index, v100Index + 200)).not.toContain('Full Changelog');
  });

  it('inlines fold-in entries into the matching category section, tagged with owner/repo#N', () => {
    const placement: PlacementResult = {
      dropped: [],
      unresolved: [],
      allTags: [{ name: 'v1.1.0', sha: 'aaa', date: '2024-02-01T00:00:00+00:00' }],
      buckets: [
        {
          tag: { name: 'v1.1.0', sha: 'aaa', date: '2024-02-01T00:00:00+00:00' },
          entries: [entry({ number: 6, kind: 'pr', category: 'issue', title: 'Our own PR' })],
        },
      ],
    };
    const foldIns = new Map([
      [
        'v1.1.0',
        [
          {
            repo: 'acme/engine',
            fromVersion: '1.2.5',
            toVersion: '1.2.6',
            entries: [entry({ number: 2080, kind: 'pr', category: 'issue', title: 'export telemetry events' })],
          },
        ],
      ],
    ]);

    const markdown = render(placement, OPTIONS, foldIns);

    expect(markdown).toContain('_Includes [engine 1.2.5–1.2.6](https://github.com/acme/engine/compare/1.2.5...1.2.6)._');
    expect(markdown).toContain('**Merged pull requests:**');
    expect(markdown).toContain('- Our own PR [\\#6](https://github.com/acme/widget/pull/6)');
    expect(markdown).toContain(
      '- export telemetry events [acme/engine\\#2080](https://github.com/acme/engine/pull/2080)',
    );

    const sectionIndex = markdown.indexOf('**Merged pull requests:**');
    const ownIndex = markdown.indexOf('Our own PR');
    const foldInIndex = markdown.indexOf('export telemetry events');
    expect(sectionIndex).toBeLessThan(ownIndex);
    expect(ownIndex).toBeLessThan(foldInIndex);
  });

  it('renders "up to" when there is no fromVersion (first release absorbed)', () => {
    const placement: PlacementResult = {
      dropped: [],
      unresolved: [],
      allTags: [],
      buckets: [{ tag: null, entries: [] }],
    };
    const foldIns = new Map([
      [
        null,
        [{ repo: 'acme/engine', fromVersion: undefined, toVersion: '1.0.0', entries: [] }],
      ],
    ]);

    const markdown = render(placement, OPTIONS, foldIns);

    expect(markdown).toContain('_Includes [engine up to 1.0.0](https://github.com/acme/engine/tree/1.0.0)._');
  });

  // Linked the same way regardless of the upstream's org relative to this
  // repo's — the per-entry owner/repo#N links already point cross-org with
  // no such check, so the fold-in note doesn't special-case it either.
  it('links the fold-in note even when the upstream is in a different GitHub org', () => {
    const placement: PlacementResult = {
      dropped: [],
      unresolved: [],
      allTags: [],
      buckets: [{ tag: null, entries: [] }],
    };
    const foldIns = new Map([
      [
        null,
        [{ repo: 'other-org/engine', fromVersion: '1.2.5', toVersion: '1.2.6', entries: [] }],
      ],
    ]);

    const markdown = render(placement, OPTIONS, foldIns);

    expect(markdown).toContain(
      '_Includes [engine 1.2.5–1.2.6](https://github.com/other-org/engine/compare/1.2.5...1.2.6)._',
    );
  });
});
