import type { GitOptions, TagInfo } from './git.js';
import { isAncestor, listTags, tagsContaining } from './git.js';
import type { Bucket, Entry, PlacementResult, Tag } from './types.js';

export interface PlacementInput {
  entries: Entry[];
  ref: string;
  tagPattern: RegExp;
}

function toTag(info: TagInfo): Tag {
  return { name: info.name, sha: info.sha, date: info.date };
}

export async function place(input: PlacementInput, gitOptions: GitOptions): Promise<PlacementResult> {
  const allTags = await listTags(/.*/, gitOptions);
  const sectionedTags = await listTags(input.tagPattern, gitOptions);

  const tagsByDateAsc = allTags
    .map(toTag)
    .sort((a, b) => a.date.localeCompare(b.date));
  const sectionedNames = new Set(sectionedTags.map((tag) => tag.name));

  const bucketsByTag = new Map<string, Entry[]>();
  const unreleased: Entry[] = [];
  const dropped: Entry[] = [];

  for (const entry of input.entries)
  {
    const containingNames = new Set(await tagsContaining(entry.sha, gitOptions));
    // Earliest tag (chronologically) whose history contains the entry's
    // commit — i.e. the first release that actually shipped this fix, not
    // just any tag that happens to be newer when the entry closed/merged.
    const firstSectioned = tagsByDateAsc.find(
      (tag) => sectionedNames.has(tag.name) && containingNames.has(tag.name),
    );

    if (firstSectioned)
    {
      const bucket = bucketsByTag.get(firstSectioned.name) ?? [];
      bucket.push(entry);
      bucketsByTag.set(firstSectioned.name, bucket);
      continue;
    }

    // Not under any tagged section — is it at least on this branch's line of
    // history (i.e. shipped but not yet tagged)?
    if (await isAncestor(entry.sha, input.ref, gitOptions))
    {
      unreleased.push(entry);
      continue;
    }

    // Not reachable from this branch at all — e.g. a PR merged to develop
    // as part of an unrelated release line. Drop it from this branch's log.
    dropped.push(entry);
  }

  const buckets: Bucket[] = [];
  if (unreleased.length > 0)
  {
    buckets.push({ tag: null, entries: unreleased });
  }
  const orderedSectionedTags = [...sectionedTags]
    .map(toTag)
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const tag of orderedSectionedTags)
  {
    const entries = bucketsByTag.get(tag.name);
    if (entries && entries.length > 0)
    {
      buckets.push({ tag, entries });
    }
  }

  return { buckets, dropped, unresolved: [] };
}
