# PRD: Trantor State — structured execution state for the harness

**Status:** draft for crew PRD review · **Owner:** operator + orchestrator · **Date:** 2026-09-08
**Prior art:** SKILL.state (Badhe, Tiwari, Chung, EMNLP; arXiv 2608.26263)

---

## 1. Context — why we are doing this

Trantor's whole succession machine exists to fight one thing: the **append-only conversation
transcript**. As a seat works, its transcript grows; context fills (the 90% baton), turns get
poisoned, the session hands off, we compress the world into a prose handoff record, a successor
reloads it. The reaper, the time-box, the handoff gate, the stranding recoveries — all of it is
us managing a growing transcript.

SKILL.state names a different answer to the same problem: **stop appending; carry an explicit,
mutable, validated execution state.** Each step the model sees only the immutable skill spec, the
current state, and the latest observation, and returns a reasoning trace, a state *patch*, and an
action. The reasoning is discarded once the patch is validated and merged. Prompt size becomes
O(1) per step; total tokens go O(T²) → O(T). Their results: 16–50× fewer tokens, higher
long-horizon accuracy, noise robustness, and the one that matters most for us — **zero recovery
steps when the world changes underneath the agent**, because decisions read current state, not
remembered state.

We already do half of this without naming it: the **board** is external mutable state seats read
instead of re-reading history; sidecars (`duty-nudged.json`, `drill-result.json`, `asks/`) are
structured state; `#6094` ("transcript is not live") was us discovering that history lies and
current state is truth. This PRD makes that instinct the harness's memory model.

**Evidence from our own bugs, not theory:**
- `#6528` — the prose handoff summary exceeded a 4KB cap and the STATE section was silently
  elided; the successor arrived blind. A typed state object cannot lose a field to a char cap.
- The 09-07 crebral-health strandings — a prose handoff plus a fragile reopen chain.
- The "crossed wires" incidents — seats acting on stale transcript beliefs after the board or
  files changed underneath them. That is exactly the state-recovery failure SKILL.state removes.

## 2. Vision

**Trantor State**: a structured, mutable, validated execution-state object is the unit of a
seat's working memory. A seat carries it across turns and handoffs; the harness feeds it *that*
plus the card plus the latest tool result instead of the full transcript. Multiple seats share
and merge it under deterministic conflict resolution. Learning is captured as validated deltas to
the skill spec, not prose.

The single-agent substrate (state + handoff + per-turn patching) is what SKILL.state proves. The
**multi-agent merge operator** is the open problem the paper explicitly leaves unsolved — and it
is precisely Trantor's frontier and moat.

## 3. The state model

One typed object per seat-on-a-card (the schema is the seed of the whole system):

```
WorkingState {
  card:        number            # the card this state serves
  task:        string            # the goal, one line, immutable-ish
  done:        string[]          # verified-complete steps (evidence-backed)
  in_flight:   string[]          # started, not verified
  next:        string[]          # the plan
  blockers:    string[]          # what stops progress + who/what unblocks
  files:       Record<path, {touched, verified, blast_radius?}>
  verify:      { built?, tested?, observed?, cmd?, exit? }   # the DoD, structured
  notes:       string            # short free text — the open-ended tail
  cursor:      { turn, ts, by }  # provenance of the last patch
}
```

- **Patches, not rewrites.** A turn emits `{state_patch, action}`; the runtime applies
  `Σ_{t+1} = Σ_t ⊕ ΔΣ_t` (dict merge, null-deletes a key) and **validates** before persisting.
  A malformed patch triggers rollback-retry; it can never corrupt persisted state.
- **Hybrid, not purist.** Open-ended software work is SKILL.state's own failure case ("schema
  must be discovered dynamically"). So `notes` + a short recent-transcript **tail** ride
  alongside the structured fields. We replace the *reliance* on the transcript, not the
  transcript itself.
- **The record stays append-only.** SKILL.state's other failure case ("task defined over the
  trajectory itself — auditing, provenance") is literally our record. State is for execution;
  the record is for audit. Complementary.

## 4. Phased plan (the order the physics demands)

**Phase 0 — schema + validate/merge core.** Define `WorkingState`, the `⊕` merge with
null-delete, and a deterministic validator (schema + type coercion + the rollback-retry). Pure,
testable, no UI. This is the seed.

**Phase 1 — handoff as structured state (single-agent, immediate payoff).** The handoff record
becomes a `WorkingState`, merged-and-validated on write, so STATE can't be elided (`#6528`). The
successor loads the object directly, not a prose digest. Fallback: the current prose path stays
behind a flag until Phase 1 proves out on a real handoff.

**Phase 2 — per-turn working-state (the SKILL.state win).** A seat carries its `WorkingState`
across turns; the harness feeds `(skill spec, WorkingState, latest tool result, short tail)`
instead of the full transcript. Seats run longer per card, cost less, and survive reaper/time-box
cuts because the thread lives in the state. Cheap-seat patch errors (the paper's 68% premature
overwrite) are caught by the Phase-0 validator + optional grammar-constrained decoding; our hooks
enforce it.

**Phase 3 — the merge operator (multi-agent, the moat).** Shared state across seats needs
deterministic conflict resolution — the `⊕` the paper leaves open. Build on what we have: card
claims, `file-claim.mjs`, worktree isolation. Define merge semantics (last-writer-wins per key vs
field-level ownership vs claim-gated writes) and prove them under concurrent seats. This is the
part worth writing up as our own contribution.

**Phase 4 — learning as deltas.** Lessons (`scrooge learn`, `relay_lesson`, memory) become
validated patches to the skill spec, keeping the "sufficient statistic," not the paragraph.

## 5. Success metrics

- **No handoff elision:** every handoff carries a complete, schema-valid STATE (0 dropped fields).
- **Token cost:** a long card's cumulative tokens trend O(T), not O(T²); target ≥5× reduction on
  a real multi-turn card vs the transcript path.
- **Longer runs:** median turns-per-card before a forced cut rises; fewer reaper/time-box strands.
- **Zero-recovery on state change:** a seat whose board/files changed underneath it acts on
  current state without a hallucinated recovery burst (reproduce the paper's Table 3 on our bus).
- **Merge safety (Phase 3):** concurrent seats never silently clobber each other's state; every
  conflict resolves deterministically or is claim-blocked.

## 6. Non-goals

- Not replacing the append-only record (audit/provenance keeps it).
- Not a purist no-transcript runtime — hybrid, with a short tail and `notes`.
- Not a rewrite of the bus, board, or herdr — this is the memory model *under* them.

## 7. Risks / open questions for review

- **Schema drift:** software work resists a fixed schema. Is `WorkingState` general enough, or do
  we need per-project schema extensions? (Paper's limitation #1.)
- **Cheap-seat patch quality:** glm-flash / deepseek make patch errors. Is validator + retry
  enough, or do we need grammar-constrained decoding per provider?
- **Merge semantics:** which conflict-resolution rule (LWW / field-ownership / claim-gated) is
  right for our worktree-per-seat model? This is the core Phase-3 design decision.
- **Migration:** how long do we run structured-state and the transcript path side by side behind a
  flag before we trust it? Which project dogfoods first?
- **Fit with CodeGraph (`#6878`):** `files.blast_radius` in the schema is fed by the CodeGraph
  engine — the two initiatives share a data source. Sequence them so State can consume it.

## 8. Process

PRD review by the crew (`/trantor:prd-review`), then a TDD (`docs/TDD-trantor-state.md`), then
incremental build behind a flag with the transcript path as fallback per phase. Stabilize-aware:
each phase ships and proves on a real project before the next. Prove the substrate before the
layer — the paper's lesson applied to ourselves.
