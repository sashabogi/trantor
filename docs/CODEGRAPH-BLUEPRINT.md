# CodeGraph blueprint — what a live code-dependency lens in the Workspace actually takes (#6879, feeds #6878)

Read on 2026-09-17 from this repo at 684e8e8 and from a shallow clone of AlgoNoRhythm/Flare (MIT).
Paths without a prefix are repo-relative; Flare paths are prefixed `flare/`. Numbers were measured
on this checkout, not estimated. Repo scale for every cost below: 634 tracked source files
(js/mjs/ts/tsx/rs), about 129k lines; graft parses 522 of them (it also takes the python under
tools/ and skips json/toml/sh).

## 1. Substrate that already exists, and what each can and cannot answer

**graft (the MCP graph, `graft/` — gitignored, built per checkout).** `graft build` extracts
every symbol and edge with tree-sitter-class parsers into `graft/.cache/extract.<repo-id>.json`
and folds them into `graft/.graph/wiring.json`: 4662 nodes (522 file nodes, 3512 functions, 261
types, 67 Rust structs) and 10921 edges. The raw extraction keeps six relations — `imports`
(2143, file to specifier, e.g. `hub/events.mjs` imports `../lib/identity.mjs`), `calls`,
`contains`, `references`, `extends`, `implements` — and wiring resolves in-repo specifiers to
file ids (`bin/adopt.mjs` → `lib/project.mjs`, relation `imports`, confidence `extracted`).
External specifiers (`react`, `monaco-editor`) are kept as text and never become nodes.
Collapsed to file granularity there are 2278 distinct file→file pairs across imports and calls,
which is the edge set a Workspace graph would draw. Measured cost: a cold `graft build` is 8.0s
wall, a warm no-op is 0.7s, `graft check` re-extracts and costs 7.4s, and `graft blast --base
HEAD~1 --depth all` (reverse closure over incoming edges from the diff's touched lines) is 0.33s.
The MCP server refreshes before every query ("refreshed the graph (263 files changed) before
answering" was observed on the first call this session). What it answers: who imports X, who
calls Y, the transitive dependents of a diff (`graft blast`, text/markdown/mermaid/json), a
file's API (`graft skeleton`), directory clusters and hubs (`graft map`). What it cannot answer:
who changed a file, when, in which seat, whether anyone read it, churn, coverage. It is one index
per directory, so a seat's uncommitted edits exist in its graph only if graft runs inside
`~/.agent-bus/worktrees/<project>/<seat>`; the main checkout's graph never sees them. Files
without a parser (package.json, tauri.conf.json) are reported as "not in the graph" by blast.

**Demerzel (foundation plugin 4.0.1, `.foundation/snapshot.txt`).** The plugin README (lines
65-75) defines it: one text file concatenating every source body under a per-file banner plus an
import/export index, and the free reads (`demerzel_find_importers`, `demerzel_get_deps`,
`demerzel_find_symbol`) are scans over that text. Trantor has no snapshot: no `.foundation/`
exists in the main checkout or in any seat worktree, so today it answers nothing here. Even
built, it is specifier-level (no path-alias or index resolution, no symbol edges, no transitive
closure) and refreshes only by regenerating the whole file; the sample snapshot for a 43-file
Swift app is 9085 lines, so a trantor snapshot would be a 130k-line text the reads grep through.
It is not a graph substrate; it is a context-loading substrate for agents. Nothing in #6878 needs it.

**The hub's event log (`state.events`).** `appendEvent` in `hub/events.mjs` L126-139 writes
`{id, ts, type, project, by, ...payload}` to one append-only stream, capped at 20000 in memory
(`RELAY_EVENT_CAP`) and persisted to the `events` table (`lib/store-contract.mjs` L47-56, indexed
by project, type, task). Card events keep the legacy `created/moved/updated` shape with `source`
and `costUsd`; everything else is dotted: `message`, `presence.online/offline`, `focus`,
`handoff.written`, `lesson`, `verify.gate.opened`, `duty-failure`, `overseer.warn`, and
`file.claim`. That last one is the only code-space signal the hub has: the PreToolUse hook
`hooks/file-claim.mjs` posts a repo-relative path to `/claim` before every edit, and
`hub/routes/admin.mjs` L270-286 logs the first touch inside a 10-minute window (`RELAY_CLAIM_TTL_MS`)
as `file.claim {file}` by that session. It is read through `GET /events` (`hub/routes/cards.mjs`
L406-425: filters by project, type prefix, actor, card, `since` cursor) or live over SSE as
`event: ev` (`hub/events.mjs` L108-113); the app's Feed already consumes it
(`desktop/src/features/feed/Feed.tsx` L76). What it answers: which seat touched which file, when,
and against which card (a claim carries the session; the session's focus card is on the board).
What it cannot answer: imports or dependents (no code knowledge at all), which commit carried a
change (the backfill posts theme-grouped titles, `bin/git-backfill.mjs` L44-70, no sha and no file
list), and whether a human opened a file (`CodeView.tsx`, `Files.tsx`, `FileTree.tsx` never post to
the hub; only `ModePane.tsx` L229 sends, and that is a message). The claim hook is a Claude Code
plugin hook (`hooks/hooks.json` L54), so codex, kimi and opencode seats post no claims; their
file activity reaches nobody until they commit.

**The git post-commit hook.** `bin/init-hooks.mjs` writes a block into `.git/hooks/post-commit`
that runs `trantor backfill --since "5 minutes ago"` in the background; the main checkout has that
block installed. It does not fire in this repo: `.git/config` sets `core.hooksPath = hooks/githooks`
(added with the pre-push gate, #6446), and git runs hooks from that directory only, which holds
`pre-push` alone. Seat worktrees share the common git dir, so the same applies to seat commits.
Even where it fires, the payload is a `source: "git"` done card titled from the commit subject,
linked to the committer's open focus card by `hub/reaper.mjs` L29-49 inside a 10-minute window.
So the record knows THAT a commit happened and roughly what it was about; it never learns the sha
or the paths, which is exactly the join a code graph needs.

**Already in the app, and worth more than the four above for #6878.** `file_watch` in
`desktop/src-tauri/src/lib.rs` L2000-2086 is a recursive `notify` 6 watcher on the main checkout
that batches paths every 200ms and emits `file-changed {project, paths}`; `FileTree.tsx` L222 and
`Files.tsx` L226 already listen. `project_changes_sync` (`lib.rs` L7829-7892) walks every seat
worktree under `~/.agent-bus/worktrees/<project>/` and returns per-seat git status plus numstat:
that is the live "what the crew is doing to files" signal, polled, and it is the one that sees
non-Claude seats. `read_file` (`lib.rs` L453) takes a `seat` parameter and reads from the seat's
worktree, so the app already knows how to address a file in a seat's tree. The watcher covers the
main checkout only; nothing watches seat worktrees today.

## 2. The smallest build that gives the Workspace a live graph

**Source of truth: graft's `wiring.json`, one per checkout, produced by the graft CLI the app
already has on PATH.** Not the hub, not Demerzel, not a port. The reasons are in §1: graft already
holds the file→file import and call edges for this repo, resolves in-repo specifiers, runs in
under a second warm, and ships `blast`. The hub knows nothing about code and should stay that
way for the MVP; it becomes the attribution side (§4) once the graph exists. The app reads the
graph the way it reads git: a Rust command shells out to a CLI. `desktop/src-tauri/src/trantor_cli.rs`
is the precedent (resolves the node binary at L13-22, wraps `Command::new("trantor")` at L170
with a minimum-version probe); a `graft_cli.rs` sibling does the same for `graft build` and
`graft blast`, with the same "not installed" error surfaced in the lens instead of a blank canvas.

**Shape handed to React.** One Tauri command `code_graph(project, seat?)` returns file-level nodes
and edges only: the 522 file nodes with their cluster (top directory, as `graft map` already
groups them), in-degree and out-degree, and the 2278 collapsed file→file edges tagged
`imports` or `calls`. The 3.6MB wiring file stays in Rust; symbol-level nodes never cross the
bridge (the MVP has no use for 3512 function nodes on a canvas). Collapsing 10921 edges to file
pairs is a single pass over the array, a few milliseconds. With `seat` set, the command runs in
`~/.agent-bus/worktrees/<project>/<seat>` exactly as `read_file` does (`lib.rs` L453), so the
lens can show the graph as a seat's tree has it, uncommitted edits included.

**Refresh, in this order.** On file change: `file_watch` (`lib.rs` L2000) already emits
`file-changed` batches every 200ms for the main checkout; the graph command debounces those to
one `graft build` per quiet second. graft fingerprints files (`graft/.cache/fingerprint.*`), so a
one-file edit re-extracts one file: measured 0.8s for a one-file change, 0.7s for a no-op, 8.0s cold, so the first
open of a checkout that has no `graft/` yet is the only slow moment and shows a "building"
state. On demand: a refresh affordance in the lens header calls the same command, which is also
the path for seat worktrees (nothing watches them; extending `file_watch` to seat roots is a
later card, §5). On commit: not available. The post-commit hook does not fire here (§1), and even
where it does it carries no sha; the MVP does not wait for it, because the watcher already sees
the working tree the moment a seat writes, before any commit exists. Commit-time is the wrong
trigger for a live graph anyway; it is the right trigger for attribution, which is §4.

**Where it lives: a sidecar inside the app, not the hub.** The graph is a property of a checkout
on this machine, exactly like the Changes rows from `project_changes_sync` (`lib.rs` L7829),
which already walk every seat worktree. Putting it in the hub would mean shipping 3.6MB per
project per refresh over the tailnet to answer a question the operator's own disk answers in
0.7s, and the remote hub on netcup has no checkout to build from. The hub's role in the MVP is
unchanged: it keeps supplying `file.claim` and card events that the lens overlays on the graph.

**Cost per refresh on this repo.** Warm rebuild 0.7s wall on one core; cold 8.0s; blast for a
diff 0.33s; collapse and serialise about 2.3k edges to the webview, single-digit milliseconds;
disk 18MB under `graft/.cache` plus 3.6MB wiring per checkout, gitignored already. At one build
per quiet second while a seat is writing, that is well under one core-second per edit burst and
zero LLM tokens: graft's wiring tier needs no key, and the `--deep` summaries are never invoked.

**What the MVP explicitly does not do.** No node positions persisted, no heat decay, no
attribution, no Unread. It draws the checkout's file graph, keeps it current with the watcher,
and answers blast radius for the current diff. Everything else composes on top (§4, §5).

## 3. Port or reuse: the Flare engine piece by piece

Read from the clone at `.agent-bus-out/flare` (commit 5adc94b, 2026-09-13). The engine is
`flare/shared/` (7398 lines over 29 files, pure TypeScript, no DOM) and the three views are
`flare/src/components/{CanvasView,WheelView,DistrictsView}.tsx` (1403, 972 and 502 lines) over
`flare/src/graph/{flowLayout,renderModel,lensColor,lenses}.ts`. The verdict per piece is the
first word; the reason follows.

**REUSE: scanner, parser, resolver (`scanner.ts` 132, `parser.ts` 523, `resolver.ts` 282).**
Flare walks the tree with the `ignore` package over `.gitignore`, strips comments and pulls
imports with six regexes (`JS_IMPORT_FROM_RE`, bare import, export-from, `require`, dynamic
`import()`, plus two Python forms, `parser.ts` L172-180, L322-323), then resolves specifiers
through tsconfig `paths` (its own JSONC scanner, `parseJsonc` L79, written because a
regex-stripped tsconfig once "quietly ate `paths` and with it every alias edge"), workspace
packages, extension and index guessing, and Python `__init__`. graft already does all three
with a parser rather than regexes and produced the numbers in §1. The risk the card named,
resolver correctness, is measured rather than assumed: of 2143 import specifiers graft
extracted here, 882 are relative (`./`, `../`) and 864 became distinct file→file `imports`
edges in `wiring.json`, all at confidence `extracted`. The 18-specifier gap, spot-checked, is
repeat imports of one target from one file (counted once as an edge) and non-code assets
(`./assets/react.svg`); no code import checked failed to resolve. Trantor has no tsconfig
`paths` aliases and no workspace packages, which is the case where Flare's resolver earns its
282 lines and graft has nothing to prove. What graft does not compute and Flare does: per-file
`complexity` (a branch-keyword count over comment-stripped source, `parser.ts` L313) and
`todos` (`countTodos`, L314). Those are two small functions the Rust sidecar ports when the
Hotspots lens lands (§5), not before.

**PORT, small: the graph algebra in `graph.ts` (407).** `GraphBuilder` keeps parsed files and
an edge map keyed `"source\ntarget"` with weight = referenced-binding count, and offers
`setAll` (L71), `apply(changed, removed) → GraphPatch` (L85), `neighbors` (L136),
`blastRadius` (reverse BFS, L148), `withBlastRadius(seeds, edges)` (L296, seeds included in
the result), and `findCycles` (iterative Tarjan SCC, L321, components of size > 1 only).
Node derivation adds `cluster` (top directory, or the second level under a "container" dir
such as `apps/` that has no code of its own), `isTest`/`testedBy` (path heuristics, L10),
`orphan` (non-test, nothing imports it, not entry-like, L19), `doc` (prose files stay on the
graph for their links but are exempt from every judgement). All of it is under 200 lines of
plain graph code and ports to the Rust sidecar (§2) over graft's collapsed file edges in an
afternoon: SCC and reverse BFS over 522 nodes and 2278 edges are microseconds. `graft blast`
already answers blast-for-a-diff (§1) and stays the gate's tool; the per-node blast radius
the lens colours by is one reverse BFS per node, which Flare also does eagerly
(`insights.ts` `allBlastRadii`, L236). Edge weight is the one thing dropped: graft's wiring
edges carry no binding-reference count, and no lens in #6878 reads it.

**SKIP for the MVP: `GraphPatch` (`types.ts` L96-103) and the chokidar path.** Flare patches
because its renderer owns node positions and a full graph replacement would reset them;
`electron/session.ts` L412-445 re-parses each changed file and pushes the delta. Our React
side receives 522 nodes and 2278 edges per rebuild (§2), diffs by id in a `useMemo`, and keeps
whatever positions it holds; that is the same outcome with no second wire format. The patch
shape comes back with heat decay (#6878 item 4), when "what changed in this refresh" becomes
a signal the view draws rather than an optimisation.

**PORT, as formulas: lens scoring in `insights.ts` (576) and `review.ts` (145), fed by Trantor's
own data.** The formulas are small and worth keeping verbatim: hotspot = `complexity ×
(min(gitChurn, 50) + sessionChurn × 3 + 1)` normalised to 0-100 (`insights.ts` L258, L332);
unread = `changedAt > 0 && readAt < changedAt`, with the comment that only code changed this
session can be unread, "on a repo you just opened, 100% unread would be true and useless"
(L328-330); `reviewTier` gives `careful` when risk ≥ 60, blast ≥ 10, in a cycle with a
dependent, or uncovered with fan-in ≥ 3; `read` when risk ≥ 30, blast ≥ 3, complexity ≥ 40 or
fan-in ≥ 3; else `skim`, each with its reasons as strings (`review.ts` L52-78). The inputs are
where Trantor differs and wins: `gitChurn` from `git log --format= --name-only` per path, which
`project_changes_sync` already shells for numstat (§1); `sessionChurn` from `project_changes`
rows per seat; `changedAt` from the watcher and from `file.claim` events, both timestamped and
both attributed to a seat by construction. Coverage (`coverage.ts`, 100 lines, an lcov reader)
ports when the Coverage lens lands.

**DO NOT PORT: attribution, bursts, conflicts, shadow snapshots (`attribution.ts` 232,
`activity.ts` 184, `conflicts.ts` 678, `session.ts` snapshot timers).** Flare's watcher "sees a
file change; it does not see who changed it", so `attribution.ts` L1-40 builds a five-rung
ladder (one recorded MCP intent, several intents separated by channel talk, the channel
alone, the board, the only agent running, else `mixed`) and `conflicts.ts` spends 678 lines
deciding when two agents crossed. A burst is a batch of writes attributed by that ladder,
verified by shell commands observed in Flare's own terminals (`activity.ts` L116-121), with a
git shadow snapshot taken 1.5s after the burst as the revert target (`session.ts` L460). None
of that has a job here: each seat writes in its own worktree, so `project_changes` rows carry
the seat as a fact, not a guess; a seat's burst is its uncommitted diff or the commits it
landed for a card; verification is the card's testing note with `verified at <sha>`; the
revert target is the last commit on the seat branch that carried such a note, which git holds
already. #6878 item 3 (review bursts with intent, risk tier, revert-to-last-verified) is
therefore a query over things Trantor records, plus `reviewTier` from the paragraph above.

**PORT the ideas, not the code: the three views.** `CanvasView` draws file cards as DOM
nodes with one SVG for edges (L1139), laid out by `hierarchicalFlowLayout` (`flowLayout.ts`
L204): clusters become blocks ordered left-to-right by inter-cluster dependency depth over
the SCC-condensed graph, longest-path layering inside each block, barycenter sweeps to cut
crossings, deterministic for the same graph; dragged positions persist through
`positions:load/save` into `~/.flare` (`electron/core.ts` L468-470). `WheelView` is a radial
SVG: clusters as arcs, files as ticks, edges as chords. `DistrictsView` is a squarified
treemap (`squarify` L31), area by size, colour by lens, "treemap position is fixed by size,
selection is the affordance" (L266). The layout function is 10.7K of TypeScript with no Flare
dependency beyond `findCycles` and can be vendored as-is under the desktop app; the views
themselves are rewritten against Trantor's primitives and palette (§4), because their 2900
lines are mostly Flare's own drag, drill-in, agent-ring and notice machinery, none of which
matches the data we have. Storage of positions follows the app's existing per-machine prefs
pattern (`desktop/src/features/workspace/prefs.ts`), keyed by project, never the hub.

**Net.** Reused: three files and the hard part (scanner, parser, resolver), by pointing at
graft. Ported: about 200 lines of graph algebra, about 150 lines of scoring formulas, and one
10.7K layout file vendored. Skipped: the patch protocol, chokidar, and 1300 lines of
attribution and conflict guessing that Trantor's worktree-per-seat design makes unnecessary.
Rewritten: the views, against the design system.

## 4. The three views

Three views, in the order #6878 ranks them: the graph, blast radius, unread. Each names the
seam it hangs on, the data it reads (all of it from §1 and §2), what it draws, and the design
rule it must obey. Flare's three renderers (Canvas, Wheel, Districts) are three layouts of
the first view; only one ships in the MVP, and the reason is at the end of 4.1.

### 4.1 The graph: a `graph` view on the Code surface

**Seam.** Not a sixth top-level lens. The project lenses are `workspace · code · board · feed
· bus` (`desktop/src/features/project/ProjectHeader.tsx` L7) and each is an altitude of the
project, not a rendering; a code graph is the Code surface looking at the checkout from above
rather than one file at a time. `Files.tsx` already has an orthogonal view axis on its tab
body, `type ViewMode = "code" | "changes"` (L32), chosen per tab (`codeTabs.ts` L12) and
switched at L442: the diff view when the tab says `changes`, else the editor. `graph` is the
third value of that union, opened by a chip in the ModePane footer next to the scope picker
(the "WHICH COPY" control, `Files.tsx` L326), so it inherits the scope: project checkout or a
seat's worktree, the same `seat` that `read_file` takes. One tab, pinned, keyed by scope, so
switching seats in the footer swaps the graph the way it swaps the tree.

**Data.** `code_graph(project, seat?)` from §2: file nodes with `cluster`, `inDegree`,
`outDegree`, `isTest`, `testedBy`, `orphan`, `cycleId`, `doc`, and the collapsed file→file
edges tagged `imports` or `calls`. Overlaid from what the app already fetches: the
`project_changes` rows (`gitApi.ts` L16-24, one `{seat, path, status, plus, minus}` per
touched path per seat) mark which nodes are dirty and in whose tree; `file.claim` events
(`client.events({type: "file.claim."})`, the same call `Feed.tsx` L76 makes) mark which nodes
a Claude seat is on right now, within the ten-minute claim window. Positions live in the
app's per-machine prefs (`workspace/prefs.ts` pattern), keyed by project; nothing about the
graph is written to the hub.

**Draws.** Flare's flow layout, vendored (`flowLayout.ts`, §3): clusters as blocks left to
right by dependency depth, so `lib/` and `desktop/src/shared/` sit left and `bin/`, `App.tsx`
and the Tauri commands sit right, files as cards inside their block, edges as one SVG layer
underneath. On this repo that is 522 cards in 14 top-level clusters; `graft map` already
groups the same way and names the hubs (`act` in GitPanel.tsx with 50 callers, `drillEnv` in
test/ with 109). Cards are `tr-card` at the smallest size the primitive allows, edges use
`--color-tr-edge`, and colour appears only where the design system lets it appear: in
content and status dots. The default colouring is the calm one, cluster hue at low
saturation, and every lens is a recolour of the same cards, never a second drawing:
Activity (a `tr-dot` per seat on a dirty node, the seat's own hue, the same dots the
Workspace seat tabs wear), Cycles (`cycleId` nodes and their edges in `--color-tr-warn`),
Tests (`testedBy = 0` non-test, non-doc code in `--color-tr-fail` at low alpha, per Flare's
rule that a document "has no tests" is a category error), Hotspots and Risk and Coverage once
their inputs exist (§3, §5). A lens legend is a `tr-seg` in the tab strip, not a floating
panel. Selection is the drill: clicking a card opens the file in a `code` tab under the same
scope through `openPath` (`Files.tsx` L183) and highlights direct dependents and
dependencies; the file's importers and imports list in the right panel (`rightPanelState.ts`
already owns that pane). No drag in the MVP: Flare's drag-with-persisted-positions is 300
lines of `CanvasView` and the flow layout is deterministic, so a relayout gives the same
picture; persistence of positions is a later card.

**Rule 7 applies.** A 522-node canvas is a wall of cards at project zoom. The view opens
collapsed to clusters (Flare's `renderModel.ts` has the same idea, `DIR_PREFIX` dir nodes and
`representingDir`, L46-91): one card per top-level directory with its file count and its
inter-cluster edges, and a cluster expands in place to its files. A seat's dirty files are the
exception and stay visible at cluster zoom as dots on the cluster card, because "what is the
crew doing to the code right now" is the question the view exists to answer.

**Why the flow layout and not the wheel or the districts.** The wheel (radial arcs, chords)
reads dependency direction poorly and has no place to put a dirty-file dot that is not also a
tick mark; the districts (treemap, area by size) are the right picture for Hotspots and
Coverage, where the answer is "how much of the code is in this state", and the wrong one for
dependencies, which are the MVP. Districts land with the Hotspots lens as the second layout,
selected by the same `tr-seg`; the wheel does not land.

### 4.2 Blast radius: a number that rides the testing move

**Seam.** Not a view of its own first; a fact attached to three surfaces that exist. The
seat side is `hooks/lib/hollow-move.mjs`, which `relay_task_move` calls at report time to
gather evidence from the worktree before a `testing` or `done` move lands (`mcp.mjs`
L224-235): it already reads the diff to decide whether the move is hollow. That is where
`graft blast --base <merge-base> --depth all --format json` runs (0.33s, §1) and its
`changed[]` paths plus the transitive dependents count are appended to the card note as one
line, `blast: 7 files depend on the 3 changed`, and posted to the hub with the move as a
`blast` field on the card event, so the count sits on the card's permanent log next to
`verified at <sha>`. The hub side needs no code beyond keeping the field. The operator side
is the gate list in `Overseer.tsx` L274-300, which renders each `verify.gate.opened` as a
`tr-card` with the claim: the same card gains the blast line when the gate's card carries
one, and the `careful` tier from `reviewTier` (§3) when blast ≥ 10 or the change sits in a
cycle, so "hold changes until the gate is independently resolved" is a button next to a
reason rather than next to a claim.

**Data.** `graft blast` over the seat's worktree, base = the card's `base:` sha or
`merge-base main HEAD`; `code_graph` for `cycleId` and `testedBy` of the changed paths;
`reviewTier` inputs from §3 without coverage (coverage is null until the lcov reader lands,
and the tier function already treats null as uncovered only for the `careful` rule).

**Draws.** In the Changes tab of the Code surface (`ChangesView`, the diff of one file), a
`tr-chip` in the tab strip: `N dependents`, click to select those nodes on the graph view
under the same scope. In the Overseer gate card, one muted line under the claim. On the
Board card, nothing new: the note already carries it. No colour beyond the chip's `tr-warn`
when the tier is `careful`. A blast of zero is shown as `0 dependents`, never hidden; a
package.json or tauri.conf.json change is shown as `not in the graph`, which is what graft
says (§1), because a silent zero on a config file is the false comfort the gate exists to
remove.

### 4.3 Unread: the comprehension-debt lens

**Seam.** The signal does not exist yet (§1: `CodeView.tsx`, `Files.tsx`, `FileTree.tsx`
never tell the hub a human opened a file). It is created at one place: `openPath` in
`Files.tsx` L183, the single function every open in the Code surface goes through, posts
`{project, file, seat}` to a new hub route `POST /read`, a sibling of `POST /claim`
(`hub/routes/admin.mjs` L270-286) with the same shape and the same throttle (first touch in a
window emits the event, repeats do not), appending `file.read {file, seat}` by the operator's
session. It is posted only when the app is the reader: the desktop app's own session id,
never a seat's, so the event means what the lens needs it to mean. `file.read` is one more
dotted type in the log (`hub/events.mjs`), readable through `GET /events?type=file.read.` and
live over SSE like every other event; nothing else in the hub changes.

**Data.** For each node: `changedAt` = the latest of the watcher's `file-changed` stamp for
that path in the scope's tree and the newest `file.claim` on it; `readAt` = the newest
`file.read` on it by a human session. Flare's rule, kept exactly (§3): unread when
`changedAt > 0 && readAt < changedAt`, and nothing is unread on a repo the operator merely
opened. Because `changedAt` comes from seats and `readAt` from the operator, the lens is by
construction "code the crew wrote that no person has looked at", which is the testing-lane
rot in code space that #6878 item 2 asks for.

**Draws.** A recolour of the graph (4.1): unread nodes in `--color-tr-fail` at low alpha,
changed-and-read in `--color-tr-ok`, everything else the calm default; the legend is the same
three swatches Flare uses ("changed, not read", "changed and read", "unchanged this session",
`lenses.ts` L111-113). And one number at fleet altitude, where the design system says fleet
facts live: a stat on the Home view, `unread: 14 files across 3 projects`, computed from the
same events, because the operator's question at Home is "how much crew code have I not seen",
not "which file". Opening a file from the graph under this lens is the act that clears it,
which is why the read event is posted by `openPath` and not by the editor mounting: a file
opened is a file looked at; a file scrolled past in a diff is not.
