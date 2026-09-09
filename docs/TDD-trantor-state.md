# TDD: Trantor State — structured execution state for the harness

**From:** `docs/PRD-trantor-state.md` rev 3 (ACCEPTED, card #6882) · **Card:** #6884
**Author:** `claude:trantor` (does not review its own design) · **Date:** 2026-09-08
**Status:** for crew design review. No build until this passes.

Scope is the PRD's: Phases 0, 1 and 2a, single seat, and only where **we** assemble the prompt.
The multi-agent merge operator and foreign-CLI seats stay in their own PRDs and are not designed
here. **Phase 4 (learning as deltas) is deliberately undesigned until the 2a gate passes** — the
PRD defers it, and designing a skill-spec patcher on top of a substrate whose cost claim is
unproven would be work we might throw away. When 2a's gate is green, Phase 4 gets its own section
here or its own TDD; until then this document makes no claim about it. Every claim below that says "verified" was run today on this machine; everything
else is a design proposal and is labelled as one.

---

## 0. Two facts measured before designing

The PRD's Phase 2a rests on two mechanism assumptions. Both were tested against the real CLI
(`claude 2.1.257`) before this design was written, because a design that assumes them wrongly is
worthless.

**(1) The Claude CLI can be told to return a schema-validated object.** `--json-schema <schema>`
with `-p --output-format json` returns the object under `structured_output`, already validated by
the CLI, alongside `result` as text. Verified:

```
$ claude -p "…" --model claude-haiku-4-5-20251001 \
    --json-schema '{"type":"object","properties":{"patch":{…},"action":{…}},"required":["patch","action"]}' \
    --output-format json
… "structured_output":{"patch":[{"op":"add","path":"/in_flight/-","value":"wrote the TDD"}],"action":{}} …
… "stop_reason":"tool_use" …
```

So on Claude seats the patch channel is CLI-enforced, not prompt-hoped. `stop_reason: tool_use`
tells us how: structured output is delivered as a tool call, which matters for §4.6.

**(2) The provider prefix cache survives a fresh `-p` invocation.** Two independent `claude -p`
processes, same preamble, minutes apart:

| call | `cache_creation` | `cache_read` | `input` | `output` | `total_cost_usd` |
|---|---|---|---|---|---|
| 1 (cold) | 47,441 | 0 | 10 | 591 | 0.0978 |
| 2 (warm) | 32,220 | 212,183 | 46 | 1,763 | 0.0945 |

The 212k cache read is the assumption holding: a stateless per-step call does **not** pay full
price for the preamble. Two things the table also says, which shape the design:

- The preamble alone is ~47k tokens of cache creation for a trivial prompt. The `WorkingState`
  block will be ~1–2k. **State is not the cost driver; the preamble and the output are.**
- Warm call cost barely moved, because 1,763 output tokens (492 of them thinking) dominated.
  **The Phase 2a gate on cost is right and a gate on input tokens would have been a lie.** It also
  means the ≥5× claim is mostly a claim about *not re-reading a growing transcript*, and it can be
  swamped by thinking tokens. §8 turns that into a measured pre-condition rather than a hope.

---

## 1. Architecture

Three layers, strictly separated so that Phase 0 can land, be tested, and ship value with no
runner and no hook changes at all.

```
                    ┌──────────────────────────────────────────────┐
  drivers           │ Phase 1: Stop-hook handoff   Phase 2a: runner │
  (who calls it)    │ hooks/stop-inbox.mjs         bin/crew-runner  │
                    └───────────────┬──────────────────────────────┘
                                    │ readState / applyTurn / assemble
                    ┌───────────────▼──────────────────────────────┐
  store             │ lib/state/store.mjs                          │
  (where it lives)  │ sidecar per seat-card · atomic write · rev CAS│
                    │ ops journal · recovery                       │
                    └───────────────┬──────────────────────────────┘
                                    │ pure functions, no I/O
                    ┌───────────────▼──────────────────────────────┐
  core              │ schema.mjs · validate.mjs · apply.mjs         │
  (what is true)    │ migrate.mjs · promote.mjs · assemble.mjs      │
                    └──────────────────────────────────────────────┘
```

**The core is pure.** No `fs`, no `fetch`, no clock, no env. `applyTurn(state, patch, ctx)` is a
function of its arguments; `ctx` carries the clock and the harness facts (verify results, touched
paths) the caller already knows. This is what makes the Phase 0 property tests worth anything.

**The store is the only writer.** The model never writes the file; it returns a patch as data, and
exactly one process (the turn's owner) applies it at exactly one point (the turn boundary). §4.4
explains why that single apply point is also the whole crash-recovery story.

**Drivers are thin.** Each driver's job is to turn its world into `(state, patch, ctx)` and hand
the result back. A driver contains no schema knowledge and no cap arithmetic.

---

## 2. The ownership row (SYSTEM-CONTRACT §4)

The constitution says a new state file requires a row in the ownership table **before it exists**.
This design proposes exactly one new state file, and this is its row. Adding it to
`docs/SYSTEM-CONTRACT.md` §4 is work package **P0.5**, and it lands with Phase 0, not after.

| Concern | Single owner | Writers | Consumers | Never |
|---|---|---|---|---|
| Seat execution state (`WorkingState`) | `lib/state/store.mjs` | the turn owner only — crew-runner (Phase 2a), Stop hook (Phase 1), `trantor state` CLI (repair) | assembler, handoff writer, board promoter, `trantor state show` | the model writing the file directly; a second process applying a patch; the app or the hub writing it |

Two consequences worth stating out loud, because they are the design:

- **`WorkingState` is private working memory, not the record.** The board and the event log remain
  the shared, human-facing, audited truth (PRD §6). State is derived-and-discardable: delete every
  sidecar and the project is intact, seats just start their next card cold.
- **State never becomes a second source of truth for anything the board already owns.** Card
  status lives on the card. `state.card` is a pointer, not a copy.

---

## 3. Interfaces — the wire contract

`lib/state/schema.mjs` owns these. The shapes are the PRD's §3 with the ambiguities closed.

```js
/** @typedef {{ id: string, text: string, paths?: string[] }} Item   // id <= CAPS.ID, text <= CAPS.ITEM */
/** @typedef {{ touched: boolean, verified: boolean, hash?: string, blast_radius?: number }} FileFact
 *  // every field harness-written; `hash` = the path's blob sha when the gate credited it (§4.2) */

/** @typedef {{
 *   schema_version: 3,
 *   card: number,
 *   task: string,
 *   done: Item[], in_flight: Item[], next: Item[], blockers: Item[],
 *   done_count: number, files_count: number,
 *   files: Record<string, FileFact>,
 *   verify: { built?: boolean, tested?: boolean, observed?: boolean, cmd?: string, exit?: number },
 *   notes: string,
 *   ext: Record<string, unknown>,
 *   cursor: { turn: number, ts: number, by: string },
 *   rev: number
 * }} WorkingState */
```

`rev` is new (not in the PRD) and is store-owned: a monotonic write counter used for the
compare-and-swap in §4.4. It is rejected on any model patch, like `cursor`.

`Item.paths` is the **evidence marker, made structural**. A model writes it inline —
`"wire the promoter @lib/state/promote.mjs,test/state/test-promote.mjs"` — and the validator
extracts it into `paths` *before* any cap is applied, with one pinned regex that lives in
`schema.mjs` and nowhere else:

```js
export const EVIDENCE_MARKER = /\s+@((?:[\w./-]+)(?:,[\w./-]+)*)\s*$/;
```

Order matters and is the whole point of making it structural: **extract, then cap.** `CAPS.ITEM`
(240) applies to the prose remainder only, so a long item text can never silently truncate away the
paths that route (b) of §4.2 depends on — the failure the review caught. If the prose still exceeds
`CAPS.ITEM` after extraction it is truncated normally; if the marker itself is malformed (a path
over `CAPS.PATH`, more than `CAPS.ITEM_PATHS` entries, or a path escaping the worktree) the op is
rejected with `CAP` naming the marker, never accepted-and-trimmed. A patch may also set `paths`
directly; the two routes converge on the same validated field.

`ext` is the PRD §7 open question, answered **yes** in §7.4.

### 3.1 Caps — one table, one place

```js
export const CAPS = {
  ID: 32,           // chars per item id — ids render into the prompt and key every array op
  ITEM: 240,        // chars per item PROSE, after the evidence marker is extracted
  ITEM_PATHS: 8,    // evidence paths per item
  PATH: 400,        // chars per files key
  NOTES: 2048,      // bytes of the notes tail
  LIST: 40,         // items per list; `done` overflow compacts into done_count, the
                    // working lists reject instead — see below
  FILES: 200,       // paths; overflow compacts into files_count
  EXT_KEYS: 8, EXT_BYTES: 4096,
  TAIL_TOKENS: 2000, OBS_TOKENS: 4000,
  TASK: 400,
};
```

Every cap is enforced in `validate.mjs` and asserted in `test/state/test-caps.mjs`. There is no
second copy of any number anywhere in the tree; a driver that wants a cap imports `CAPS`.

**Overflow is not uniform across the lists, and the schema says which is which.** Only `done` and
`files` have a `_count` companion, because only they are append-only history: their overflow is
*compaction*, oldest entries folded into a number that keeps the total honest. `in_flight`, `next`
and `blockers` have no `_count` field and are not getting one — they are working lists, so an `add`
that would take one past `CAPS.LIST` is a **`CAP` rejection naming the list**, not a silent drop.
The asymmetry is deliberate: silently dropping the oldest blocker is the single worst thing this
state object could do, and a seat holding 40 in-flight items has a problem no cap can fix, so the
rejection is the useful signal. An earlier draft said all list overflow compacts into
`<list>_count`, which named three fields that do not exist.

`ID` is in that table for the same reason as the rest, and it was missing from an earlier draft:
`Item.id` is state content — it renders into every prompt and keys every array op — so an
uncapped id is a hole straight through the "bounded by construction" claim, reachable by one model
emitting a 4KB id. Over-long ids are a `CAP` rejection, not a truncation: a trimmed id would no
longer address the item the next op names.

### 3.2 The turn envelope

```js
/** @typedef {{ tool: string, input: object } | { done: true } | { ask: string } | { continue: true }} Action */
/** @typedef {{ patch: Op[], action: Action }} TurnResult */
```

`Op` is the PRD grammar, expressed as a tagged union with exactly one key:

```js
{ set:    { field: string, value: unknown } }   // scalars + one-level object deep-merge; null deletes an optional key
{ add:    { list: "done"|"in_flight"|"next"|"blockers", item: Item } }
{ remove: { list: ListName, id: string } }
{ move:   { id: string, from: ListName, to: ListName } }
```

`{ continue: true }` is an addition to the PRD's three actions and is explained in §4.6. It is the
honest name for "this step did work through my own tools and is not finished"; without it, a Claude
seat mid-card would have to lie with `{ done: true }` or spam `{ ask }`.

### 3.3 The validator's error shape

Rejection is a first-class output, not an exception, because the rejection text is fed back to the
seat as its next observation:

```js
/** @typedef {{ ok: true, state: WorkingState, promoted: Promotion[] }
 *          | { ok: false, code: ErrCode, at: string, message: string }} ApplyResult */
// ErrCode (pure core — every one of these is returned by validate.mjs/applyTurn):
//        SCHEMA | READONLY_FIELD | CAP | UNKNOWN_LIST | UNKNOWN_FIELD | DUP_ID | NO_SUCH_ID
//        | UNVERIFIED_DONE | NEEDS_GATE | BAD_ACTION | MIGRATE_FAILED
// StoreErrCode (store-owned — returned by commit() and nothing else): STALE
```

**`STALE` is deliberately not in `ErrCode`.** It is the CAS-conflict outcome of `commit()` (§4.4),
so no branch of `validate.mjs` can ever produce it and a builder should not go looking for one. It
is also handled differently: the driver cures `STALE` itself by re-reading and re-applying, whereas
every `ErrCode` is fed back to the seat as its next observation. Two owners, two unions.

`message` is written for a model to act on, not for a log: `"move x7 → done rejected:
files['lib/state/apply.mjs'].verified is false and verify.tested is not set. Run the gate first."`

---

## 4. Data flow, path by path

### 4.1 One step, end to end

```
runner/hook                        core                            store
    │  readState(seat, card) ───────────────────────────────────────▶ read + migrate + recover
    │ ◀──────────────────────────────────────────────── state (rev N)
    │  assemble(preamble, state, tail, observation)  ──▶ prompt
    │  run the CLI ────────────────────────────────────────────────────────────────▶
    │ ◀──────────── TurnResult { patch, action } + cost envelope
    │  git status + re-hash credits ──▶ ctx.files[*]  (§4.8 tier 1: sets touched, expires stale verified)
    │  applyTurn(state, patch, ctx) ──▶ validate → apply → compact → promote-plan
    │ ◀── ApplyResult
    │  commit(state', rev N) ───────────────────────────────────────▶ CAS write + journal append
    │  promote(promotions) ──▶ POST /task/update (one note, deduped)
    │  execute(action)
```

Ordering is load-bearing and is asserted by `test/state/test-order.mjs`:
**validate before apply, apply before commit, commit before promote, promote before act.** A
rejected patch stops at step one: state is untouched, nothing is promoted, and the rejection
becomes the next observation. The one exception is `NEEDS_GATE`, which is cured once by running the
gate and re-entering `applyTurn` with the evidence (§4.8) — still before any commit.

### 4.2 The validator + merge core

`applyTurn` is a five-stage pipeline, each stage total and pure:

1. **Shape.** `TurnResult` matches the schema; each `Op` has exactly one operator key; `action`
   matches one `Action` variant. Missing `action` → `BAD_ACTION` (PRD §3.1: act, finish, or ask).
2. **Write-matrix.** Any op targeting `verify`, `files[*].verified`, `files[*].touched`,
   `files[*].blast_radius`, `card`, `schema_version`, `cursor`, `done_count`, `files_count`,
   `rev` → `READONLY_FIELD`.
   `task` is set-once: writable only while empty. This is the whole "a seat marks its own work
   verified" hole, closed in one table lookup.

   **`files[*].touched` is harness-only, not advisory.** The field means "git says this path
   changed", so testimony has nothing to add to it and a model-supplied value would be a second
   source for a fact that already has ground truth. §4.8 tier 1 writes it from `git status` every
   turn, before the apply (§4.1). Leaving it model-writable would mean a patch to `touched` is
   accepted and then silently clobbered by tier 1 — the reading a builder should never have to
   guess at — so it is a `READONLY_FIELD` rejection instead, which says so out loud.
3. **Semantics.** `add` with an existing id → `DUP_ID`. `remove`/`move` on a missing id →
   `NO_SUCH_ID`. `set` naming a field the schema does not define → **`UNKNOWN_FIELD`**, never a
   silently created key: an unknown field that is quietly accepted is the write matrix stopping
   being enforceable, because tomorrow's real field arrives as today's typo. (PRD §3.3 wants an
   unmigratable *patch* rejected loudly; §4.3's `MIGRATE_FAILED` answers only for unmigratable
   *objects*, so this is the patch half of the same rule.) `set { field, value }` targeting a
   **list** is a named rejection — `READONLY_FIELD` with `"<list> changes by add/remove/move only,
   never by set — arrays change only by id"` — never an accepted no-op: lists change via
   `add`/`remove`/`move`, and a `set` on one is a model that has misunderstood the grammar, which
   silently ignoring it would hide from the seat. `move … to:"done"` where the item's
   evidence is absent → `UNVERIFIED_DONE` or `NEEDS_GATE`, per the split in §4.8.
4. **Apply, in order, on a structural clone.** Any stage-3 failure aborts the whole patch; there is
   no partial application. All-or-nothing is what makes "no valid patch corrupts state" testable.
5. **Runtime pass** (not model-visible): `cursor` bump, `rev+1`, compaction of overflow lists into
   `done_count`/`files_count`, `ctx` facts written into `verify`/`files[*].touched`/
   `files[*].verified`/`files[*].hash` (`verify` **rewritten wholesale**, credits set or expired,
   never merged), the `ext._gate` memo record (§4.8), cap enforcement on content, and the promotion
   plan for §4.7.

**What counts as evidence for `UNVERIFIED_DONE`.** An item may move to `done` when either
(a) `verify.tested === true` and `verify.exit === 0`, or (b) every path in `Item.paths` (§3,
extracted from the evidence marker) has `files[path].verified === true`. Anything else is a
rejection with the reason. `ctx.verify` is supplied by the driver from a gate it actually ran —
never from anything the model said.

**`verified` has a lifecycle, and it is content-bound.** This is the hole a review found under the
memo bug, and it is the deeper of the two: in an earlier draft `verified` was monotonically true.
Nothing ever cleared it — tier 1 set `touched` without touching it, `recover()` said in as many
words that it "leaves `verified` alone" — so a green gate on path P, followed by a further edit to
P, left the next `move → done` citing P passing route (b) on a green that describes code that no
longer exists. Worse than the memo bug it hides behind: `NEEDS_GATE` never fires, because the
evidence is stale-*present* rather than absent, so the gate is never even consulted and no memo
hash can save it. So:

- When a gate credits a path, the runtime records `files[p].hash` = that path's blob sha
  (`git hash-object`) at the moment of credit, alongside `verified: true`.
- **Tier 1 invalidates.** Every turn, before the apply, for each path with `verified: true` the
  driver re-hashes the file and, if it differs from `files[p].hash` (or the file is gone), passes
  `verified: false` with `hash` cleared. Deleting the credit is a runtime fact like setting it: it
  travels in `ctx` and is written in stage 5, so the model can neither set nor preserve it.
- **`recover()` does the same** (§4.4), instead of leaving `verified` alone.

Two properties follow, and both are worth stating because they are what the rule actually rests on:
credit is never older than the bytes it describes, and route (b) degrades to *absent* rather than
*stale* evidence, which is the condition that puts `NEEDS_GATE` back on the path where it belongs.

**`verify` is rewritten from `ctx` every turn, which is how "at the current `rev`" is enforced.**
An earlier draft said route (a) needed `verify.tested === true` *at the current `rev`*, and a
review correctly pointed out that a pure core cannot check that: neither `verify` nor
`files[].verified` carries a rev stamp, so the validator has no way to know which rev set them.
Rather than stamp every field, stage 5 overwrites `verify` wholesale from `ctx.verify` on every
turn — present when a gate ran or its content-bound memo hit, **cleared when neither**. `verify`
therefore always describes this turn, no stamp is needed, and the freshness question moves to the
memo, where §4.8 already answers it with a tree hash.

**Who runs that gate is not obvious and the review was right to press on it:** in a stateless
Phase-2a step the harness does not run the seat's tools, so nothing would populate `ctx.verify`
on its own and route (a) would be vacuous in exactly the deployment that needs it. §4.8 is the
answer, and it is a load-bearing part of this design rather than an implementation detail.

### 4.3 Migration

`migrate.mjs` holds `MIGRATIONS = { 2: up2to3, … }`, applied in sequence on read until
`schema_version` matches `CURRENT`. A field the newer schema does not know is not dropped: it is
appended to `notes` as `migrated:<path>=<json>` (truncated to fit `CAPS.NOTES`, oldest migrated
line evicted first). A **known** key holding a wrong-typed value is treated the same way: it is
salvaged into `notes` under a `migrated:` line exactly like an unknown key — the field keeps its
default AND the original value is preserved — never coerced to the field default. Coercion is
field loss wearing a helpful face, and zero-field-loss means zero. This is #6528 generalised, and
it is the single rule that makes the whole
scheme safe to version. An unmigratable object returns `MIGRATE_FAILED` and the store keeps the
original file untouched under `.v<n>.json` rather than half-upgrading it.

### 4.4 Persistence, concurrency, and the crashed turn

**Location.** `busDir()/state/<project>/<seat>--<card>.json`, alongside `asks/`, `handoffs/`,
`claims/`. Session ids carry `:`, so the seat component is sanitised exactly as
`hooks/ask-sidecar.mjs` does today (`[^A-Za-z0-9._-]` → `_`, reject `.`/`..`/empty). Sidecar per
**seat-card**, not per seat: a seat that switches cards must not inherit the previous card's
in-flight list, and a card handed to another seat starts clean.

**Atomic write.** The existing house pattern, unchanged: `writeFileSync(tmp, …, {mode: 0o600})`
then `renameSync(tmp, path)`, with `tmp` in the same directory so the rename is same-filesystem and
atomic. A reader therefore sees either the whole previous file or the whole new one. Never a torn
file.

**Concurrency, single seat.** Even single-seat, two writers exist in principle: the seat's own turn
and a repair (`trantor state`). The store does a compare-and-swap: `commit(state, expectedRev)`
re-reads the file, and if the on-disk `rev !== expectedRev` it returns `{ok:false, code:"STALE"}`
rather than clobbering. The driver's response to `STALE` is to re-read and re-run `applyTurn` on
the fresh state, which is safe because ops are id-addressed and the failure modes (`DUP_ID`,
`NO_SUCH_ID`) are exactly the ones re-application would hit. One retry, then the turn is recorded
as `patch_failed`. This is a lock-free design on purpose: a lock file in `~/.agent-bus` is a thing
that outlives the process holding it, and this project has paid for that lesson elsewhere.

**The crashed turn.** The design deliberately admits only one apply point per turn, at the turn
boundary, after the CLI has exited. So:

- A turn killed by the watchdog, the time box, or a crash has **never partially applied a patch**.
  The on-disk state is the last good state, whole. There is no repair to do.
- What is lost is the dead turn's *observations*, not its state. Recovery is therefore
  reconstruction from ground truth, not from a journal: on the next `readState` after a turn that
  left a cut marker (`~/.agent-bus/turncut-<agent>-<proj>` — the runner already writes it),
  `store.recover()` sets `files[p].touched` for every path in `git status --short` in the seat
  worktree, **re-hashes every credited path and clears `verified` wherever the blob sha no longer
  matches `files[p].hash`** (§4.2 — a cut turn is exactly when a file changed under a credit, so
  the old "leaves `verified` alone" was the stale-credit hole with a crash in front of it), and
  appends one `notes` line `recovered: turn <N> was cut; touched paths re-derived from git; <k>
  stale verifications cleared`. The seat's next observation says so explicitly.
- The ops journal (`<sidecar>.ops.jsonl`, append-only, one accepted patch per line, capped at 200
  lines) exists for **forensics and replay in tests**, not for recovery. Recovery from a journal
  would need the journal write and the state write to be one atomic act, which they cannot be; the
  single-apply-point design means we never need them to be. Saying this explicitly is the point —
  a reviewer should be able to check that we are not pretending to a durability we do not have.

### 4.5 Phase 1 — the Stop-hook handoff path

Today: `bin/write-handoff.mjs` and the Stop path build a record whose `summary` is prose, capped by
`capSummary()` at 4KB with a `[…]` elision in the middle. That elision is #6528: it can and did eat
the STATE section.

The change is additive and small. The handoff record grows one field:

```js
{ id, project, projectName, machine, trigger, stamp, summary, transcript_path, mode,
  gitStatus, consumed, states: [...],
  state: WorkingState | null        // NEW — validated on write, never capped
}
```

- **Writer — and it BUILDS the state, it does not merely read one.** This is the correction a
  review forced, and the sequencing argument behind it is decisive: nothing writes a `state/`
  sidecar until the P6 runner applies patches, which is Phase 2a. A Phase-1 writer that only reads
  a sidecar therefore reads a file that does not exist yet, `rec.state` is `null` on every handoff,
  and the Phase-1 exit gate ("10 real handoffs carry a schema-valid STATE") cannot go green before
  the phase after it ships. The accepted PRD §4 already says the record is "built by the Stop-hook
  path"; an earlier draft of this TDD quietly demoted that to a read. The alternative on offer was
  to delete the unreachable gate, and that is refused on principle: dropping an accepted
  requirement because the gate for it is inconvenient is this whole design's failure mode, one
  level up.

  So `hooks/lib/handoff.mjs` gains `attachState(rec, {project, seat, card})` with two sources, in
  order:

  1. **Sidecar, when one exists** (Phase 2a and after): read, migrate, validate, attach. Unchanged
     from the earlier draft, and it becomes the normal path once the runner is live.
  2. **Derived, when none does** (every Phase-1 handoff): `lib/state/derive.mjs` —
     `deriveState({project, seat, card, worktree, handoffText})` builds one from ground truth plus
     the model's own handoff, and returns something the validator accepts or nothing at all.
     - `card` from the record, `task` from the card title, capped at `CAPS.TASK`.
     - `files`: `git status --porcelain` + `git diff --name-only HEAD` in the seat worktree →
       `touched: true`, **`verified: false` always**. A derived state can carry no credit, because
       no gate ran; this is the same rule as tier 1 (§4.8) and it means a derived state can never
       satisfy route (a) or route (b) — the successor must re-earn evidence. That is the honest
       outcome, not a limitation.
     - `done` / `in_flight` / `next` / `blockers`: from the STATE block the Stop path already asks
       the model for. It is parsed as a `TurnResult` patch and applied to an empty state through
       **`applyTurn`**, not through a second bespoke parser — so the write matrix, the caps and the
       verified-done rule all hold on the handoff path exactly as they do on the runner path, and
       there is one place where a patch can become state.
     - If that patch is missing or rejected, the derived state keeps the git-derived `files`, the
       `task`, and one `notes` line naming the rejection code. It is still schema-valid, which is
       what the gate measures.
  Invalid or underivable state attaches `null` and logs; it never blocks a handoff. `summary` keeps
  being written exactly as it is today, so the prose path is intact underneath either source.
- **Cap.** `capSummary()` is untouched and still applies to `summary` only. `state` is bounded by
  construction (§3.1), so it needs no cap and cannot be elided. **That is the whole fix**: the
  structured field cannot lose a member because the lossy operation is not applied to it.
- **Reader.** `hooks/sessionstart.mjs` renders `rec.state` into the injected kickoff as a compact
  block *after* the recap instruction, and the successor's RECAPPED gate (SYSTEM-CONTRACT §5) is
  unchanged. If `rec.state` is null the successor sees exactly today's prose handoff.
- **Fallback.** `TRANTOR_STATE_HANDOFF=0` (the default until the gate passes) skips both sides. The
  prose path is never removed in this phase.

### 4.6 Phase 2a — fresh-stateless assembly, and the granularity decision

Today `bin/crew-runner.mjs` line ~291 runs Claude seats as:

```js
claude:  { first: `claude{M} -p "$(cat {P})" --dangerously-skip-permissions`,
           next:  `claude -c{M} -p "$(cat {P})" --dangerously-skip-permissions`, … }
```

`-c` is the resumed session: the append-only transcript the PRD is fighting. Phase 2a replaces
**`next` only, and only for `claude`, and only under a flag**:

```js
// TRANTOR_STATE_ASSEMBLE=1
next: `claude{M} -p "$(cat {P})" --dangerously-skip-permissions \
        --output-format json --json-schema "$(cat {S})"`
```

No `-c`. The prompt file `{P}` is written by `lib/state/assemble.mjs`:

```
assemble({ preamble, state, tail, observation }) -> string
  = preamble                       // RULES + kickoff — byte-identical every step
  + STATE_DELIM + renderState(state)
  + TAIL_DELIM  + tail             // token-budgeted, CAPS.TAIL_TOKENS
  + OBS_DELIM   + observation      // truncated to CAPS.OBS_TOKENS
```

**Preamble first, always, byte-identical.** This is the prefix-cache requirement and it is the one
thing in Phase 2a that a refactor can silently break, so it is a unit test, not a comment:
`test/state/test-assemble.mjs` asserts that for any two states, `assemble(...).indexOf(STATE_DELIM)`
is the same integer and the bytes before it are identical. That test is the prefix-cache invariant
expressed in a way CI can hold.

**Granularity — a deviation from the PRD that reviewers should challenge.** SKILL.state's loop is
one model call per tool call. The Claude CLI is not that: one `claude -p` invocation runs a whole
agent loop internally (many tool calls) and then returns. Measurement (1) above shows the
structured object arrives as the final act of that loop. So on CC seats:

- **one step = one CC turn**, which internally does its own tool work;
- `action` collapses to `{done}` | `{ask}` | `{continue}`, and the `{tool, input}` variant is
  **unused on this driver** (it stays in the grammar for the raw-API driver a future phase needs);
- the O(T)→O(1) claim still holds at the level we control — what we hand the CLI each step is
  bounded — but the *inner* loop of a single CC turn is still a growing context we do not own.

That last bullet is the honest limit of Phase 2a and it belongs in the exit gate, not in a footnote:
the ≥5× cost win is a win across steps, not within one. §8's gate is written accordingly.

**Cost accounting.** `--output-format json` gives us the envelope measured in §0: `total_cost_usd`,
and `usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`.
`lib/state/cost.mjs` parses it into one shape. For the *baseline* (transcript path, no JSON output
format) the same shape is summed from the CC transcript JSONL usage rows, the way
`hooks/lib/handoff.mjs:contextUsage()` already reads them. Two sources, one struct, one comparison.

**A real cost of the change, stated plainly:** `--output-format json` makes the seat's window print
a JSON blob instead of prose, and the runner inherits stdio so the operator watches that window.
Mitigation in P6: the runner pipes through a one-line formatter that prints `result` and the cost
line, and stashes the envelope. If that formatter is not built, Phase 2a is a UX regression.

### 4.7 State ↔ board ownership (PRD §7)

The line: **the card is the shared record; state is private working memory.** Promotion is
one-directional (state → card note), at most once per turn, composed by `lib/state/promote.mjs`.

| in `WorkingState` | promotes to the card? | why |
|---|---|---|
| item moved to `done` (+ the evidence that unlocked it) | **yes** — one note line | the record of what shipped; it is already verified by definition (§4.2) |
| `blockers` added or cleared | **yes** | the operator and other seats need it; a blocker nobody can see is the failure this bus exists to remove |
| `verify` transitioning to built/tested/observed | **yes**, folded into the same note | the Definition of Done evidence |
| status change implied by `action:{done:true}` | **no** — the seat still calls `relay_task_move` itself | one owner for card status; state does not move cards |
| `in_flight`, `next` | no | scratch; it churns every turn and would flood the log (#6669's lesson) |
| `notes` tail, `cursor`, `files`, `done_count`, `ext` | no | private, or derived |

Mechanics: one `POST /task/update` with a `note` per turn, `by = <session>`, ≤2000 chars per
CARDLOG-CONTRACT, skipped entirely when the delta is empty. The promoter is **idempotent by
content hash** — the last promoted hash is stored in the sidecar under `ext["_promoted"]` (the one
runtime-owned `ext` key, model-unwritable) so a re-run after a `STALE` retry cannot double-post.
Promotion failures are non-fatal and never roll back state.

**Ordering, and it is load-bearing: `_promoted` advances only on a confirmed POST.** The hash is
written after the hub answers 2xx, never when the plan is computed. Written early, a promote that
loses to a network blip would be counted as delivered: the next turn diffs against a hash claiming
the note already went out, and the line is dropped silently — the worst failure this design can
have, because the record simply lacks a `done` that happened. Written late, a failed promote leaves
the hash where it was and the next turn re-sends the same content; the content hash makes that
re-send idempotent if the POST in fact landed and only the response was lost.

### 4.8 The evidence pipeline — who actually runs the gate

The review's substantive finding, and it is correct: §4.2 says `verified` comes from "the gate the
driver actually ran", but in a stateless Phase-2a step **the harness runs no tools**. Without a
named mechanism, `verify` would stay empty forever, route (a) would be dead, and the verified-done
rule would degrade into either a rubber stamp or a permanent refusal. Neither is acceptable, and
the same hole is R7 wearing a different hat.

Two tiers, and the choice between the review's option A and option B is **both, at different
prices**: the cheap half runs every turn unconditionally, the expensive half runs only when a
`done` move actually needs it.

**Tier 1 — `touched`, from git, every turn, unconditional.** After the CLI exits and before
`applyTurn`, the driver runs `git status --porcelain` and `git diff --name-only HEAD` in the seat
worktree and sets `files[p].touched = true` for every path. Cost is a few milliseconds, it needs no
gate and no model cooperation, and it is ground truth rather than testimony. **Tier 1 never sets
`verified`.** Touching a file is not evidence that it works, and conflating the two is the exact
hole the write matrix exists to close.

**Tier 1 does, however, *clear* `verified` — that half is not optional** (§4.2). In the same pass
it re-hashes every path currently carrying `verified: true` (`git hash-object` over just those
paths, so the cost scales with credits, not with the tree) and drops the credit wherever the blob
sha has moved off `files[p].hash`. Setting evidence is a privilege the gate holds; *expiring* it is
tier 1's job, because tier 1 is the only thing that runs every single turn. Without this half, a
credited file that the seat then edits keeps its green and route (b) never even reaches the gate.

**Tier 2 — the gate, run lazily, at the `move → done` boundary.** A patch containing a `move …
to:"done"` whose evidence is absent is not rejected outright. The pure core returns the rejection
code **`NEEDS_GATE`**, carrying what would satisfy it:

```js
{ ok: false, code: "NEEDS_GATE", at: "move:x7",
  message: "…", gate: { items: ["x7"], paths: ["lib/state/promote.mjs", …] } }
```

`NEEDS_GATE` is a **rejection subtype, not a third outcome** — this matters, because the Phase-0
property test asserts every patch is accepted or rejected with no third state. The core stays pure
and two-valued; it simply names a rejection the *driver* knows how to cure. Curing it is a driver
loop with exactly one retry:

```js
let r = applyTurn(state, patch, ctx);
if (!r.ok && r.code === "NEEDS_GATE") {
  const g = runGate(r.gate, { cwd: seatWorktree });   // spawnSync, timeboxed
  r = applyTurn(state, patch, { ...ctx, gate_attempted: g, verify: g.verify, files: g.files });
}
```

**`NEEDS_GATE` vs `UNVERIFIED_DONE` turns on `ctx.gate_attempted`, and nothing else.** Missing
evidence has two causes that look identical in the state — no gate has run yet, and a gate ran and
came back red — and a core that cannot tell them apart returns `NEEDS_GATE` both times. That was
true of an earlier draft, and it made this section's own bounded-retry claim false: a red gate
sets `verify.tested = false` and credits no paths, so route (a) and route (b) are both false on the
second call, the condition for `NEEDS_GATE` holds again, and the loop either spins or drops the
failure tail on the floor and reports the wrong code. So the driver passes the gate *attempt*
forward — `ctx.gate_attempted = { cmd, exit, tail, coverage }`, a runtime fact like every other
`ctx` field, unwritable by the model — and the validator branches on it:

- `ctx.gate_attempted` absent and evidence absent → **`NEEDS_GATE`**, carrying the paths that would
  satisfy it. The driver cures it.
- `ctx.gate_attempted` present and evidence still absent → **`UNVERIFIED_DONE`**, carrying
  `cmd`/`exit` and the last `CAPS.OBS_TOKENS` of the tail. The seat gets the failing assertion.

The retry is now bounded at one *by construction* rather than by assertion: the second call has
`gate_attempted` set, and no branch reachable with it set returns `NEEDS_GATE`.

**`lib/state/gate.mjs` — `runGate(spec, opts) -> { verify, files, coverage, cmd, exit, ms, tail }`**

- *Command resolution*, first match wins: `TRANTOR_STATE_GATE` (explicit, per project) → **the
  scoped form**, `node test/run.mjs --only <subsystem>`, when every path in `spec.paths` sits under
  one `test/<subsystem>` sibling → `package.json` `scripts.test` → none. Plus `node
  bin/slop-gate.mjs`, always, because this repo's own rule is that a card does not reach done with
  slop-gate red.
- *Scope, and the crew lesson it respects*: a seat must never run the full `npm test` — sibling
  seats' suites collide on fixed ports and a green build has already been marked failed that way.
  The scoped form is therefore **ahead of** `scripts.test` in that order, not behind it, and
  `scripts.test` is the fallback for work the scope rule cannot place. An earlier draft had the two
  the other way round while still claiming the scoped form was preferred; those cannot both be
  true, and as ordered every project with a `test` script — this one included — would have run the
  full suite every time, which is the exact port-collision failure the rule exists to prevent and a
  silent inflation of R10's cost. `coverage` records which one ran: `"scoped:test/state"` or
  `"project"`.
- *Build source, so `verify.built` has a defined origin*: `TRANTOR_STATE_BUILD` (explicit, per
  project) → `package.json` `scripts.typecheck` → `scripts.build` → **none**, and none is the
  common case in this repo. `verify.built` is set only when one of those resolved and ran; with no
  build command configured the field stays absent, which reads as "not built" and never as "built".
  An undefined origin here would have let a builder invent one.
- *What it may write*: `verify.tested = (exit === 0)`, `verify.cmd`, `verify.exit`. `verify.built`
  only when a build/typecheck command resolved above and ran. **`verify.observed` is never set by
  `runGate`** — observation means a human, a drill, or a captured runtime artifact, and a test
  runner is none of those. That keeps the four-block Definition of Done honest instead of letting a
  passing suite quietly claim the fourth block.
- *Which paths get `verified`, and with what*: on `coverage: "project"`, every currently-`touched`
  path. On `coverage: "scoped:<dir>"`, only touched paths under `<dir>` — a scoped suite is not
  evidence about files it never loaded. Paths outside both stay `verified: false` and their items
  keep failing route (b), loudly. Every credit is recorded with the path's blob sha in
  `files[p].hash`, which is what tier 1 later checks the credit against (§4.2).
- *Timebox*: `GATE_MAX_MS` (default 300 000). A timeout is a red gate, not a missing one.

**Cost control, because a suite per done-move is not free.** Two rules:

1. **At most one gate run per turn.** Several `done` moves in one patch share the run.
2. **Memoised by tree CONTENT.** `runGate` records `ext._gate = { hash, verify, coverage, ts }`,
   where `hash` = HEAD sha + the worktree's **tree sha**: with `GIT_INDEX_FILE` pointed at a
   scratch index under `.agent-bus-out/` (gitignored, same filesystem, never the seat's real
   `.git/index`), the driver runs `git add -A` then `git write-tree`. If the hash is unchanged
   since the last green run, the recorded result is reused with no spawn. So N done-moves across M
   turns with no code change cost exactly one suite run, and the first byte changed after that
   invalidates it.

   **Why not a hash of `git status --porcelain`** — an earlier draft said exactly that, and it was
   a rubber stamp with extra steps. Porcelain prints *path + status letters*: it says that a file
   is modified, never what is in it. So a green gate on a dirty tree, followed by the single most
   common thing a seat does — edit a file it has already modified — leaves the porcelain output
   byte-identical (` M lib/state/apply.mjs`, still) and HEAD unchanged. The memo would hit and a
   green recorded *before* the edit would be reused as evidence for a `done` move on code no gate
   has ever seen, which is precisely the rubber stamp §4.8 exists to prevent. A tree sha changes
   whenever any byte does, and `add -A` folds in untracked files so a brand-new test file busts it
   too.

**Who writes `ext._gate`, and when.** `runGate` computes the record and *returns* it; it never
touches state. The driver hands it forward in `ctx` (alongside `gate_attempted`), and the apply
writes it in the stage-5 runtime pass, so the memo lands through the single apply point and rides
the same commit as everything else in the turn. Any other arrangement costs something real:
`runGate` mutating `state.ext` would make it impure and would write state outside the one apply
point §4.4's crash-safety argument leans on, and keeping the memo in driver-local memory would put
it somewhere the next turn cannot read, which is the whole purpose of the memo. `ext._gate` is
runtime-owned and model-unwritable, like `ext._promoted` (§4.7).

**Failure is the useful path, not the sad one.** A red gate rejects the move with
`UNVERIFIED_DONE` and hands the seat the last `CAPS.OBS_TOKENS` of the gate output as its next
observation. The seat's next step therefore begins with the actual failing assertion, which is
strictly better than the transcript path where a seat marks its own work done and the failure
surfaces a merge later. **This is the mechanism that turns the verified-done rule from a rule into
a loop**, and it is what closes the live half of R7.

**Why not the other two candidates.** The review offered three; this design took the first two
*combined* (they are complementary, not alternatives) and rejected the third.

- **Interception alone, with no git tier.** Rejected because `touched` would then only ever be
  populated at a `done` boundary, so route (b) would have no base to stand on between moves, and
  §4.4's crashed-turn recovery already has to derive touched paths from `git status` regardless.
  Tier 1 is therefore free — the code exists for recovery either way — and omitting it would buy
  nothing.
- **A lazy gate alone, with no interception.** Rejected as underspecified rather than wrong: "lazy"
  needs a trigger, and the only honest trigger is the moment the evidence is demanded. That *is*
  the interception. The two are one mechanism described from two ends.
- **Deriving evidence from the seat's `stream-json` output.** Rejected on principle and on
  mechanics. On principle: it would read `verified` off the tool calls *the seat chose to make*,
  which makes the seat the judge of its own work — the one rule this project does not bend, and the
  hole the write matrix (§2) exists to close. A seat that runs a suite with no tests, or greps a
  file and calls it green, would produce identical evidence to one that ran the real gate. On
  mechanics: it is a parser against an unversioned stream format that shifts between CLI releases
  (this repo has paid for format staleness before), and it yields nothing at all for the
  opencode/codex/kimi seats, so a second mechanism would be needed anyway. **What the stream is
  genuinely good for is kept**: it remains the cost source (§4.6) and may corroborate `touched`,
  but corroboration is not evidence and never sets `verified`.

**Ordering, added to the §4.1 invariant:** tier 1 before `applyTurn`; `NEEDS_GATE` cure between the
two `applyTurn` calls; commit after the second. The gate runs *after* the CLI has exited, so a
killed gate still leaves state whole — the single-apply-point property of §4.4 is preserved.

---

## 5. File ownership — one file-set per package

Each package owns files no other package writes, so packages can be built in parallel by different
seats without the concurrent-edit corruption the crew has paid for before. **Shared files** are
listed separately and are edited by exactly one package each, in phase order.

| Pkg | Owns (creates, sole writer) | Touches (shared — sole editor in its phase) |
|---|---|---|
| **P0 core** | `lib/state/schema.mjs`, `validate.mjs`, `apply.mjs`, `migrate.mjs` · `test/state/test-schema.mjs`, `test-validate.mjs`, `test-apply.mjs`, `test-caps.mjs`, `test-migrate.mjs`, `test-order.mjs` | — |
| **P0.5 contract** | — | `docs/SYSTEM-CONTRACT.md` (§4 row from §2 above) |
| **P1 store** | `lib/state/store.mjs` · `test/state/test-store.mjs` | — |
| **P2 CLI** | `bin/state.mjs` · `test/state/test-cli.mjs` | `bin/cli.mjs` (one subcommand row) |
| **P3 promote** | `lib/state/promote.mjs` · `test/state/test-promote.mjs` | — |
| **P4 handoff** | `lib/state/derive.mjs` · `test/state/test-handoff-state.mjs`, `test-derive.mjs` | `hooks/lib/handoff.mjs`, `hooks/sessionstart.mjs`, `bin/write-handoff.mjs` |
| **P5 assemble** | `lib/state/assemble.mjs`, `lib/state/cost.mjs` · `test/state/test-assemble.mjs`, `test-cost.mjs` | — |
| **P5.5 gate** | `lib/state/gate.mjs` · `test/state/test-gate.mjs` | — |
| **P6 runner** | `lib/state/driver.mjs` · `test/state/test-runner-state.mjs` | `bin/crew-runner.mjs` (the flagged `claude.next` row + turn-boundary apply) |
| **P7 baseline/bench** | `bin/state-bench.mjs` · `test/state/test-bench.mjs` | — |
| **P9 drill** | — | `bin/drill-surface.mjs` (one new `step()`) |

**Why P6 owns a `lib/` file when the row above once said it owned nothing.** `bin/crew-runner.mjs`
is not importable — it reads `process.argv` and awaits enrolment at module scope — so anything
living inside it can only be exercised end to end against a live hub. That is fatal for the one
property this phase exists to make real: §4.8 tier 1's re-hash-and-expire. A credit that silently
goes monotonic-true in production while every unit test stays green is R7 wearing a new hat, and it
cannot be mutation-tested through a file that cannot be imported. So the step logic lives in
`lib/state/driver.mjs` and the runner keeps the wiring and the I/O. The precedent is this repo's
own: `lib/classify-failure.mjs` was lifted out of the same file for the same reason (#5868).

Rules that make this safe, from the crew's own lessons: no package edits another's owned files; a
package that needs a change in a file it does not own asks that owner over the bus; every package
commits its delta the moment its tests pass, before any rebase.

---

## 6. Dependencies

**Internal, existing, unchanged:** `lib/project.mjs` (`busDir`, `resolveProject`) · `hooks/lib/api.mjs`
(`signedPost` for promotion) · `hooks/lib/handoff.mjs` (Phase 1 host) · `bin/crew-runner.mjs`
(Phase 2a host) · `test/run.mjs` (discovers `test/state/test-*.mjs` automatically — no runner
change needed) · `bin/slop-gate.mjs` (gates every new `.mjs`).

**External:** none added. No new npm dependency. `zod` is already a dependency and is a candidate
for `validate.mjs`, but the validator here needs error *codes and positions* fed back to a model,
so it is hand-written and about 200 lines; a schema library would be shaped around throwing.

**Provider-side:** a Claude CLI with `--json-schema` — verified present on 2.1.257; the minimum
version is unconfirmed, so P6 probes `claude --help` once at seat start and leaves
`TRANTOR_STATE_ASSEMBLE` off when the flag is absent. Nothing else in the fleet exposes
constrained output — see §7.3.

**Deferred, not depended on:** Graft for `blast_radius`. The schema field stays; the build package
does not (§7.6). Nothing in Phases 0–2a reads it.

---

## 7. The PRD §7 must-answers, resolved

### 7.1 Single-seat persistence + concurrency
Answered in §4.4: sidecar per seat-card under `busDir()/state/<project>/`, temp+rename atomic
write, `rev` compare-and-swap instead of a lock file, one apply point per turn at the turn
boundary, and crash recovery by re-derivation from `git status` rather than journal replay —
because the single apply point means a cut turn leaves whole, stale state, never torn state.

### 7.2 State ↔ board ownership
Answered in §4.7 with a promotion table: verified `done` items, blockers, and `verify` evidence
promote as one deduped card note per turn; scratch, tail, files and counters stay private; state
never moves a card's status.

### 7.3 Grammar-constrained decoding coverage + fallback budget

| seat | mechanism | coverage |
|---|---|---|
| `claude` | `--json-schema` + `--output-format json`, CLI-validated (verified §0) | **enforced** |
| `deepseek`/`glm`/`openrouter` (opencode) | `opencode run` exposes no schema flag | prompt-shaped + our validator |
| `codex`, `gemini`, `kimi`, `dsh` | no schema flag | prompt-shaped + our validator |

None of these is true grammar-constrained decoding at the sampler; the Claude path is
schema-*validated* output (a tool call under the hood). The design does not need more than that,
because the validator is the real gate either way. Phase 2a only runs on `claude`, i.e. on the
enforced row; the others matter for Phase 1 (which does not need a patch at all) and for the
foreign-CLI PRD.

**Fallback ladder, per turn:** invalid patch → one retry with the `ApplyResult.message` appended as
the observation → still invalid → record `patch_failed`, leave state unchanged, feed the rejection
forward as the next observation. State-mode is never silently abandoned mid-turn.

**Budget, measured in Phase 0 on a fixture bench of 50 turn-results** (`bin/state-bench.mjs
--patches`), and gating: **schema-enforced seats ≤2% invalid after one retry; prompt-only seats
≤10%.** Live circuit breaker: if a seat's rolling invalid rate over its last 20 turns exceeds its
budget, the runner disables `TRANTOR_STATE_ASSEMBLE` for that seat, falls back to the transcript
path, and emits one bus event saying so (once — monitoring doctrine: duration, not repetition).
A phase gate fails if the breaker trips during the gate run.

**What counts as an invalid patch, and what emphatically does not.** The budget and the breaker
count *malformed output*: `SCHEMA`, `BAD_ACTION`, `READONLY_FIELD`, `CAP`, `UNKNOWN_FIELD`,
`UNKNOWN_LIST`, `DUP_ID`, `NO_SUCH_ID` — the seat failed to speak the grammar. They do **not**
count `UNVERIFIED_DONE` from a red gate, or `NEEDS_GATE`: there the patch was well-formed and the
*code* was wrong, which is the system working. Counting them would trip the breaker on the
healthiest possible seat — one writing perfect patches against a failing test — and would drop it
back to the transcript path precisely when the evidence loop is doing its job. `bin/state-bench.mjs
--patches` reports the two classes separately for the same reason.

### 7.4 Per-project `ext` — yes, capped
Include it. Without an escape hatch, per-project needs (a drill's phase id, a build's artifact
path) get stuffed into `notes`, which is the one unstructured field and the one we cap hardest.
Rules: model-writable via `set` on `ext.<key>` only; `CAPS.EXT_KEYS` = 8, `CAPS.EXT_BYTES` = 4096
total serialised; keys match `/^[a-z][a-z0-9_.-]{0,31}$/`; the `_`-prefixed namespace is reserved
for the runtime (`_promoted`, §4.7) and is model-unwritable; `ext` never promotes to the board and
is carried verbatim across migrations.

### 7.5 Dogfood + baseline first
**P7 runs before P6 ships, and its output is a committed artifact.** Dogfood project: `trantor`
itself, on a real multi-turn card assigned to the `claude` seat (candidate: one of the open
consolidate cards — multi-file, ≥8 turns, has a runnable gate). `bin/state-bench.mjs --baseline
--card <id>` records per-turn `{turn, cost_usd, input, output, cache_read, cache_creation, ts}` to
`~/.agent-bus/state/baselines/<project>-<card>.jsonl` and commits a summary table to
`docs/state-baseline-<card>.md`. **No baseline artifact in the repo → the Phase 2a gate cannot be
evaluated and the phase does not open.** This is the unfalsifiability guard the PRD asked for.

### 7.6 Graft as the blast_radius engine — deferred (unanimous scope cut)
The PRD asked whether Graft should be the engine. The answer for this TDD is **not yet, and the
build package is dropped**, on the reviewers' unanimous cut.

What stays: `files[path].blast_radius?: number` in the schema, harness-written, model-unwritable
per the §2 write matrix, optional everywhere. What goes: the `lib/state/blast.mjs` package, its
suite, and the `TRANTOR_STATE_BLAST` flag. Nothing in Phases 0–2a reads the field, no gate
references it, and an absent optional number needs no code to be absent.

Rationale for cutting rather than building it small: Graft is already being wired into this project
independently (#6888 auto-builds the index per project at crew launch). Building a second, parallel
adapter here would either duplicate that work or race it. When the index is live, filling the field
is a follow-up card of maybe twenty lines against a schema that already has a home for it — which
is precisely what "optional in the schema" was supposed to buy.

---

## 8. Verification plan — the exit gates, as tests

Every gate below is a command with an exit code. "The design is done" is not a thing anyone says.

### Phase 0 (core) — `node test/run.mjs --only state`
| PRD exit gate | test | shape |
|---|---|---|
| no valid patch corrupts state | `test-apply.mjs` | property: 500 generated op sequences over a generated state; after each, the result re-validates against the schema or was rejected. No third outcome — `NEEDS_GATE` is asserted to be a *rejection*, so §4.8 does not weaken this property. |
| arrays change only by id | `test-apply.mjs` | property: for every accepted patch, the multiset of ids changes only by the ops' declared ids |
| harness/runtime fields never model-writable | `test-validate.mjs` | table-driven: one case per row of the §2/§4.2 write matrix, each asserting `READONLY_FIELD` — including `files[*].touched`, which is harness-only |
| a credit expires with the bytes it describes | `test-validate.mjs` | green gate credits path P (`verified:true`, `hash` recorded) → P's content changes → tier 1's ctx clears `verified` → the same `move → done` citing P is now rejected. The negative case is the point: without the clear it passes, which is R12 |
| working lists reject on overflow, history compacts | `test-caps.mjs` | `done`/`files` overflow into `done_count`/`files_count`; an `add` past `CAPS.LIST` on `in_flight`/`next`/`blockers` returns `CAP` naming the list and drops nothing (§3.1) |
| a red gate is not an invalid patch | `test-validate.mjs` + `bin/state-bench.mjs --patches` | `UNVERIFIED_DONE`/`NEEDS_GATE` are reported in a separate class from malformed output and never count against the §7.3 budget or the breaker |
| an unknown field is a named rejection | `test-validate.mjs` | `set` on a field the schema does not define returns `UNKNOWN_FIELD` and creates no key (§4.2 stage 3) |
| `move→done` without verification rejected | `test-validate.mjs` | both evidence routes (§4.2) pass; with `ctx.gate_attempted` absent, missing evidence returns `NEEDS_GATE` carrying the paths that would satisfy it; **with it present, the same patch returns `UNVERIFIED_DONE` carrying `cmd`/`exit`/tail and never `NEEDS_GATE`** — this is what makes §4.8's one-retry bound a fact rather than a claim |
| the evidence marker survives capping | `test-caps.mjs` | an item whose text exceeds `CAPS.ITEM` *including* a marker keeps every path in `Item.paths`; a malformed marker is rejected with `CAP`, never trimmed into silence (§3) |
| the gate pipeline | `test-gate.mjs` | command resolution order, asserted on a fixture that has **both** a `scripts.test` and a scoped sibling — the scoped form must win; scoped vs project `coverage` decides which touched paths get `verified`; `observed` is never auto-set; a red gate yields `UNVERIFIED_DONE` carrying the output tail; a timeout counts as red |
| the gate memo busts on content, not on status | `test-gate.mjs` | the memo skips a second spawn when nothing changed, **and the case that matters: after a green gate, modify a file that is already modified so `git status --porcelain` is byte-identical and HEAD is unchanged, then assert the memo MISSES and the gate re-runs.** "A dirty tree busts it" is not enough on its own — that assertion passes while the status-hash bug is live (§4.8) |
| a failed promote is re-sent, not swallowed | `test-promote.mjs` | a POST that throws leaves `ext._promoted` unchanged, so the next turn's delta still contains the note; a 2xx advances it and the next turn skips (§4.7) |
| caps hold on counts **and** content | `test-caps.mjs` | overflow of each list/field, **one case per key of `CAPS` including `ID`** (an over-long `Item.id` is a `CAP` rejection, never a trim); asserts compaction into `_count` and that content is truncated, not dropped silently |
| v2→v3 migrates with zero field loss | `test-migrate.mjs` | a v2 fixture with an unknown field round-trips; the unknown field is findable in `notes` under `migrated:` |
| ordering invariant | `test-order.mjs` | a rejected patch leaves state byte-identical and promotes nothing |
| invalid-patch budget measured | `bin/state-bench.mjs --patches` | prints the rate per seat class; §7.3 thresholds |

Plus `node bin/slop-gate.mjs` clean on every changed file — a package does not reach done with it red.

### Phase 1 (handoff)
| gate | how |
|---|---|
| 10 real handoffs carry a schema-valid STATE, 0 dropped fields | `bin/state-bench.mjs --handoffs 10` reads the last 10 records in `~/.agent-bus/handoffs/`, validates each `rec.state`, and diffs its field set against the object the writer validated (the sidecar when there was one, else the derived state `deriveState` returned — §4.5, since pre-2a there is no sidecar to diff against). Exit non-zero on any drop, and on any record where `rec.state` is `null` while the seat had a card and a dirty worktree. |
| mid-turn handoff drill recaps from the object | new `step("S4c · handoff carries WorkingState")` in `bin/drill-surface.mjs`, riding the existing S4 machine: arm → fire → successor claims → assert the injected kickoff contains the state block and the RECAPPED gate still closes |
| prose path off on one dogfood project | `TRANTOR_STATE_HANDOFF=1` on `trantor`, one week, no regression in the S4 drill |
| unit | `test/state/test-handoff-state.mjs`: `attachState` on a valid/invalid/missing sidecar; `capSummary` never touches `rec.state` |
| the derived state is real state, not a stub | `test/state/test-derive.mjs`: with no sidecar, `deriveState` returns a schema-valid object whose `files` match `git status` in a fixture worktree; **every derived path is `verified: false`** and no derived item can move to `done`; a model STATE block goes through `applyTurn` so the write matrix still rejects a self-declared `verified`; a missing or rejected block still yields a valid state carrying the rejection code in `notes` |

### Phase 2a (assembly) — the honest gate
1. **Pre-condition, checked first:** the committed baseline artifact from §7.5 exists for the
   dogfood card. Absent → gate fails, no measurement is run.
2. **Prefix invariant:** `test-assemble.mjs` — preamble bytes identical across arbitrary states.
3. **Cache actually hits in the wild:** `bin/state-bench.mjs --run --card <id>` asserts
   `cache_read_input_tokens > 0` on every step after the first. A run where it is zero means the
   preamble drifted and the ≥5× claim is void — this is the check that catches the §0 assumption
   silently breaking.
4. **Cost gate:** the per-turn cost curve trends O(T) (fit slope ≈ 0 against turn index, checked
   over ≥8 turns) and total cost is **≥5× below** the recorded baseline for the same card at
   equal-or-better task success (the card reaches `done` with its own tests green).
5. **Zero recovery:** mutate the card and a file under the seat mid-run (`bin/state-bench.mjs
   --disturb`); assert the next step acts on current state — no re-read burst, no invented recovery
   steps — by asserting the next step's input token count stays within the bound and its `action`
   is not a re-orientation read.
6. **The evidence pipeline is live, not theoretical** (§4.8): over the dogfood run, assert that at
   least one real gate ran with `verify.cmd` recorded, that every item in `done` has evidence at the
   `rev` it landed on — **items carry no rev, so the bench derives item→rev by replaying the ops
   journal** (§4.4: one accepted patch per line, in order, each with its `rev`), which is what that
   journal is for and needs no schema field — and — the negative half, which is the one that matters — inject a failing
   test mid-run and assert the next `move → done` is **rejected** with the failure tail as the
   seat's observation. A run where nothing was ever rejected has not tested the rule.
7. **Metric 3 — turns per card before a forced cut** (PRD §5, previously ungated). `bin/state-bench.mjs
   --turns` counts turns per card up to the first forced cut (a `turncut-*` marker, a context-driven
   handoff, or a watchdog stall report) on the state path, against the same count on the baseline
   path. **Gate: median over n ≥ 3 cards is ≥ the baseline median.** With n < 3 the number is
   recorded on the card and the gate **carries forward** to the next phase rather than being waved
   through — one card is an anecdote, and a metric that can be satisfied by an anecdote is not a
   gate.

**Reporting.** `bin/state-bench.mjs --report` writes the comparison table to
`.agent-bus-out/` and prints it; the numbers go on the card, not in a claim.

---

## 9. Risks

| # | risk | severity | mitigation |
|---|---|---|---|
| R1 | **Output tokens swamp the win.** §0 measured 1,763 output tokens (492 thinking) on a trivial call; if a state step thinks as hard as a transcript step, cost barely moves. | **high** — it can void the 5× gate | Measure before building the runner (P7 before P6). If the baseline shows output-dominated cost, the phase gate is renegotiated with the operator rather than quietly lowered. |
| R2 | **The preamble drifts and the cache stops hitting.** Any change to RULES, kickoff, or MCP config invalidates the prefix. | high | The §8.3 live check; the §8.2 unit invariant; the preamble is assembled from a single source and never interpolates per-turn values. |
| R3 | **One CC turn is still an unbounded inner context** (§4.6). The O(1)/step claim covers what we hand in, not what happens inside. | medium | Stated in the gate; the win is measured end-to-end in dollars, which is honest about it either way. |
| R4 | **`--output-format json` makes seat windows unreadable.** | medium | P6's formatter; if it slips, Phase 2a stays flagged off. |
| R5 | **Promotion floods the card log.** #6669 is exactly this failure with duty notes. | medium | One note per turn, empty deltas skipped, content-hash dedupe (§4.7), 40-entry cap already enforced hub-side. |
| R6 | **Seats work around the verified-done rule** by declaring items whose text names no path. | medium | `UNVERIFIED_DONE` requires positive evidence; an item with no path marker needs `verify.tested === true` at the current `rev`, which only the harness can set. |
| R7 | **The unit suite goes green while the live seam is broken** — the standing lesson on this project. | high | Every phase has a live gate (drill step, bench run), not only unit tests; Phase 2a's gate is a real card on a real seat. The evidence pipeline (§4.8) is the structural half: `verified` can only come from a gate that actually ran, and gate 6 fails a run in which nothing was ever rejected. |
| R8 | **Scope creep into the merge operator** the moment two seats want shared state. | medium | The ownership row says private working memory; a second consumer is a signal to open the merge PRD, not to widen this one. |
| R9 | **Sidecar sprawl** in `~/.agent-bus/state/`. | low | `trantor state gc` in P2: sidecars for cards in a terminal status, older than 14 days, are deleted; state is derived and safe to lose. |
| R10 | **The lazy gate is expensive**: a suite per `done` move could cost more than the tokens saved, and a seat that moves items one at a time pays repeatedly. | medium | One gate per turn, tree-hash memoisation, scoped suites preferred over the project suite (§4.8). `bin/state-bench.mjs --report` prints gate wall-clock alongside cost so the trade is visible rather than assumed; if gate time dominates, the answer is batching done-moves, not weakening the rule. |
| R11 | **The gate over-credits, at both settings.** `coverage: "scoped:test/state"` marks touched paths under that dir `verified` on a suite that may not exercise them — and `coverage: "project"` is the broader case, crediting **every** touched path on one green run. | medium | Honest and bounded rather than solved: credit never extends outside the coverage, and `verified` now expires the moment a credited file changes (§4.2), so over-credit cannot outlive the bytes it was granted on. Real per-line coverage mapping is a bigger machine than this phase justifies; the field means "a gate covering this path passed", not "this line ran". Stated here, for both settings, so nobody reads more into it later. |
| R12 | **`verified` goes stale silently** — the failure that hid under R11: a credit that outlives the file it describes lets `move → done` pass route (b) without the gate ever being consulted. | **high** — it voids the verified-done rule on the ordinary flow of editing a file twice | Credit is content-bound and expires: `files[p].hash` at credit time, re-hashed and cleared by tier 1 every turn and by `recover()` after a cut (§4.2, §4.4, §4.8). Forced by `test-validate.mjs` and by gate 6's negative half — a run in which nothing was ever rejected fails. |

---

## 10. Work breakdown

Difficulty is about design risk, not line count. Order is dependency order; packages on the same
row are parallel-safe by §5 file ownership.

| pkg | work | difficulty | depends on |
|---|---|---|---|
| **P0** | `schema.mjs` + `validate.mjs` + `apply.mjs` + `migrate.mjs`, all pure; the six Phase-0 suites including the two property tests | **hard** | — |
| **P0.5** | the SYSTEM-CONTRACT §4 ownership row | **easy** | — (lands with P0) |
| **P1** | `store.mjs`: paths, sanitisation, atomic write, `rev` CAS, `recover()`, ops journal, gc helper | **medium** | P0 |
| **P2** | `bin/state.mjs` (`show`/`validate`/`reset`/`gc`) + one `case "state":` row in `bin/cli.mjs` | **easy** | P1 |
| **P3** | `promote.mjs`: delta → one card note, content-hash dedupe, `signedPost` | **medium** | P0 |
| **P4** | Phase 1 handoff: `derive.mjs` (the Stop-path state writer, §4.5), `attachState`, sessionstart render, flag, suites | **medium** | P0, P1 |
| **P5** | `assemble.mjs` (+ prefix invariant test) and `cost.mjs` (envelope + transcript parsers) | **medium** | P0 |
| **P5.5** | `gate.mjs`: command resolution, scoped vs project coverage, tree-hash memo, timebox, the `NEEDS_GATE` cure contract | **medium** | P0 |
| **P7** | `bin/state-bench.mjs`: `--baseline`, `--patches`, `--handoffs`, `--run`, `--disturb`, `--report` + the committed baseline artifact | **hard** | P5 |
| **P6** | runner wiring: flagged `claude.next`, tier-1 git touch, turn-boundary apply, the `NEEDS_GATE` cure, retry ladder, circuit breaker, stdout formatter | **hard** | P1, P3, P5, P5.5, P7 |
| **P9** | drill step `S4c` | **easy** | P4 |

Suggested lanes if this is built by the crew: P0+P0.5 on one strong seat (it is the whole
correctness surface and everything else imports it); P1/P2 and P3 in parallel once P0's schema is
committed; P4, P5 and P5.5 in parallel; P7 before P6; P9 as a filler. Nothing here needs more than
one seat per package, and no two packages write the same file.

**Cut from this TDD by review, tracked as follow-ups, not forgotten:** the Graft `blast_radius`
engine (§7.6 — schema field kept, package dropped, fills when #6888's index is live) and Phase 4
learning-as-deltas (undesigned until the 2a gate passes).

---

## 11. Rollout, flags, rollback

| flag | default | turns on | rollback |
|---|---|---|---|
| `TRANTOR_STATE` | `0` | core read/write of sidecars | delete `~/.agent-bus/state/` — state is derived |
| `TRANTOR_STATE_HANDOFF` | `0` | Phase 1 attach + render | flag off; prose handoff is untouched and still written |
| `TRANTOR_STATE_ASSEMBLE` | `0` | Phase 2a `claude.next` assembly | flag off; `claude -c` row is restored verbatim |
| `TRANTOR_STATE_GATE` | unset | overrides the §4.8 gate command for a project | unset falls back to the scoped suite, then `scripts.test` |

Each flag flips to default-on only after its own gate in §8 passes on a real project, and each can
be flipped back with no data migration, because nothing downstream is allowed to depend on state
existing. That is the property the ownership row in §2 buys, and it is the reason this is safe to
build incrementally.
