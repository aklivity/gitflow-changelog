import { describe, expect, it } from 'vitest';
import { computeTopology } from '../src/topology.js';

const SUPPORT_PATTERN = /^support\/(\d+)\.x$/;

describe('computeTopology', () => {
  it('gives mainline every support branch as a source', () => {
    const topology = computeTopology(['develop', 'support/1.x', 'support/2.x'], 'develop', SUPPORT_PATTERN);

    expect(topology.find((entry) => entry.target === 'develop')?.sources).toEqual(['support/1.x', 'support/2.x']);
  });

  it('gives support/N.x only lower-numbered support branches as sources', () => {
    const topology = computeTopology(['develop', 'support/1.x', 'support/2.x', 'support/3.x'], 'develop', SUPPORT_PATTERN);

    expect(topology.find((entry) => entry.target === 'support/2.x')?.sources).toEqual(['support/1.x']);
    expect(topology.find((entry) => entry.target === 'support/3.x')?.sources).toEqual(['support/1.x', 'support/2.x']);
  });

  it('gives the lowest surviving support branch no sources at all', () => {
    const topology = computeTopology(['develop', 'support/1.x', 'support/2.x'], 'develop', SUPPORT_PATTERN);

    expect(topology.find((entry) => entry.target === 'support/1.x')?.sources).toEqual([]);
  });

  it('sorts by numeric version, not lexicographically', () => {
    const topology = computeTopology(['develop', 'support/2.x', 'support/10.x'], 'develop', SUPPORT_PATTERN);

    expect(topology.find((entry) => entry.target === 'support/10.x')?.sources).toEqual(['support/2.x']);
  });

  it('adjusts automatically when a branch no longer exists, with nothing to edit', () => {
    // support/2.x removed — support/3.x's sources drop it without any config change.
    const topology = computeTopology(['develop', 'support/1.x', 'support/3.x'], 'develop', SUPPORT_PATTERN);

    expect(topology.find((entry) => entry.target === 'support/3.x')?.sources).toEqual(['support/1.x']);
  });

  it('omits mainline entirely when it does not exist among the given branches', () => {
    const topology = computeTopology(['support/1.x'], 'develop', SUPPORT_PATTERN);

    expect(topology.find((entry) => entry.target === 'develop')).toBeUndefined();
  });

  it('ignores a branch that matches neither mainline nor the support pattern', () => {
    const topology = computeTopology(['develop', 'support/1.x', 'feature/unrelated'], 'develop', SUPPORT_PATTERN);

    expect(topology.map((entry) => entry.target)).toEqual(['develop', 'support/1.x']);
  });
});
