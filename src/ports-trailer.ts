// Pure trailer-parsing/matching logic — kept separate from git.ts's
// scanPortsTrailers (the git IO half) so the match predicate can be unit
// tested without a git fixture, mirroring subject-match.ts's split.
//
// Convention: a port commit that deliberately changes a fix's title or
// content enough that neither patch-id nor subject-match can recognize the
// pairing carries a `Ports: <sha>` line in its commit body, asserting it
// carries forward a specific source-branch commit. This is a human
// assertion, not a heuristic — unlike subject-match, a trailer match is
// trusted outright, with no file-overlap confirmation layered on top.
const TRAILER_LINE = /^Ports:\s*([0-9a-fA-F]{7,40})\s*$/;

export function parsePortsTrailers(body: string): string[] {
  const values: string[] = [];
  for (const line of body.split('\n'))
  {
    const match = TRAILER_LINE.exec(line.trim());
    if (match)
    {
      values.push(match[1].toLowerCase());
    }
  }
  return values;
}

// A trailer value may be an abbreviated sha — the same convention `git log
// <prefix>` itself accepts — so a prefix match against the candidate's full
// sha is what "asserts" the same commit.
export function portsTrailerMatches(candidateSha: string, trailerValues: string[]): boolean {
  const sha = candidateSha.toLowerCase();
  return trailerValues.some((value) => sha.startsWith(value));
}
