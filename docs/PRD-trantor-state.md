# PRD: Trantor State — structured execution state for the harness (rev 3, ACCEPTED)

**Status:** rev 3, ACCEPTED by crew PRD review (card #6882: 2 READY, 1 one-edit-from-READY, 2
close-REVISE; operator folded the edits in, no third round). Proceed to TDD.
**Owner:** operator + orchestrator · **Date:** 2026-09-08
**Prior art:** SKILL.state (Badhe, Tiwari, Chung, EMNLP; arXiv 2608.26263)

> **Rev 3 folds the review's merged edits:** `action` is defined (§3); a field **write-matrix**
> (§3.0) makes `verify`, `files[].verified`, `cursor`, `card`, `schema_version` harness/runtime-only;
> the compaction scalars `done_count`/`files_count` are in the schema and compaction is a runtime op
> (§3, §3.2); **content sizes are capped**, not just counts (§3.2); the crew's mechanism corrections
> are in Phase 2a (§4.2 — a **fresh stateless call** with state placed **after the stable preamble**
> so prefix-caching survives, and the gate is on **cost**, not raw tokens); and **Phase 2b
> (foreign-CLI) is dropped from this PRD** to a follow-up (§2, §6). Rev 1→2 already added the patch
> grammar, validator, bounds, versioning, exit gates, and the honest scope split; rev 2→3 is the
> polish that made it buildable.

---

## 1. Context — why

Trantor's succession machine exists to fight the **append-only transcript**: it grows, context
fills (the 90% baton), turns poison, sessions hand off, we compress the world into a prose handoff.
SKILL.state's answer: carry an explicit, mutable, validated **execution state**; the model sees the
skill spec + current state + latest observation, emits a patch + action, and the reasoning is
discarded after the patch validates. Tokens go O(T²)→O(T); its headline is **zero recovery steps
when the world changes underneath the agent**. We already do half of it (the board is external
mutable state; sidecars are structured state; `#6094`). **Our own bugs are the case:** `#6528` (a
prose handoff's STATE elided by a 4KB cap — a typed object cannot lose a field), the crebral-health
strandings, the crossed-wires stale-transcript incidents.

## 2. Vision + scope

A structured, mutable, validated **WorkingState** object is a seat's working memory, carried across
turns and handoffs. **This PRD is Phases 0–2a (+4 stretch), single-seat, and only where the harness
assembles the prompt.** Two things are explicitly OUT, each to its own future PRD:
- the **multi-agent merge operator** (`docs/PRD-trantor-state-merge.md`) — SKILL.state's open problem;
- **foreign-CLI seats** (`docs/PRD-trantor-state-foreign.md`) — codex/opencode/glm resume on their
  provider's own session, which we do not assemble, so state-as-runtime is not available there. We
  can still hand them a compact state *input*, but that is a smaller, separate design (unanimous
  scope cut). This PRD does not claim any token win for seats whose sessions we do not own.

## 3. The state model + patch grammar

```
WorkingState (schema_version: 3) {
  card:        number                 # runtime-written (the card this state serves)
  task:        string                 # set once at open; model-immutable after
  done:        Item[]                 # Item = { id: string, text: string(<=ITEM_CAP) }
  done_count:  number                 # runtime-maintained: items compacted off `done` past LIST_CAP
  in_flight:   Item[]
  next:        Item[]
  blockers:    Item[]
  files:       Record<path, { touched: bool, verified: bool, blast_radius?: number }>
  files_count: number                 # runtime-maintained: paths compacted off `files` past FILES_CAP
  verify:      { built?, tested?, observed?, cmd?, exit? }   # HARNESS-WRITTEN (see §3.0)
  notes:       string(<=NOTES_CAP)    # bounded free text — the open-ended tail of reasoning
  cursor:      { turn, ts, by }       # runtime-written provenance
  schema_version: number              # runtime-written
}
```

### 3.0 Field write-matrix (who may write what)

| field | model may patch | written by |
|---|---|---|
| `task` | only while empty (set-once) | model (open), then immutable |
| `done`/`in_flight`/`next`/`blockers` | yes (add/remove/move) | model |
| `files[path].touched` | yes | model or harness (harness on observed edits) |
| `files[path].verified` | **no** | **harness** (from the actual gate) |
| `files[path].blast_radius` | no | harness (from CodeGraph/Graft, optional) |
| `verify` | **no** | **harness** (from the build/test/observe it ran) |
| `card` / `schema_version` / `cursor` / `done_count` / `files_count` | **no** | **runtime** |

A patch targeting any harness/runtime-only field is **rejected** by the validator. This closes the
"a seat marks its own work verified" hole for both `verify` and `files[].verified`.

### 3.1 Patch grammar + `action`

A turn emits `{ patch: Op[], action }`.
- **`action`** is the seat's actual next move: `{ tool: string, input: object }` for a tool call, or
  `{ done: true }` to end the card, or `{ ask: string }` to surface a question. It is what the seat
  *does*; the `patch` is how it records *why/where it is*. The runtime executes `action` and feeds
  its result back as the next observation. `action` is required; a turn with a patch and no action
  is rejected (a seat must always either act, finish, or ask).
- **`Op`** (applied in order): `{ set: { field, value } }` (scalar/object; objects deep-merge one
  level; `value:null` deletes an optional key; deleting a required key or setting a harness/runtime
  field is rejected); `{ add: { list, item } }`; `{ remove: { list, id } }`;
  `{ move: { id, from, to } }` (atomic, no dup). **A `move … to: "done"` is only accepted when the
  item's work is harness-verified** — i.e. the relevant `verify`/`files[].verified` is true; else the
  move is rejected and the seat is told why. Arrays change only by add/remove/move by id.

### 3.2 Bounded by construction (so O(1)/step is provable)

The prompt each step = `skill_spec + WorkingState + tail + latest_observation`, and **every** term is
capped — counts AND content:
- `ITEM_CAP` (item text, default 240 chars), `PATH` entries bounded by length, `NOTES_CAP` (2 KB),
  `LIST_CAP` (40/list; overflow compacts oldest into `done_count` etc. — a **runtime** op, not a
  model op), `FILES_CAP` (200; overflow → `files_count`), `TAIL_TOKENS` (2 K, token-budgeted
  eviction), and the `latest_observation` is truncated to `OBS_CAP` tokens. `skill_spec` is a fixed
  immutable input. So `|prompt|` is O(1) in T — the measurable claim.

### 3.3 Versioning + migration

`schema_version` on every object; a `migrate[v→v+1]` table upgrades older state/handoffs on read; a
field a newer schema doesn't know goes to `notes` under a `migrated:` prefix, never dropped (#6528
generalized); an unmigratable patch is rejected loudly.

## 4. Phased plan

### Phase 0 — schema + patch/validate/merge core
Types, the `Op[]` grammar + `action`, the validator (write-matrix + schema + caps + semantic rules),
bounded-apply, migration. Pure, no UI. **Exit:** property tests prove — no valid patch corrupts
state; arrays change only by id; harness/runtime fields are never model-writable; a `move→done`
without verification is rejected; caps hold on counts and content; v2→v3 migrates with zero field
loss.

### Phase 1 — handoff as structured state
The handoff record becomes a `WorkingState`, built by the Stop-hook path, validated on write, so
STATE cannot be elided (`#6528`). The successor's kickoff loads the object directly. **Fallback:**
prose handoff behind `TRANTOR_STATE_HANDOFF=0` until Phase 1 passes. **Exit:** 10 real handoffs carry
a schema-valid STATE (0 dropped fields); a mid-turn handoff drill recaps from the object with no
missing thread; the prose path is turned off on one dogfood project.

### Phase 2a — feed state instead of transcript, harness-assembled seats (Claude Code)
Per the crew's mechanism correction: the win comes from a **fresh, stateless invocation each step**
(a `-p`-style call the harness assembles), NOT from pruning a live resumed (`-c`) session — and the
`WorkingState` block is placed **after the stable preamble** (skill spec / system) so the provider's
**prefix cache** still hits and we don't pay full price for the preamble each step. The harness
assembles `preamble + WorkingState + tail + observation`, runs the seat, applies the returned patch.
**Exit gate is on COST, not raw tokens** (the transcript baseline is ~90% cached input at ~10% cost,
so raw token counts overstate the win): on a real multi-turn card, **cost trends O(T) and is ≥5×
below the recorded transcript baseline** at equal-or-better task success. Also: reproduce the paper's
zero-recovery result — change a card/files under a seat mid-run; it acts on current state with no
hallucinated recovery burst.

### Phase 4 — learning as deltas (stretch)
Lessons become validated patches to the **skill spec** (the sufficient statistic, not the
paragraph), same validator discipline. Deferred until 0–2a prove out.

## 5. Success metrics — baselines + gates

Measured against a **recorded baseline** (the cost/turn curve of a chosen dogfood card on the
transcript path, captured before Phase 2a):
- No handoff elision — schema-valid, 0 dropped fields. **Phase 1 gate.**
- **Cost** (not raw tokens) trends O(T) and ≥5× below baseline for harness-assembled seats at equal
  success. **Phase 2a gate.**
- Longer median turns-per-card before a forced cut vs baseline.
- Zero-recovery on state change (paper's Table 3 reproduced on our bus). **Gate.**

## 6. Non-goals

- Not replacing the append-only **record** (audit/provenance — SKILL.state failure case #3).
- Not purist — **hybrid**, bounded tail + notes.
- **Not the multi-agent merge operator** (its own PRD).
- **Not foreign-CLI seats** (its own PRD; no token claim for sessions we don't assemble).
- Not a rewrite of the bus/board/herdr — the memory model under them.

## 7. Risks / open questions the TDD must answer

- **Persistence + concurrency (single-seat):** where the object lives (a sidecar per seat-card), the
  atomic write (temp+rename/fsync), and crash recovery of the last valid state after a killed turn.
- **State ↔ board ownership:** the board card is the shared, human-facing record; `WorkingState` is
  the seat's private execution memory. The TDD must draw the line: what promotes from state to a card
  note (verified `done`, blockers) and what stays private (in_flight scratch, tail).
- **Grammar-constrained decoding coverage per provider;** cheap-seat invalid-patch rate measured in
  Phase 0, and the fallback/invalid-patch budget past which a phase gate fails.
- **Per-project extension:** whether `WorkingState` needs a small capped `ext: Record<string,Json>`.
- **Dogfood project + baseline capture first** (or the ≥5× cost claim is unfalsifiable).
- **CodeGraph/Graft dependency** for `blast_radius` — optional in the schema; the 09-08 Graft trial
  (457 files, 7 s, $0, precise `graft ask`) makes Graft (MCP, Tree-sitter) the likely engine;
  Phase 2a must not block on it.

## 8. Process

PRD ACCEPTED (rev 3). Next: one crew seat authors `docs/TDD-trantor-state.md` from this PRD (same
review roster, minus the author). Build incrementally behind `TRANTOR_STATE_*` flags with the
transcript path as fallback per phase; each phase hits its exit gate on a real project before the
next. Prove the substrate before the merge and foreign-CLI PRDs open.
