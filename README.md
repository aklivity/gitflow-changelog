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

[`merge-report`](#merge-report-did-a-fix-propagate-everywhere-it-needs-to)
is a second consumer of the Driver's cached, event-sourced entries — it
skips Placement and Renderer entirely (it isn't about which release
something shipped in) and instead cross-references entry labels against
`git cherry` candidates.

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

- uses: aklivity/gitflow-changelog@v0
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
   `overrides-path` input only if you want a different filename. When
   resolving an `upstream` dependency's own history for fold-in, that
   upstream's own `.gitflow-changelog-hash-overrides.yml` (from its clone)
   is what's read — not the consuming repo's, and not configurable via
   `overrides-path` (which only applies to the consuming repo's own
   resolution):

   ```yaml
   hash-overrides:
     54ab5fa6ace003e9a559f83d4a94ef847a733bbd: eb43dc7e4b78b1095f56767c004cd443a423bbd0
   ```

2. **As recorded**, if the commit resolves locally.
3. **Heuristic auto-detection** — search local commit messages for a
   reference to the same PR/issue number. If exactly one reachable candidate
   is found, it's used, with a visible warning naming the substitution.
4. **Squash-merge discovery** (PR entries only) — covers a PR merged into a
   long-lived feature branch (e.g. `feature/grpc-kafka`) that was itself
   later squash-merged, which flattens the PR's own commit away entirely.
   Fetches the PR's base ref, then searches GitHub for whichever PR
   squash-merged that base ref into a real branch — trying the branch
   currently being processed first (the feature branch may have been
   squashed directly into it), then falling back to the repo's actual
   default branch if that misses (the feature branch may instead have been
   squashed into develop, with the branch being processed only inheriting
   the result via ancestry — confirmed against real aklivity/zilla history:
   `feature/support-catalog-handler-validate` was squashed into `develop`
   via #1606, yet is also correctly resolved when generating `support/1.x`'s
   changelog). Once the right squash-merge PR is found, checks whether
   *its* number is referenced in local commit messages (reusing the same
   history scan from tier 3 — no extra git operation, and no risk of a
   false positive: that scan only ever contains commits reachable from the
   branch being processed, so a squash-merge that never reached this branch
   correctly yields zero candidates). An issue closed by a PR resolved this
   way is fixed for free in the same run, since it shares that PR's exact
   broken sha. Discovered base refs and squash-merge PR numbers are cached
   permanently (both are immutable once merged), so this only costs GitHub
   API calls once per affected PR/branch, not on every run.

   If GitHub signals rate-limit exhaustion (a 403 with
   `X-RateLimit-Remaining: 0`, a secondary/abuse-detection 403 with
   `Retry-After`, or a 429) partway through, this tier stops attempting
   further lookups for the rest of the run rather than silently reporting
   every remaining entry as unresolvable — a single clear warning is
   emitted instead. Anything already discovered before the limit was hit
   stays in the persisted cache, so the next run resumes from there instead
   of starting over. An ordinary 403 (e.g. a token missing a required
   scope) or 404 is unaffected and still resolves to "not found," same as
   before.
5. **Flagged unresolved** — zero or multiple ambiguous candidates at any
   tier: the entry is dropped and a warning names the PR/issue and the
   unresolvable SHA, so a human can add an explicit override.

## merge-report: did a fix propagate everywhere it needs to?

`gitflow-changelog` answers "which release did this fix ship in." A related,
separate question: **did a fix that landed on one branch actually make it to
every other branch that needs it?** A bug fix on `support/1.x` that never
reaches `develop` becomes a regression for a customer upgrading past
`1.x` — they had the fix, then lost it. The same risk exists between peer
maintenance branches (`support/1.x` and `support/2.x` both need a fix that
only landed on one of them). This isn't a "backport" (mainline → older
branch) — it's the reverse, or a sideways case between peers — hence
**merge-report**: did this change actually merge across the branches that
needed it, regardless of direction.

### Branch topology, discovered automatically

`merge-report` doesn't take a source/target pair — it discovers the whole
branch topology itself and sweeps it in one pass. The mainline branch
(`develop` by default) and every branch matching a support-branch pattern
(`support/(\d+)\.x` by default) are found by listing what actually exists
right now, then each one's *sources* — the branches it should have every
fix from — are derived purely from naming/version convention:

- the mainline branch's sources are every support branch that exists
- `support/N.x`'s sources are every `support/M.x` that exists with `M < N`
- the lowest surviving support branch has no sources — it's trivially clean
  by definition, and the report says so explicitly rather than omitting it

This is what makes the report self-adjusting: cutting `support/3.x` from
`develop` doesn't require a check-in anywhere — the next run picks it up as
a new target with `support/1.x` and `support/2.x` as its sources
automatically, and `develop`'s own sweep gains a third source the same way.
It's also what makes a scheduled run and a manual `workflow_dispatch` run
produce identical results: neither one requires the caller to know or
supply the current branch topology, since there's nothing to supply.

### As a GitHub Action

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # full history — patch-content comparison needs it

# actions/checkout's default fetch refspec only brings full history for the
# one ref it checks out, even at fetch-depth 0 — every other branch needs an
# explicit fetch, or discovery below finds nothing to sweep.
- run: git fetch origin '+refs/heads/*:refs/remotes/origin/*'

- uses: actions/cache@v4
  with:
    path: .gitflow-changelog-cache.json
    key: gitflow-changelog-v1-${{ github.repository }} # same cache the changelog action uses

- uses: aklivity/gitflow-changelog/merge-report@v0
```

Run this on a schedule (weekly, say) plus `workflow_dispatch`, not on every
push or PR merge — at the exact moment a fix lands on some branch it is
*definitionally* not yet on anything downstream of it, so a merge-triggered
run would only ever report a guaranteed, contentless "not yet." The
scheduled sweep is where real signal — something that's been outstanding
for a while — shows up. GitHub's `schedule` trigger always runs the copy of
the workflow file on the repo's *default* branch, with no branch-selection
equivalent to what `workflow_dispatch` offers — so this only works as one
workflow living on the mainline branch, not as a workflow duplicated across
every branch expecting to infer "itself" as the target. `git cherry`
doesn't need any branch checked out, only present locally, which is exactly
what the fetch step above provides — no per-branch checkout required to
sweep the whole topology in a single job.

See [`merge-report/action.yml`](./merge-report/action.yml) for the full
list of inputs, including `target`/`sources` (narrows the sweep to one
branch, for on-demand debugging — leave unset for the default full sweep)
and `fail-on-outstanding-after-days` (default 14): the report itself always
lists everything, unfiltered, oldest-first, one section per branch; this
input only controls whether the run exits non-zero, which is what actually
surfaces the finding to a human via GitHub's default scheduled-workflow-
failure notification — a job summary alone isn't pushed to anyone.

### As a CLI

```bash
# full sweep — no branch args needed, topology is discovered
npx gitflow-changelog merge-report --owner aklivity --repo zilla-plus --token "$GITHUB_TOKEN"

# narrowed to one target, for on-demand debugging
npx gitflow-changelog merge-report --owner aklivity --repo zilla-plus --token "$GITHUB_TOKEN" \
  --target support/2.x --sources support/1.x
```

### How it detects a gap

Comparing branches by ancestry (`git log target..source`) doesn't work: it
flags every cherry-picked or independently re-landed commit as "missing"
purely because its SHA differs, which is the normal shape of a real
forward-port. `merge-report` uses `git cherry -v target source` instead —
patch-id comparison — so a commit re-applied under a new SHA on `source` is
correctly recognized as already present on `target`.

What's left after that goes through five more filters, cheapest first,
each one only running if nothing cheaper already resolved the candidate:

- **`exclude-labels`** — the same list read from `.gitflow-changelog.yml`
  for changelog categorization. A candidate commit whose originating PR/issue
  carries one of these labels (e.g. `dependencies`) is dropped the same way
  it's excluded from the changelog — no second API sweep, just a second
  consumer of the event-sourced label state the Driver already fetches and
  caches.
- **`ports-trailer`** (on by default) — a `Ports: <sha>` line in a
  target-branch commit's body, asserting it carries forward that specific
  source-branch commit. This is the escape hatch for a port whose content
  is a deliberate subset or superset of the original — e.g. the original
  bundled an unrelated version bump the target branch's own version already
  covers — which changes both the patch-id and the subject enough that
  neither of the other checks can recognize the pairing on their own. Unlike
  subject-match below, a trailer match is a human assertion, not a
  heuristic: it's trusted outright, no file-overlap confirmation required.
  The trailer value may be a full or abbreviated sha (a prefix match against
  the candidate's full sha, same convention `git log <prefix>` itself
  accepts). Scanned once per target branch, so per-candidate this is a
  plain in-memory check — cheap enough to run this early.
- **`exclude-paths`** — a candidate is dropped only if **every** changed
  path matches one of these globs; one file outside the set still shows up.
  Defaults to `.github/**,CHANGELOG.md,.gitflow-changelog*.yml` — safe
  across any consuming repo, since CI config, generated changelog content,
  and this tool's own config files are never customer-facing. Deliberately
  **not** the existing feature/noise classification used for the upstream
  fold-in feature (`classification.ts`'s `DEFAULT_CLASSIFICATION_PATTERNS`)
  — that's tuned for "does this belong in the customer changelog," which
  treats `examples/`/`docs/` as noise. For merge-report a docs-only gap is
  exactly the kind of thing that has to stay visible; reusing that default
  would silently hide it.
- **`exclude-message-patterns`** — regexes tested against the full commit
  subject. No built-in default: scoped deliberately narrow, to a repo's own
  literal, deterministically machine-generated commit messages (e.g. a
  release workflow's fixed `"Prepare release "` template), never a general
  human/bot commit-message convention — commit-message *conventions* aren't
  reliable enough to filter on (see subject-match below for why this
  matters), but a fixed template a workflow emits verbatim every time is a
  different, much more reliable kind of signal.
- **Subject-normalization matching** (`subject-match`, on by default) — the
  dominant real-world false-positive shape isn't release noise, it's a
  *backport PR renumbered on the target branch*: the same fix, cherry-picked
  with a new PR number and just enough incidental diff drift (unrelated
  codebase divergence between the branches) to change the patch-id. Strip
  every trailing `(#NNN)` group and a trailing `(backport...)` annotation
  from the subject, and check whether the target branch already has a
  commit with the identical normalized subject. If it does, additionally
  require the two commits' changed-file sets to overlap (Jaccard) by at
  least `subject-match-min-overlap` (default `0.3`) before trusting the
  match — title collisions are rare but real, and requiring file overlap on
  top costs nothing in the cases that matter, since a real match's files
  stay far more stable than its line content across independent codebase
  drift. Below the threshold, the candidate is **not** auto-resolved; it
  still shows up, same as anything else needing a human call.
- **`.gitflow-changelog-merge-ignore.yml`** — a checked-in, sha-keyed list
  for whatever survives all of the above, each with a required human-
  written reason:

  ```yaml
  merge-ignore:
    a18bdc1c3db328f6f66f53ac84e1eec4f360ce38: "branch-scoped SNAPSHOT reset, not applicable to develop"
  ```

  Keyed by sha rather than a commit-message convention (`build(deps):`,
  "backport of #NNNN") — message conventions aren't consistent enough to
  filter on reliably; a human's explicit, reviewed judgment is. In
  practice, once the four filters above are in place, this list stays
  small and stops growing on every new backport — confirmed against
  `aklivity/zilla-plus`'s real history: 86 raw `git cherry` candidates
  reduced to 9 (8 genuine one-off residue, 1 real gap) with zero ignore-list
  entries needed for the recurring renumbered-backport shape.

None of this is cached — deliberately consistent with `git cherry`/
`commitDate`, which are also recomputed fresh every run. Every check above
is local git (no GitHub API cost), and "found a subject-match" vs. "no
match yet" isn't safe to cache without the same watermark discipline the
events cache uses (a real match can appear on a later run once a backport
actually lands) — not worth the complexity until an actual repo's scale
makes it slow.

### Recommended: writing a port commit merge-report can recognize

When you open a PR that ports a fix from one branch to another, follow one
of these so merge-report resolves it automatically instead of the gap
lingering as a false positive that needs a manual ignore-list entry:

- **Full port** (the port carries the same change as the original, nothing
  added or dropped): keep the original commit's exact `type(scope):
  description` subject. Only the trailing `(#NNN)` PR-number reference
  should differ — subject-normalization already strips that. Don't reword
  the description or change the conventional-commit scope, even if it reads
  awkwardly on the target branch — a differing scope (e.g. `docs(examples):`
  vs. `docs(some-feature):`) is exactly the kind of thing that defeats
  subject-match.
- **Partial or reworded port** (e.g. the original bundled a version bump or
  other change that doesn't apply on the target branch): no title
  convention can bridge a genuine content difference, since both the
  patch-id and the subject will legitimately differ. Add a `Ports:
  <original-sha>` line to the commit body instead — merge-report trusts it
  outright, no human follow-up needed. Confirmed working end-to-end on
  `aklivity/zilla-plus`: PR #1054 ported #1043's routed-API-list change to
  `develop` as a deliberately partial diff (some entries already existed
  there independently); its commit body carries `Ports:
  51d29db0f37695d8b479214dfeeab0f2c838a909`, and merge-report resolved the
  gap on the very next scheduled run, with no ignore-list entry required.

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
npm run build   # bundles src/cli.ts -> dist/cli.js, src/action.ts -> dist/index.js,
                # and src/merge-report-action.ts -> merge-report/index.js
```

`dist/` and `merge-report/index.js` are gitignored and never committed on
`develop`/`main` — GitHub Actions does not install dependencies for
JavaScript actions at run time, so a real, working action still needs its
compiled entrypoint to exist somewhere, but that somewhere is a release tag,
not the development branch (see "Releasing" below). Don't build-and-commit
these locally; `npm run build` is for local verification only.

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
