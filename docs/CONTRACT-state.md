# Contract: Trantor State (`lib/state/`)

The state package keeps a seat's working memory as a sidecar file and drives one step per turn
through it. Card #6450 moved these contracts here from comments; the design is docs/TDD (Trantor
State, §3, §4) and the incidents behind the rules live on the cards linked below.

## The order (driver, TDD §4.1)

- One step is `readState → assemble → run the CLI → tier 1 (git touch + credit expiry) → applyTurn
  → commit (CAS) → promote → execute(action)`. Every step is recorded in `trace`, so
  `test/state/test-runner-state.mjs` asserts the order as a fact rather than by reading the source.
- A rejected patch stops at applyTurn: nothing is committed, promoted or executed, and the rejection
  becomes the next observation.
- `bin/crew-runner.mjs` is not importable (it reads argv and awaits enrolment at module scope), so
  the step logic lives in `lib/state/driver.mjs` and the runner keeps only the wiring, the same split
  `lib/classify-failure.mjs` made earlier.
- The run-record paths and budgets are published by `bin/state-bench.mjs` and imported upward on
  purpose: no number gets a second home. The bench guards its own dispatch, so importing it runs
  nothing.
- `executeAction` runs LAST, after promote, and only on an accepted patch. "Promote before act" is
  the half of §4.1 a refactor loses most easily, because nothing downstream notices for a while.
- The JSON schema handed to `claude --json-schema` is built from the list names, so a fifth list
  added to the schema and not to the driver cannot drift silently. `action` carries no
  `{tool,input}`: on a CC seat one step is one whole agent loop.
- The CLI is probed for `--json-schema` rather than assumed (§6). No flag means state mode stays OFF.
- The envelope's `result` arrives as an object on a schema-enforced run and as a JSON string on
  some releases; both are accepted. Anything else is `turn: null` with a reason, never a guessed
  empty patch, which would look like a seat that legitimately changed nothing.
- The runner's boot line ("ASSEMBLE armed") proves configuration only. Whether THIS turn is
  assembled is asked every turn through `turnNotAssembledReason` and printed, because a kickoff or
  a pulse belongs to no card and can never be a state step (#7060).

## Tier 1 and credit expiry (§4.8, R12)

- Git says what changed, so `touched` is set from it every turn. Every path still carrying a credit
  is re-hashed and the credit is dropped wherever the blob sha moved off `files[p].hash` or the file
  is gone. Setting evidence is the gate's privilege; expiring it is tier 1's, because tier 1 is the
  only thing that runs every turn. Without this half `verified` goes monotonic-true in production
  while every unit test stays green.
- Tier 1 never sets `verified: true`. Touching a file is not evidence that it works.

## The circuit breaker (§7.3)

- Counts MALFORMED output only. `UNVERIFIED_DONE` and `NEEDS_GATE` are the system working: a seat
  writing perfect patches against a failing test is the healthiest seat there is.
- The window must be FULL before it can trip. A rate of 1.0 over one turn is not a rolling rate.

## The run record

- One row per step is appended to `~/.agent-bus/state/runs/<project>-<card>.jsonl`. The field
  names are a contract with `bin/state-bench.mjs`: gate 3 reads `cache_read`; gate 4 reads
  `cost_usd`, `input`, `output`; gate 5 reads `disturbed`, `action`, `input`; gate 6 reads `rev`,
  `verify.cmd`, `verify.exit`, `verified_paths`, `rejected.code`, `by`; §8.7 reads `cut`. A row
  with the wrong names is a run the bench cannot see (NO_RUN).
- A cost the envelope did not carry stays null. Never 0: a 0 flatters the ≥5× gate.

## Cost (§4.6, §4.8)

- The seat's stream output is the COST source only, never an evidence source. `lib/state/cost.mjs`
  imports no state and owns no writes, so `verified` cannot be set from there.
- `fromEnvelope` reads the `--output-format json` result (`total_cost_usd` and the four usage
  counters); `fromTranscript` sums the same shape from a CC transcript's assistant usage rows over
  the whole file. Anything without a usage object is null, never 0.

## Assemble (§4.6)

- A step's prompt is `preamble + STATE_DELIM + renderState(state) + TAIL_DELIM + tail + OBS_DELIM +
  observation`. The bytes before STATE_DELIM are the caller's preamble and NOTHING else: no state,
  clock or turn number may leak into the prefix, or provider prefix caching never engages and the
  cost curve stays O(T). `test/state/test-assemble.mjs` hashes the prefix from two different states
  to hold this.
- Caps keep the END of a string: the recent lines of gate output and of the card log are the live
  context. The prompt is O(1) in turn count by construction.
- Runtime-owned `ext` keys (`_gate`, `_promoted`) are not rendered. A null or broken state renders
  as "" and never throws.

## Schema and validation (§3, §4.2)

- `lib/state/schema.mjs` holds shapes, caps, the write matrix and the evidence marker; it reads
  neither disk nor clock. The evidence marker regex (`… @path,path`) lives there and nowhere else.
- Markers are extracted into `paths` BEFORE any cap is applied, so a long text can never truncate
  away the paths route (b) depends on.
- A `move → done` needs route (a), the gate went green this turn, or route (b), every named path is
  credited. The check reads `ctx` FIRST with the same precedence apply.mjs stage 5 uses (`verify`
  wholesale from ctx, `files` merged per path), because the gate's facts reach the state only
  through stage 5, which never runs when validation rejects first (#6969).
- `ctx.gate_attempted` splits NEEDS_GATE (no gate ran) from UNVERIFIED_DONE (a gate ran and came
  back red). Without it the one-retry bound of §4.8 is false.
- Apply is one point per turn on a CLONE, returned only when every op passed. That is the whole
  crash-safety argument (§4.4).
- The board sees only what shipped, what blocks and what the evidence says (§4.7). `in_flight` and
  `next` are scratch and promote nothing (#6669).

## Derive (§4.5)

- A handoff with no sidecar gets a WorkingState from git and from the model's own STATE block,
  through `applyTurn`, never a second parser, so the write matrix, caps and evidence rules hold on
  the handoff path for free.
- A DERIVED STATE CARRIES NO CREDIT: every path is `verified: false` and `verify` is empty, so the
  successor must re-earn its evidence before anything moves to `done`.
- Bullets only; an unlabelled bullet lands in `in_flight`, never `done`. Over-cap lines are dropped
  in derive with a notes line naming the count, rather than rejecting the whole patch.
- A rejected patch does not cost the state: git-derived files, the task and one notes line still
  make a schema-valid state, or the function returns null, never a half-built one.

## The gate (§4.8)

- `runGate` computes and returns; it never touches state. Stage 5 of apply lands its memo.
- The memo keys on tree CONTENT: HEAD sha plus a worktree tree sha from a scratch index
  (`git add -A` folds untracked files in), never on `git status --porcelain`, which records that a
  path changed but not what is in it. The scratch dir is `<cwd>/.agent-bus-out/` (falling back to a
  temp dir) and is excluded through the repo-local `.git/info/exclude`; unignored, the index file's
  own timestamp bytes would keep the memo from ever hitting. No pathspec is used, because git
  refuses an explicit `:(exclude)` on an ignored path.
- Command resolution, first match wins: `TRANTOR_STATE_GATE`, then the scoped
  `node test/run.mjs --only <subsystem>` when every path sits under one subsystem with a sibling
  suite dir (`lib/state/*` ↔ `test/state/`), then `scripts.test`, then none. Scoped resolves BEFORE
  `scripts.test` because the full suite collides with sibling seats on fixed ports. Build resolves
  `TRANTOR_STATE_BUILD` → `scripts.typecheck` → `scripts.build` → none.
- `verified` means "a gate covering this path passed" (R11). Under scoped coverage, touched paths
  outside the scope come back `verified: false`.
- Touched paths are read with `git status -z`: without `-z` git C-quotes any path with a non-ASCII
  byte and the credit a seat names never matches its file, so route (b) would fail closed silently.
- Return shape: `{ verify, files, coverage, cmd, exit, ms, tail, memo, memoHit }`. `verify` is
  `{ tested, cmd, exit }` plus `built` only when a build ran; `observed` is never set by a test
  runner. Credited paths carry `{ touched, verified: true, hash }` (the blob sha tier 1 later
  expires against). A RED gate (test, build, slop-gate or timeout at `GATE_MAX_MS`, exit 124)
  credits no path and carries cmd/exit/tail for UNVERIFIED_DONE.

## Promote (§4.7)

- One turn's delta becomes AT MOST ONE `/task/update` note, deduped by content hash, and
  `ext._promoted` advances only after the hub answers 2xx.
- The card is the shared record, state is private working memory, promotion is one-directional.
  It never moves a card's status (that is the seat's `relay_task_move`) and never promotes scratch.
- A failed POST is non-fatal and never rolls back state; the hash stays, so the next turn re-sends
  the same content, harmless if the POST in fact landed.

## The store (§4.4)

- No journal replay: there is exactly one apply point per turn, so a killed turn never
  half-applied a patch and the on-disk state is the last good state, whole. What a dead turn lost is
  its OBSERVATIONS, which recovery rebuilds from git. `<sidecar>.ops.jsonl` is forensics and test
  replay only.
- No lock file: concurrency is a compare-and-swap on `rev`. A lock file in `~/.agent-bus` outlives
  the process holding it.
- No STALE retry in the store. The driver cures STALE by re-reading and re-running applyTurn, safe
  because ops are id-addressed and the failures re-application can hit (DUP_ID, NO_SUCH_ID) are
  exactly what re-application means.
- The sidecar is per SEAT-CARD. Path components are sanitised as `hooks/ask-sidecar.mjs` does;
  "", "." and ".." are rejected. The cut marker is looked up both under `AGENT_BUS_DIR` and under
  homedir(), because the runner writes it from homedir() directly.
- Recovery after a cut turn re-derives `touched` from `git status -z -uall` (a rename yields both
  paths) and re-hashes every credited path, clearing the credit where the blob moved (R12). The
  repair is persisted before the marker is cleared and `rev` is NOT bumped, so the caller's
  expectedRev still matches when it commits its own turn.
- Blob shas come from `git hash-object`, the same computation the gate used, so a credit is
  compared against the tool that minted it.
- Notes-tail eviction is line-wise (a mid-line elision is #6528). apply.mjs and migrate.mjs hold
  their own copy of the loop; a shared helper is a P0 change.
- Migration reports; the store keeps an unmigratable original under `.v<n>.json`.
- GC lists candidates (terminal card by the caller's predicate, file older than GC_AGE_MS) and
  removes nothing unless `apply` is set.
