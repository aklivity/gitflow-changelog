import { z } from 'zod';

export const EntryKind = z.enum(['issue', 'pr']);
export type EntryKind = z.infer<typeof EntryKind>;

export const Category = z.enum(['enhancement', 'bug', 'issue', 'excluded']);
export type Category = z.infer<typeof Category>;

// Platform-agnostic entry — the contract between a driver and placement/rendering.
// Any future driver (GitLab, etc.) only needs to produce this shape.
export const Entry = z.object({
  number: z.number().int().positive(),
  kind: EntryKind,
  category: Category,
  title: z.string(),
  login: z.string(),
  bot: z.boolean(),
  sha: z.string(),
});
export type Entry = z.infer<typeof Entry>;

export const UnresolvedReason = z.enum(['not-found-anywhere', 'ambiguous-candidates']);
export type UnresolvedReason = z.infer<typeof UnresolvedReason>;

export const UnresolvedEntry = z.object({
  entry: Entry,
  reason: UnresolvedReason,
  candidates: z.array(z.string()),
});
export type UnresolvedEntry = z.infer<typeof UnresolvedEntry>;

export const Tag = z.object({
  name: z.string(),
  sha: z.string(),
  date: z.string(),
});
export type Tag = z.infer<typeof Tag>;

export const Bucket = z.object({
  tag: Tag.nullable(),
  entries: z.array(Entry),
});
export type Bucket = z.infer<typeof Bucket>;

export const PlacementResult = z.object({
  buckets: z.array(Bucket),
  dropped: z.array(Entry),
  unresolved: z.array(UnresolvedEntry),
});
export type PlacementResult = z.infer<typeof PlacementResult>;

export interface DriverOptions {
  owner: string;
  repo: string;
  token: string;
  enhancementLabels: string[];
  bugLabels: string[];
  excludeLabels: string[];
}

export interface Driver {
  fetchEntries(options: DriverOptions): Promise<Entry[]>;
}
