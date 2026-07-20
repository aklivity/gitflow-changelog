export interface BranchTopology {
  target: string;
  sources: string[];
}

function supportVersion(name: string, supportPattern: RegExp): number | undefined {
  const match = name.match(supportPattern);
  return match ? Number(match[1]) : undefined;
}

// Pure function, no git involved — computeTopology only needs to know which
// branches currently exist, not their content, so it's testable with plain
// string arrays. The whole point of deriving this from names/versions
// rather than a checked-in list is that it self-adjusts the moment a branch
// is cut or removed, with nothing to edit anywhere.
//
// mainline's sources are every support branch that exists; support/N.x's
// sources are every support/M.x that exists with M < N (never a same-or-
// higher version, which avoids two branches redundantly checking each
// other); the lowest surviving support branch has no sources at all.
export function computeTopology(branches: string[], mainline: string, supportPattern: RegExp): BranchTopology[] {
  const supportBranches = branches
    .map((name) => ({ name, version: supportVersion(name, supportPattern) }))
    .filter((branch): branch is { name: string; version: number } => branch.version !== undefined)
    .sort((a, b) => a.version - b.version);

  const topology: BranchTopology[] = [];

  if (branches.includes(mainline))
  {
    topology.push({ target: mainline, sources: supportBranches.map((branch) => branch.name) });
  }

  for (let index = 0; index < supportBranches.length; index += 1)
  {
    topology.push({
      target: supportBranches[index].name,
      sources: supportBranches.slice(0, index).map((branch) => branch.name),
    });
  }

  return topology;
}
