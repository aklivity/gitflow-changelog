import { describe, expect, it } from 'vitest';
import { parsePortsTrailers, portsTrailerMatches } from '../src/ports-trailer.js';

describe('parsePortsTrailers', () => {
  it('extracts a full-length sha from a trailer line', () => {
    const body = 'chore(docker-image): add command-logs dependency\n\nPorts: 5a7e45294812fad54d63f9b2e88f226fec32179b\n';
    expect(parsePortsTrailers(body)).toEqual(['5a7e45294812fad54d63f9b2e88f226fec32179b']);
  });

  it('extracts an abbreviated sha', () => {
    expect(parsePortsTrailers('fix: something\n\nPorts: 5a7e452\n')).toEqual(['5a7e452']);
  });

  it('lowercases the extracted value', () => {
    expect(parsePortsTrailers('Ports: 5A7E452')).toEqual(['5a7e452']);
  });

  it('collects more than one trailer', () => {
    const body = 'chore: fold in two fixes\n\nPorts: 5a7e452\nPorts: 8a39066\n';
    expect(parsePortsTrailers(body)).toEqual(['5a7e452', '8a39066']);
  });

  it('ignores a mention of "Ports:" that is not at the start of a line', () => {
    expect(parsePortsTrailers('fix: something, see Ports: 5a7e452 for context')).toEqual([]);
  });

  it('ignores a value shorter than 7 hex characters', () => {
    expect(parsePortsTrailers('Ports: abc12')).toEqual([]);
  });

  it('ignores a value that is not hex', () => {
    expect(parsePortsTrailers('Ports: not-a-sha')).toEqual([]);
  });

  it('returns an empty array for a body with no trailer', () => {
    expect(parsePortsTrailers('fix: ordinary commit\n\nNo trailers here.')).toEqual([]);
  });
});

describe('portsTrailerMatches', () => {
  it('matches when a trailer value equals the full candidate sha', () => {
    const sha = '5a7e45294812fad54d63f9b2e88f226fec32179b';
    expect(portsTrailerMatches(sha, [sha])).toBe(true);
  });

  it('matches when a trailer value is an abbreviated prefix of the candidate sha', () => {
    expect(portsTrailerMatches('5a7e45294812fad54d63f9b2e88f226fec32179b', ['5a7e452'])).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(portsTrailerMatches('5A7E45294812FAD54D63F9B2E88F226FEC32179B', ['5a7e452'])).toBe(true);
  });

  it('does not match an unrelated sha', () => {
    expect(portsTrailerMatches('5a7e45294812fad54d63f9b2e88f226fec32179b', ['8a39066'])).toBe(false);
  });

  it('does not match against an empty trailer list', () => {
    expect(portsTrailerMatches('5a7e45294812fad54d63f9b2e88f226fec32179b', [])).toBe(false);
  });
});
