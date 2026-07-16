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

async function reachableFrom(tags: TagInfo[], ref: string, gitOptions: GitOptions): Promise<TagInfo[]> {
  const reachable: TagInfo[] = [];
  for (const tag of tags)
  {
    if (await isAncestor(tag.name, ref, gitOptions))
    {
      reachable.push(tag);
    }
  }
  return reachable;
}

export async function place(input: PlacementInput, gitOptions: GitOptions): Promise<PlacementResult> {
  // Scope tags to this branch's own line of history before placing anything.
  // `git tag --contains` answers "does any tag, on any line, contain this
  // commit" — a tag from a disjoint gitflow line (e.g. a support/1.x-only
  // release) can technically "contain" a commit while being completely
  // irrelevant to the branch this changelog is being generated for. Without
  // this filter, a support-branch-only tag leaks into develop's changelog
  // (and vice versa) the moment any entry's commit happens to also be an
  // ancestor of that other tag.
  const allTags = await reachableFrom(await listTags(/.*/, gitOptions), input.ref, gitOptions);
  const sectionedTags = await reachableFrom(await listTags(input.tagPattern, gitOptions), input.ref, gitOptions);

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

  return { buckets, dropped, unresolved: [], allTags: orderedSectionedTags };
}
