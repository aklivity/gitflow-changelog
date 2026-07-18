# gitflow-changelog

A CHANGELOG generator for repositories that use a **gitflow** branching model —
a long-running `develop` branch plus maintenance/support branches (e.g.
`support/1.x`) — where each release tag lives on its own line of history.

Generic changelog generators place issues and pull requests by comparing
dates (when did this close relative to when that tag was cut?), which is
wrong the moment a repo has more than one active branch: an issue whose fix
hasn't shipped on a given branch yet — or shipped on a *different* branch
entirely — gets silently attributed to whatever tag happens to be newest when
it closes. This tool places every entry by asking git which tag actually
contains its commit, walking real ancestry instead of trusting dates or
platform-reported associations.

## How it works

```
Driver (platform-specific)  →  Placement (shared, git-only)  →  Renderer (shared, format-only)
```

1. **Driver** (`src/drivers/github.ts` for v1) walks the GitHub REST API and
   produces a platform-agnostic list of entries: `{ number, kind, category,
   title, login, bot, sha }`.
2. **Placement** (`src/placement.ts`) is pure local git: for each entry, it
   finds the earliest tag (chronologically) whose history contains the
   entry's commit. If no tag contains it but it's still an ancestor of the
   branch being processed, it goes under `Unreleased`. If it's not reachable
   from this branch's line of history at all — e.g. a PR merged to `develop`
   as part of an unrelated release — it's dropped from this branch's log
   entirely.
3. **Renderer** (`src/render/default.ts`) turns the placed structure into
   markdown, matching the existing CHANGELOG format byte-for-byte.

This design keeps the door open for other platforms (GitLab, etc.) later —
they'd only need to implement the driver contract; placement and rendering
are already platform-agnostic.

## Usage

### As a GitHub Action

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # required — ancestry checks need full history, not a shallow clone

- uses: actions/cache@v4
  with:
    path: .gitflow-changelog-cache.json
    key: gitflow-changelog-v1-${{ github.repository }} # stable key, not hash-based

- uses: aklivity/gitflow-changelog@v1
  with:
    ref: support/1.x
```

See [`action.yml`](./action.yml) for the full list of inputs.

### As a CLI

```bash
npx gitflow-changelog --owner aklivity --repo zilla --token "$GITHUB_TOKEN" --ref support/1.x
```

`src/cli.ts` and `src/action.ts` share the same core (`src/run.ts`) — the CLI
is not a wrapper around the Action, and vice versa; both are thin entrypoints
over the same logic.

## Changelog policy: `.gitflow-changelog.yml`

Settings that describe *what your changelog looks like* — which tags get
their own section, how issues/PRs are categorized, which renderer to use —
live in a YAML file committed to the consuming repo (path via the
`config-path` input, default `.gitflow-changelog.yml`), not as action inputs
repeated at every call site:

```yaml
tag-pattern: '^[0-9]+\.[0-9]+\.[0-9]+$' # exclude alpha/beta/rc pre-releases
enhancement-labels: [enhancement]
bug-labels: [bug]
exclude-labels: [duplicate, invalid, wontfix]
format: default
```

This is a policy that doesn't vary by branch or by which step (`prepare` vs.
`finalize`) is running, so one file avoids the same setting drifting out of
sync across every copy of a release workflow. Settings that genuinely do
vary per call site — `ref`, `token`, `git-dir`, `cache-path`, `output-path`
— stay as action inputs. `overrides-path` also follows the config-path
convention: auto-loaded from `.gitflow-changelog-hash-overrides.yml` if
present, no input needed.

The matching action inputs (`tag-pattern`, `enhancement-labels`,
`bug-labels`, `exclude-labels`, `format`) still exist as one-off overrides
and take precedence over the file when set; if neither the input nor the
file sets a value, each falls back to a built-in default (shown in the
example above).

## Incremental caching

Both a PR's `merge_commit_sha` and an issue's closing commit are immutable
once recorded (gitflow forbids rebasing release branches), so this tool
caches aggressively instead of refetching all history every run. It walks
the repo-wide `GET /repos/{owner}/{repo}/issues/events` feed — which covers
both issues and pull requests, since every PR is an issue under the hood —
and keeps only the highest event id processed as a watermark. Each run jumps
to the last page and walks backward only until it reaches the cached
watermark.

The CHANGELOG is always fully re-rendered from the entire accumulated cache,
never incrementally patched — so a label change or rename processed today
correctly updates every section that entry appears in, old releases
included.

Pair `cache-path` with `actions/cache` using a **stable key** (not
hash-based, e.g. `gitflow-changelog-v1-${{ github.repository }}`) so the
cache is found and updated on every run rather than only on exact matches.

The same applies to `upstream-cache-dir`, used only when `.gitflow-changelog.yml`
declares an `upstream` source: placing an upstream repo's entries under the
right release needs its full git history, and `git fetch` on an existing
clone only transfers what changed since last time — a full clone's cost is
paid once, not on every run, as long as the directory is cached across runs
the same way. Use a key that's stable across branches too (the upstream
repo's history is the same regardless of which of *your* branches is
generating a changelog).

## Unresolved commit hashes

A recorded `merge_commit_sha` or closing `commit_id` can point at a commit
that no longer exists in the repository at all — distinct from "a valid
commit that just isn't reachable from this branch," which is a normal,
correct drop. This happens when history is rewritten on another branch after
the fact (e.g. a PR merged to a feature branch that was later rebased or
squash-merged).

Resolution order, highest precedence first:

1. **Checked-in override** — a YAML file in the consuming repo, keyed by the
   broken commit sha itself (not by PR/issue number): an issue auto-closed by
   a merged PR has its sha backfilled from that PR's own commit, so a PR and
   the issue(s) it closes always carry the identical recorded sha — one entry
   here fixes both, and any other entry that happens to share the same
   broken sha, with no need to enumerate every affected PR/issue number by
   hand. Auto-loaded from `.gitflow-changelog-hash-overrides.yml` if
   present — no workflow changes needed; override the path via the
   `overrides-path` input only if you want a different filename:

   ```yaml
   hash-overrides:
     54ab5fa6ace003e9a559f83d4a94ef847a733bbd: eb43dc7e4b78b1095f56767c004cd443a423bbd0
   ```

2. **As recorded**, if the commit resolves locally.
3. **Heuristic auto-detection** — search local commit messages for a
   reference to the same PR/issue number. If exactly one reachable candidate
   is found, it's used, with a visible warning naming the substitution.
4. **Flagged unresolved** — zero or multiple ambiguous candidates: the entry
   is dropped and a warning names the PR/issue and the unresolvable SHA, so a
   human can add an explicit override.

## Known limitations

- A label applied without generating a discrete GitHub event (rare, e.g.
  certain repository-transfer/import paths) is invisible to this tool, since
  categorization is driven entirely by event-sourced label state.
- A GitHub username change has no corresponding issue event, so a cached
  `login` can go stale — cosmetic (wrong link text), not a placement error.
- An issue closed manually (no linked commit or merged pull request) has no
  commit to place it against and is correctly dropped, same as an
  unreachable PR. An issue closed via a merged PR's closing keyword
  (`Fixes #N`, `Closes #N`, `Resolves #N`, case-insensitive) is placed using
  that PR's merge commit instead — the repo-wide `/issues/events` feed's own
  `closed` event only carries a `commit_id` for direct-commit closes, not
  ones closed via a linked PR.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # bundles src/cli.ts -> dist/cli.js and src/action.ts -> dist/index.js
```

`dist/` is gitignored and never committed on `develop`/`main` — GitHub
Actions does not install dependencies for JavaScript actions at run time, so
a real, working action still needs `dist/index.js` to exist somewhere, but
that somewhere is a release tag, not the development branch (see
"Releasing" below). Don't build-and-commit `dist/` locally; `npm run build`
is for local verification only.

## Releasing

Releases are cut via the [Release workflow](./.github/workflows/release.yml)
(`workflow_dispatch`, with a `version` input like `0.1.0`). It bumps
`package.json`, builds `dist/`, and commits both into a single release
commit — but that commit is never pushed onto the branch it was dispatched
from. Instead, only two tags are pushed to point at it: the exact `vX.Y.Z`
and a moving major-version tag (`v0` until a stable `v1`) that consumers
reference via `uses: aklivity/gitflow-changelog@v0`, matching the convention
used by `actions/checkout`, `actions/setup-node`, etc. `develop`/`main`
themselves never see a version bump or a `dist/` commit — only the tags do.

Because the release commit isn't part of `develop`'s own history, each
release's commit is only reachable via its tag, not via `git log develop`;
that's expected, not a bug — the whole point is keeping `dist/` and version
bumps out of normal development history entirely.
