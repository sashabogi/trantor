# PRD: Trantor State — structured execution state for the harness (rev 2)

**Status:** rev 2, re-review after unanimous REVISE (card #6882) · **Owner:** operator + orchestrator
**Date:** 2026-09-08 · **Prior art:** SKILL.state (Badhe, Tiwari, Chung, EMNLP; arXiv 2608.26263)

> **What changed in rev 2** (each maps to a review gap): §3 now gives a typed **patch grammar**
> with explicit per-field ops (no more "dict merge"); §3.1 defines the **validator + retry +
> fallback**; §3.2 defines **tail and notes token budgets** so O(1)/step is provable; §4 Phase 2 is
> **re-scoped for the multi-CLI reality** (we do not control codex/opencode sessions — see §4.2);
> `verify{}` is **harness-written, never model-patched** (§3); §3.3 adds **schema versioning**; §5
> gives **baselines and per-phase exit gates**; and **Phase 3 (the multi-agent merge) is moved to
> its own PRD** (`docs/PRD-trantor-state-merge.md`), leaving this PRD to Phases 0–2 (+4 stretch).

---

## 1. Context — why (unchanged)

Trantor's succession machine exists to fight the **append-only transcript**: it grows, context
fills (the 90% baton), turns poison, sessions hand off, we compress the world into a prose handoff
record. SKILL.state's answer: carry an explicit, mutable, validated **execution state**; the model
sees the skill spec + current state + latest observation, emits a patch + action, and the reasoning
is discarded after the patch validates. Tokens go O(T²)→O(T); their headline is **zero recovery
steps when the world changes underneath the agent**.

We already do half of this: the board is external mutable state; sidecars are structured state;
`#6094` was us learning history lies and current state is truth. **Our own bugs are the case for it:**
`#6528` (a prose handoff's STATE elided by a 4KB cap — a typed object cannot lose a field), the
09-07 crebral-health strandings, and the crossed-wires stale-transcript incidents.

## 2. Vision (unchanged, scope tightened)

A structured, mutable, validated **WorkingState** object is the unit of a seat's working memory,
carried across turns and handoffs. **This PRD covers the single-seat substrate (Phases 0–2) and the
learning stretch (Phase 4).** The multi-agent merge operator — SKILL.state's stated open problem —
is its own initiative in `docs/PRD-trantor-state-merge.md`, gated on this substrate proving out.

## 3. The state model + patch grammar

```
WorkingState (schema_version: 2) {
  card:        number
  task:        string                 # one line, set once
  done:        Item[]                 # Item = { id: string, text: string }  (verified steps)
  in_flight:   Item[]
  next:        Item[]
  blockers:    Item[]                 # text names what unblocks it
  files:       Record<path, { touched: bool, verified: bool, blast_radius?: number }>
  verify:      { built?: bool, tested?: bool, observed?: bool, cmd?: string, exit?: number }
                                       # HARNESS-WRITTEN ONLY — see below
  notes:       string                 # bounded free text (§3.2)
  cursor:      { turn: number, ts: number, by: string }   # runtime-written provenance
  schema_version: number
}
```

**Patch grammar (explicit — replaces "dict merge").** A turn emits `{ patch: Op[], action }`. Each
`Op` is one of, applied in order:
- `{ set: { field, value } }` — scalar/object field (`task`, a `files[path]` entry, a `notes`
  replace). Object fields deep-merge one level; `value:null` deletes the key.
- `{ add: { list, item } }` — append an `Item` to `done|in_flight|next|blockers` (id assigned by
  the runtime if absent).
- `{ remove: { list, id } }` — remove by id.
- `{ move: { id, from, to } }` — the common case: an `in_flight` item becomes `done` (or `next`→
  `in_flight`). Atomic; no duplicate.
- **`verify` is not patchable by the model.** The runtime writes `verify` from the actual gate
  (the build/test/observe commands the harness ran); a model op targeting `verify` is rejected by
  the validator. This closes the "a seat sets its own `tested:true`" hole.

Arrays therefore never "merge ambiguously": they change only through `add`/`remove`/`move` by id.

### 3.1 Validator + retry + fallback

Applying a patch is: **validate → apply to a copy → persist**, never mutate in place.
- **Validate:** JSON-schema (types, required `card`+`task`+`schema_version`, no unknown keys),
  size limits (§3.2), and semantic rules (`move` endpoints exist; no `verify` op; ids unique).
- **On invalid:** the runtime **does not persist**, returns the specific error to the model, and
  retries the SAME turn up to `PATCH_RETRIES` (default 2). Persisted state is never corrupted.
- **On persistent failure:** after the retries, the runtime falls back to **carrying the last valid
  state unchanged** and appending the raw observation to the tail (§3.2) — i.e. it degrades to the
  transcript path for that step and flags it. The turn is never lost.
- Cheap-seat guardrail: the grammar is small enough for **grammar-constrained decoding** where the
  provider supports it (§7); where it doesn't, the validator + retry is the floor.

### 3.2 Bounded by construction (so O(1)/step is provable, not hoped)

Every carried piece has a hard cap; the prompt each step is `skill_spec + WorkingState + tail +
latest_observation`, and each term is bounded:
- `notes`: ≤ `NOTES_CAP` (default 2 KB). A `set` that would exceed it is rejected; the seat must
  summarize into structured fields instead.
- lists: ≤ `LIST_CAP` items each (default 40); `done` compacts oldest-first past the cap into a
  single `done_count` scalar.
- `files`: ≤ `FILES_CAP` (default 200) most-recently-touched; older entries drop to a count.
- `tail`: a **token-budgeted** window, ≤ `TAIL_TOKENS` (default 2 K), most-recent-first, evicted
  by token count, not message count.
So `|prompt|` is bounded by `skill_spec + (capped state) + TAIL_TOKENS + one observation` — O(1) in
T. This is the measurable claim, not a vibe.

### 3.3 Versioning + migration

`schema_version` is on every object. The runtime carries a migration table
`migrate[v→v+1]`; an older handoff/state is upgraded on read, never silently dropped (the #6528
lesson generalized: a field a new schema doesn't know goes to `notes` under a `migrated:` prefix,
not to /dev/null). A patch whose `schema_version` the runtime can't migrate is rejected loudly.

## 4. Phased plan

### Phase 0 — schema + patch/validate/merge core
`WorkingState` (types), the `Op[]` grammar, the validator (§3.1), the bounded-apply (§3.2), the
migration table (§3.3). Pure, no UI, no harness. **Exit:** a property-test suite proves: no valid
patch corrupts state; every array change is add/remove/move-by-id; `verify` ops are always
rejected; caps hold; a v1 object migrates to v2 with zero field loss.

### Phase 1 — handoff as structured state (single-agent, immediate payoff)
The handoff record becomes a `WorkingState`, built by the Stop-hook path, validated on write, so
STATE cannot be elided (`#6528`). The successor's kickoff loads the object directly and the harness
renders it into the recap prompt. **Fallback:** the current prose handoff stays behind
`TRANTOR_STATE_HANDOFF=0` until Phase 1 passes. **Exit:** 10 real handoffs carry a complete,
schema-valid STATE (0 dropped fields); a successor drilled on a mid-turn handoff recaps from the
object with no missing thread; the prose path can be turned off on one dogfood project.

### Phase 2 — feed state instead of transcript, WHERE WE CONTROL THE SESSION
The crew's finding (`crew-runner.mjs:266-292`): a seat resumes on **its provider CLI's own
session**, which owns its history. We do **not** control codex's or opencode's context assembly, so
"feed state instead of the transcript" is only literally true for sessions the harness assembles.
So Phase 2 splits:

- **§4.2a — harness-assembled seats (Claude Code via our hooks):** the harness injects
  `WorkingState` and prunes/omits transcript per §3.2. Here the full SKILL.state win applies — O(1)
  prompt, longer runs, cheaper. **Exit:** on a real multi-turn card, cumulative tokens trend O(T)
  and beat the transcript baseline by ≥5× (§5), with equal or better task success.
- **§4.2b — foreign-CLI seats (codex/opencode/glm):** we cannot replace their transcript. What we
  CAN do, and what Phase 2 delivers for them: (1) inject the compact `WorkingState` as an **input**
  each contract (a state doc / MCP resource) so the seat reads current state instead of re-deriving
  it from its own history, and (2) on resume, hand it the state object, not a prose digest. The win
  is a better, cheaper *starting* context and elision-proof handoffs — **not** runtime transcript
  replacement. The PRD states this honestly; we do not claim O(T) for seats whose sessions we don't
  own. **Exit:** a foreign-CLI seat resumes from a `WorkingState` input and does not re-read files
  it already recorded as `done`/`touched` (measured against a baseline resume).

### Phase 4 — learning as deltas (stretch)
Lessons (`scrooge learn`, `relay_lesson`, memory) become validated patches to the **skill spec**,
keeping the sufficient statistic, not the paragraph. Same validator discipline. Deferred until
Phases 0–2 prove the machinery. (Phase numbering keeps 3 reserved for the merge PRD.)

## 5. Success metrics — with baselines and exit gates

Each is measured against a **recorded baseline**: the token/turn curve of a chosen dogfood card run
today on the transcript path (captured before Phase 2).
- **No handoff elision:** every Phase-1 handoff is schema-valid with 0 dropped fields (vs the #6528
  incident). Gate for Phase 1.
- **Token cost (harness-assembled seats):** cumulative tokens on the dogfood card trend O(T) and are
  ≥5× below the recorded transcript baseline at equal turns. Gate for Phase 2a.
- **Longer runs:** median turns-per-card before a forced reaper/time-box cut rises vs baseline.
- **Zero-recovery on state change:** reproduce the paper's Table 3 on our bus — change a card/files
  under a seat mid-run; the seat acts on current state with no hallucinated recovery burst. Gate.
- **Foreign-CLI resume (Phase 2b):** a resumed seat re-reads ≥50% fewer already-`done` files than a
  baseline resume.

## 6. Non-goals

- Not replacing the append-only **record** (audit/provenance keeps it — SKILL.state's own failure
  case #3).
- Not a purist no-transcript runtime — **hybrid**, bounded tail + notes.
- Not the multi-agent **merge operator** — that is `docs/PRD-trantor-state-merge.md`.
- Not a rewrite of the bus/board/herdr — this is the memory model under them.
- Not claiming O(T) for foreign-CLI seats whose sessions we do not assemble (§4.2b).

## 7. Risks / open questions still live for the TDD

- **Grammar-constrained decoding coverage:** which providers support it; is validator+retry enough
  for glm-flash/deepseek without it? (Measure in Phase 0 with recorded cheap-seat patch error rates.)
- **Schema generality:** is the fixed `WorkingState` enough, or do we need a small per-project
  extension block (`ext: Record<string, Json>`, still capped)? Decide in the TDD.
- **Persistence + concurrency (single-seat):** where the object lives (a sidecar per seat-card), how
  a crashed turn recovers the last valid state, atomic write. TDD must specify.
- **Dogfood project + baseline capture:** which project runs it first, and capturing the transcript
  baseline before we change anything, or the ≥5× claim is unfalsifiable.
- **CodeGraph / Graft dependency:** `files.blast_radius` is fed by the graph engine. The 09-08 Graft
  trial (457 files, 7 s, $0, precise `graft ask`) suggests Graft (MCP, Tree-sitter) is the engine —
  sequence so State can consume it, and don't block Phase 2 on it (`blast_radius` is optional in the
  schema).

## 8. Process

This rev goes back to the same PRD-review roster on card #6882. On pass → a TDD
(`docs/TDD-trantor-state.md`) authored by one seat, same review. Build incrementally behind
`TRANTOR_STATE_*` flags with the transcript path as fallback per phase; each phase hits its exit
gate on a real project before the next. Prove the substrate before the merge PRD opens.
