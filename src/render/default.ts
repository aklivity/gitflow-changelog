import type { FoldInSection } from '../upstream.js';
import type { Bucket, Entry, PlacementResult } from '../types.js';

export interface RenderOptions {
  owner: string;
  repo: string;
}

// Keyed the same way PlacementResult buckets are: a tag name, or null for
// Unreleased. A repo can fold in from more than one upstream source, so
// each bucket maps to a list, not a single section.
export type FoldInsByBucket = Map<string | null, FoldInSection[]>;

const SPECIAL_CHARS = /[\\()[\]_*#]/g;

// Backslash-escape markdown special characters outside inline code spans;
// code span contents are left untouched, matching the existing CHANGELOG
// format this renderer reproduces byte-for-byte.
export function escapeTitle(title: string): string {
  return title
    .split(/(`[^`]*`)/)
    .map((segment, index) => (index % 2 === 1 ? segment : segment.replace(SPECIAL_CHARS, '\\$&')))
    .join('');
}

function authorLink(entry: Entry): string {
  if (entry.bot)
  {
    const appName = entry.login.replace(/\[bot\]$/, '');
    return ` ([${entry.login}](https://github.com/apps/${appName}))`;
  }
  return ` ([${entry.login}](https://github.com/${entry.login}))`;
}

function entryUrl(entry: Entry, options: RenderOptions): string {
  const path = entry.kind === 'pr' ? 'pull' : 'issues';
  const repo = entry.sourceRepo ?? `${options.owner}/${options.repo}`;
  return `https://github.com/${repo}/${path}/${entry.number}`;
}

// A folded-in entry is tagged owner/repo#N (matching GitHub's own
// cross-repo reference convention) rather than a bare #N — this repo's own
// issue numbers are unrelated in scale, so an unmarked #2080 next to #941
// would read as a typo rather than a deliberate cross-repo link.
function entryLabel(entry: Entry): string {
  return entry.sourceRepo ? `${entry.sourceRepo}\\#${entry.number}` : `\\#${entry.number}`;
}

function renderEntry(entry: Entry, options: RenderOptions): string {
  const title = escapeTitle(entry.title);
  const url = entryUrl(entry, options);
  return `- ${title} [${entryLabel(entry)}](${url})${authorLink(entry)}`;
}

function withSourceRepo(entry: Entry, repo: string): Entry {
  return { ...entry, sourceRepo: repo };
}

interface Section {
  heading: string;
  entries: Entry[];
}

function sectionsFor(entries: Entry[]): Section[] {
  return [
    { heading: 'Implemented enhancements', entries: entries.filter((entry) => entry.category === 'enhancement') },
    { heading: 'Fixed bugs', entries: entries.filter((entry) => entry.category === 'bug') },
    {
      heading: 'Closed issues',
      entries: entries.filter((entry) => entry.kind === 'issue' && entry.category === 'issue'),
    },
    {
      heading: 'Merged pull requests',
      entries: entries.filter((entry) => entry.kind === 'pr' && entry.category === 'issue'),
    },
  ].filter((section) => section.entries.length > 0);
}

function tagDate(isoDate: string): string {
  return isoDate.slice(0, 10);
}

// A one-line note per upstream source, placed once per bucket rather than
// repeated per entry — the entries themselves carry the owner/repo#N tag,
// this just states the absorbed version range for context. Linked to the
// upstream repo's own diff for that range: the section's top-of-bucket
// "Full Changelog" link only ever covers this repo's own tags, so once a
// bucket folds in another repo's entries, that link alone no longer
// describes everything the section covers. fromVersion/toVersion are real
// tag names in the upstream repo (selectEntriesInRange matches them
// against the upstream's own tag list), so a compare link between them is
// exactly as accurate as the repo's own "Full Changelog" link. With no
// fromVersion (first-ever absorbed range, nothing to diff from), link the
// single toVersion tag instead of a compare. Linked unconditionally,
// regardless of the upstream's org relative to this repo's — the per-entry
// owner/repo#N links already point into the upstream repo the same way
// with no such check, so this line is no different a reachability
// assumption than content this renderer already produces everywhere else.
function foldInNote(foldIn: FoldInSection): string {
  const [, repoName] = foldIn.repo.split('/');
  const repoUrl = `https://github.com/${foldIn.repo}`;
  const range = foldIn.fromVersion ? `${foldIn.fromVersion}–${foldIn.toVersion}` : `up to ${foldIn.toVersion}`;
  const url = foldIn.fromVersion
    ? `${repoUrl}/compare/${foldIn.fromVersion}...${foldIn.toVersion}`
    : `${repoUrl}/tree/${foldIn.toVersion}`;
  return `_Includes [${repoName} ${range}](${url})._`;
}

function renderBucket(
  bucket: Bucket,
  previousTagName: string | undefined,
  options: RenderOptions,
  foldIns: FoldInSection[],
): string {
  const repoUrl = `https://github.com/${options.owner}/${options.repo}`;
  const lines: string[] = [];

  if (bucket.tag === null)
  {
    lines.push(`## [Unreleased](${repoUrl}/tree/HEAD)`, '');
    if (previousTagName)
    {
      lines.push(`[Full Changelog](${repoUrl}/compare/${previousTagName}...HEAD)`, '');
    }
  }
  else
  {
    lines.push(`## [${bucket.tag.name}](${repoUrl}/tree/${bucket.tag.name}) (${tagDate(bucket.tag.date)})`, '');
    if (previousTagName)
    {
      lines.push(`[Full Changelog](${repoUrl}/compare/${previousTagName}...${bucket.tag.name})`, '');
    }
  }

  for (const foldIn of foldIns)
  {
    lines.push(foldInNote(foldIn), '');
  }

  const foldInEntries = foldIns.flatMap((foldIn) => foldIn.entries.map((entry) => withSourceRepo(entry, foldIn.repo)));
  const allEntries = [...bucket.entries, ...foldInEntries];

  for (const section of sectionsFor(allEntries))
  {
    lines.push(`**${section.heading}:**`, '');
    for (const entry of section.entries)
    {
      lines.push(renderEntry(entry, options));
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function render(placement: PlacementResult, options: RenderOptions, foldIns: FoldInsByBucket = new Map()): string {
  const lines: string[] = ['# Changelog', ''];

  for (let index = 0; index < placement.buckets.length; index += 1)
  {
    const bucket = placement.buckets[index];
    const next = placement.buckets[index + 1];
    const previousTagName = next?.tag?.name;
    lines.push(renderBucket(bucket, previousTagName, options, foldIns.get(bucket.tag?.name ?? null) ?? []));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
