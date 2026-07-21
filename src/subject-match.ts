// Strips the parts of a commit subject that are *expected* to differ
// between a branch and the place a fix originated: trailing "(#NNN)" PR
// references (a backport PR is assigned a new number when it merges,
// even though its title is copied verbatim from the original) and a
// trailing "(backport...)" annotation. What's left is compared for an
// exact match against the target branch's own history — a second opinion
// for the specific false-positive shape patch-id comparison can't see
// past: same fix, same title, but enough incidental diff drift (renumbered
// PR, unrelated codebase divergence) to change the patch-id.
export function normalizeSubject(subject: string): string {
  let current = subject;
  for (;;)
  {
    let next = current.replace(/\s*\(#\d+\)\s*$/, '');
    next = next.replace(/\s*\(backport(?:\s+to\s+support\/[\d.]+x)?\)\s*$/i, '');
    if (next === current)
    {
      break;
    }
    current = next;
  }
  return current.trim();
}

// Jaccard similarity of two changed-file sets. Title match alone has a
// (low but real) collision risk — two unrelated commits sharing an
// identical normalized title — so this is required on top before trusting
// a title match, without reintroducing the false negatives a raw diff-
// content comparison would: file *paths* touched stay stable across a
// backport even when line *content* drifts (a buffer-type wrapper swap or
// a copyright-year bump changes what a line says, not which file it's in).
export function fileOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0)
  {
    return 1;
  }
  let intersection = 0;
  for (const file of setA)
  {
    if (setB.has(file))
    {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
