import type { Bucket, Entry, PlacementResult } from '../types.js';

export interface RenderOptions {
  owner: string;
  repo: string;
}

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
  return `https://github.com/${options.owner}/${options.repo}/${path}/${entry.number}`;
}

function renderEntry(entry: Entry, options: RenderOptions): string {
  const title = escapeTitle(entry.title);
  const url = entryUrl(entry, options);
  return `- ${title} [\\#${entry.number}](${url})${authorLink(entry)}`;
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

function renderBucket(bucket: Bucket, previousTagName: string | undefined, options: RenderOptions): string {
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

  for (const section of sectionsFor(bucket.entries))
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

export function render(placement: PlacementResult, options: RenderOptions): string {
  const lines: string[] = ['# Changelog', ''];

  for (let index = 0; index < placement.buckets.length; index += 1)
  {
    const bucket = placement.buckets[index];
    const next = placement.buckets[index + 1];
    const previousTagName = next?.tag?.name;
    lines.push(renderBucket(bucket, previousTagName, options));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
