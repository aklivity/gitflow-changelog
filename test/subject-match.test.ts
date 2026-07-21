import { describe, expect, it } from 'vitest';
import { fileOverlap, normalizeSubject } from '../src/subject-match.js';

describe('normalizeSubject', () => {
  it('strips a single trailing PR-number group', () => {
    expect(normalizeSubject('fix: apply route topic rewrite (#962)')).toBe('fix: apply route topic rewrite');
  });

  it('strips a chain of trailing PR-number groups', () => {
    expect(normalizeSubject('fix: apply route topic rewrite (#962) (#989)')).toBe('fix: apply route topic rewrite');
  });

  it('strips a trailing "(backport to support/N.x)" annotation', () => {
    expect(normalizeSubject('feat: support SASL/OAUTHBEARER external termination (backport to support/1.x)')).toBe(
      'feat: support SASL/OAUTHBEARER external termination',
    );
  });

  it('strips a bare trailing "(backport)" annotation with no target branch named', () => {
    expect(normalizeSubject('fix: enforce per-binding API version narrowing (backport)')).toBe(
      'fix: enforce per-binding API version narrowing',
    );
  });

  it('strips a PR-number group and a backport annotation together, in either order', () => {
    expect(normalizeSubject('fix: reset padding once per request (backport to support/1.x) (#1032)')).toBe(
      'fix: reset padding once per request',
    );
  });

  it('leaves a subject with no trailing group unchanged', () => {
    expect(normalizeSubject('Prepare release 1.3.8-rc1')).toBe('Prepare release 1.3.8-rc1');
  });

  it('does not strip a PR-number-like token that is not trailing', () => {
    expect(normalizeSubject('fix: correct #962 handling in the router (#989)')).toBe(
      'fix: correct #962 handling in the router',
    );
  });
});

describe('fileOverlap', () => {
  it('returns 1 for identical file sets', () => {
    expect(fileOverlap(['a.ts', 'b.ts'], ['a.ts', 'b.ts'])).toBe(1);
  });

  it('returns 1 for two empty sets', () => {
    expect(fileOverlap([], [])).toBe(1);
  });

  it('returns 0 for disjoint file sets', () => {
    expect(fileOverlap(['a.ts'], ['b.ts'])).toBe(0);
  });

  it('computes Jaccard similarity for a partial overlap', () => {
    // intersection {a,b} = 2, union {a,b,c,d} = 4 -> 0.5
    expect(fileOverlap(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'b.ts', 'd.ts'])).toBe(0.5);
  });

  it('is order-independent and dedupes repeated entries', () => {
    expect(fileOverlap(['a.ts', 'a.ts', 'b.ts'], ['b.ts', 'a.ts'])).toBe(1);
  });
});
