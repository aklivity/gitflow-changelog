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
  // Set only on entries folded in from an upstream dependency (e.g.
  // "aklivity/zilla") — undefined for entries native to the repo the
  // changelog is being generated for. The renderer uses this to link to
  // the right repo and to tag the visible number (owner/repo#N instead of
  // bare #N), rather than segregating fold-in entries into their own
  // section — a folded-in bug fix should still show up under "Fixed
  // bugs" next to this repo's own bug fixes.
  sourceRepo: z.string().optional(),
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
  // Every sectioned tag reachable from ref, newest first, regardless of
  // whether it ended up with any entries of its own — `buckets` omits
  // empty tags, but fold-in range computation needs the full sequence to
  // find "the tag immediately before this one," not "the nearest bucket
  // that happened to have entries."
  allTags: z.array(Tag),
});
export type PlacementResult = z.infer<typeof PlacementResult>;

// How much classification work is done, per data source. `maven` implies
// `path` — it adds artifact awareness on top, needed only by the fold-in
// feature. `none` is the default: a repo with no downstream fold-in
// consumers doesn't need to classify or persist anything for anyone else's
// benefit.
export const ClassificationLevel = z.enum(['none', 'path', 'maven']);
export type ClassificationLevel = z.infer<typeof ClassificationLevel>;

// Path-based classification outcome for one fold-in entry. An entry
// classifies as `feature` if ANY changed path matches a feature-include
// pattern, even if it also touches excluded paths in the same diff —
// inclusive-OR toward "real," not requiring every path clean. PRs are
// classified against the GitHub `GET /pulls/{number}/files` list; issues
// have no such endpoint, so they're classified against the file list of
// whichever commit resolved their `sha` (see resolveIssuePaths in
// upstream.ts).
export const PathClassification = z.enum(['feature', 'noise', 'test-only']);
export type PathClassification = z.infer<typeof PathClassification>;

// One upstream dependency to fold a filtered subset of into this repo's own
// changelog. `dependency-version-file` + `dependency-version-property` say
// where to read the pinned version from, at any given git ref (e.g. a
// release tag), so the absorbed range can be computed as
// (version at previous tag, version at this tag].
export const ExplicitUpstreamConfig = z.object({
  repo: z.string(),
  'dependency-version-file': z.string(),
  'dependency-version-property': z.string(),
  classification: ClassificationLevel,
  // Only consulted when classification is `maven`. Defaults to
  // `io.aklivity.<repo-name>` (the convention every current Aklivity repo
  // follows) when omitted, so most configs never need to set it.
  'maven-group-id': z.string().optional(),
});
export type ExplicitUpstreamConfig = z.infer<typeof ExplicitUpstreamConfig>;

// repo/dependency-version-file/dependency-version-property/classification
// above all duplicate information the Maven ecosystem already publishes:
// which property pins a groupId's version is discoverable from the
// consuming repo's own poms (findGroupVersionSource in maven.ts), and the
// upstream's own repo is discoverable from its published pom's <scm> block
// (extractGithubRepo in registry.ts) — see resolveUpstreamConfig in
// discover-upstream.ts. groupId/artifactId are meaningless outside a Maven
// context, so they live nested under a `maven` key rather than as siblings
// of a separate `classification` field — the key's own presence already
// says "maven-level classification, fully derived," with nothing left to
// redundantly spell out. `artifactId` identifies which pom to fetch for
// the <scm> lookup (the upstream's root/aggregator artifact); the
// version-discovery step matches on `groupId` alone, since nothing depends
// on a bare aggregator artifact directly.
export const MavenDiscoveredUpstreamConfig = z.object({
  maven: z.object({
    groupId: z.string(),
    artifactId: z.string(),
  }),
});
export type MavenDiscoveredUpstreamConfig = z.infer<typeof MavenDiscoveredUpstreamConfig>;

export const UpstreamConfig = z.union([ExplicitUpstreamConfig, MavenDiscoveredUpstreamConfig]);
export type UpstreamConfig = z.infer<typeof UpstreamConfig>;

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
