# Contract: Trantor State (`lib/state/`)

`docs/TDD-trantor-state.md` is the design; this sheet is the short list of invariants the code
comments used to restate. Section numbers refer to the TDD.

- **Schema** (`schema.mjs`, §3): one file holds the shapes, caps, write matrix and the evidence
  marker regex; nothing in it reads the disk or the clock. `EVIDENCE_MARKER` lives here and
  nowhere else. `stateError` is total: never throws, returns the first problem or `""`.
- **Validate** (`validate.mjs`, §3, §4.2): extract the evidence marker BEFORE any cap, then cap.
  `hasEvidence` reads `ctx` first (the gate's facts arrive there and are only written to state by
  apply stage 5, #6969), with the same precedence apply uses. `ctx.gate_attempted` splits
  NEEDS_GATE from UNVERIFIED_DONE; without it §4.8's one-retry bound is false.
- **Apply** (`apply.mjs`, §4.2, §4.4): validate, apply to a clone, runtime pass. One apply point
  per turn is the crash-safety argument: a killed turn has never half-applied a patch. `verify`
  and `files` are harness facts from a gate that ran, never testimony. `promotionPlan` promotes
  done, blockers and evidence only; `in_flight`/`next` are scratch (#6669).
- **Store** (`store.mjs`, §4.4): no journal replay (the journal is forensics), no lock file
  (compare-and-swap on `rev`), no retry of STALE (the driver cures it). Sidecars are per
  seat-card. `gitTouched` uses `-z -uall`; `recover` re-derives `touched` from git AND re-hashes
  every credited path, clearing the credit where the blob moved (R12). A repair persists before the
  cut marker clears and never bumps `rev`. `gcSidecars` lists by default and removes only on
  `apply`.
- **Migrate** (`migrate.mjs`): reports; the store keeps the original under `.v<n>.json`.
- **Derive** (`derive.mjs`, §4.5): a derived state carries no credit (`verified: false`, empty
  `verify`). The model's STATE block goes through `applyTurn`, never a second parser; unlabelled
  bullets land in `in_flight`; over-cap lines are dropped with a notes line naming the count.
- **Assemble** (`assemble.mjs`, §4.6): bytes before `STATE_DELIM` are the caller's preamble and
  nothing else, or provider prefix caching never engages. `test-assemble.mjs` hashes the prefix
  from two states. `capTokens` keeps the END. `renderState` is total and renders a broken state
  as `""`. The prompt is O(1) in turn count by construction.
- **Cost** (`cost.mjs`, §4.6, §4.8): stream output is the cost source, never an evidence source.
  An unknown cost is `null`, never 0 (a fake 0 flatters the ≥5× gate). Envelope and transcript
  produce one struct.
- **Gate** (`gate.mjs`, §4.8): the memo keys on tree CONTENT via a scratch index, never on
  porcelain; the scoped `node test/run.mjs --only <subsystem>` resolves before `scripts.test`
  (seats must never run the full suite); `verified` means a gate covering that path passed (R11).
  Slop-gate always runs when the repo has one. `observed` is never set by a test runner. Red
  (test, build, slop-gate or timeout) credits no path.
- **Promote** (`promote.mjs`, §4.7): at most one card note per turn, deduped by content hash,
  `ext._promoted` advanced only after a 2xx. Never moves a card's status.
- **Driver** (`driver.mjs`, §4.1, §4.8, §7.3): the ORDER is readState → assemble → run CLI →
  tier 1 (git touch + credit expiry) → applyTurn → commit (CAS) → promote → execute(action), every
  step in `trace`. `TURN_RESULT_SCHEMA` is built from `LISTS`. `parseEnvelope` never guesses an
  empty patch. `tier1Files` never sets `verified: true`. The breaker counts MALFORMED only and
  needs a full window. `recordStep` field names are a contract with `bin/state-bench.mjs`.
  Paths and budgets are imported from `bin/state-bench.mjs` on purpose: no number has a second home.
