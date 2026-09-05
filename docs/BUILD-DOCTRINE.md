# Build doctrine

How Trantor is built, and how every project run through Trantor is built. These are rules with
a gate each, not advice. An orchestrator that cannot show the gate has not followed the rule.
Operator ruling 2026-09-04, after a week in which the code was heavily tested and still broke on
the real path four times.

## 1. The real path is the gate

- Every card names its drill: the exact thing a person does on the built artifact and what they
  must see. A card without a drill line is not ready to be worked.
- Nothing merges until the orchestrator has run that drill on the built artifact (the installed
  app, the live hub, the real CLI on this machine) and written the result on the card.
- Unit tests are necessary and never sufficient. "All tests green" is not evidence that the
  operator will see the feature work.
- The seat that wrote the code never closes its own card to done. Testing is the seat's last
  move; done is the orchestrator's, after the drill.

## 2. Red blocks merge

- The whole suite runs on every push in CI. A red suite blocks merge, no exceptions.
- A suite red for more than one day is an incident with a card, not debt to be gated around.
- A flaky test is fixed or deleted within a week. Timing drills live in a quarantine lane that
  cannot hide a real failure.
- Tests never depend on the runner's own environment (identity badge, pane id, project). A test
  that inherits the badge and passes is lying.

## 3. One owner per subsystem

- Every subsystem (runner, hub, hooks, crew launcher, desktop shell, chat, code, board) has one
  named owner per wave. The owner reviews every change to it and may say no.
- A cross-seat edit to a subsystem goes through its owner over the bus before it lands.
- The orchestrator owns the gates and the merges. No seat merges to main.

## 4. Causes, not symptoms

- A fix names its cause in the commit message and adds the drill that fails without the fix.
  "Made X not happen" without a why is bounced.
- A second fix in the same seam within a week stops the line: the seam gets a contract document
  (docs/CONTRACT-*.md) reviewed by the orchestrator before more code lands there.
- Trace first. A bug report becomes a card only after the orchestrator has the trace, log, or
  crash report line that shows the mechanism. Guessing is not a plan.

## 5. Fewer parts

- Prefer deleting to patching. A subsystem that has needed three fixes in a month is a candidate
  for removal, not a fourth fix.
- No hand-rolled protocol, transport, sync, or auth layer when a maintained library does the job.
  If the library is installed, use it the way it is meant to be used; do not bypass it.
- Look at the reference product first (the Orca rule). Adopt its shape, then adapt. Inventing is
  the last option and needs a stated reason.

## 6. Shape limits

- A source file is at most 800 lines (Rust 1,000). A function is at most 80 lines. Past the
  limit, split by feature before adding to it.
- One language per layer. A shell script that parses JSON becomes a Node program.
- A module has one reason to change. A file named after a card, a date, or a person is wrong.

## 7. Comments and records

- A code comment is one line of why. The incident story lives on the card or in docs, and the
  comment links to it by number.
- Contracts live in docs/CONTRACT-*.md and are the source of truth for a seam. Code that
  contradicts a contract is the bug, whichever came second.
- Memory records decisions and traps, not code structure. The repo records code.

## 8. Rust and native boundaries

- No `unwrap` or `expect` outside tests. Clippy denies `unwrap_used` and `expect_used`.
- Every callback boundary into native code (extern "C", event handlers, window callbacks)
  catches panics and logs them. A panic there aborts the app, and the crash report will not say
  why.
- A patched or vendored dependency carries the upstream issue link and an expiry date in its
  directory. Past the expiry, it is re-evaluated, not kept by default.

## 9. Dependencies and releases

- Dependencies are pinned. An upgrade is a card with a drill, never a side effect.
- A release is: version bump, build, install on the operator's machine, drill, card note, memory
  line. Published is not shipped; installed and drilled is shipped.
- Every substantive change reports with the four evidence blocks: code written, builds (command
  and exit code), tested (command and counts), observed (the drill result). A report missing one
  says which and why.

## 10. Turn economy

- A seat's turn ends with a commit. Work that is not committed does not exist.
- A contract names the card, the files, the gate, and the drill. It never says "look into".
- No acks over the bus. A message either carries a contract, a bounce, a delivery, or a question
  that blocks work. Everything else is batched or not sent.
- A seat that exits non-zero twice on one contract parks. The orchestrator reads why before
  anything is redelivered.

## 11. Anything that warns

The monitoring doctrine applies: state, not event; episodes, not timers; never warn about what
the operator declared; report duration, not repetition; quiet is not dead; every wake costs a
turn.

## 12. Seats never touch the operator's live surfaces

- A seat never launches, quits, installs or replaces the installed app; never drives the running
  app's UI; never logs the operator into or out of any provider; never runs `trantor up`, `down`
  or `open` for any seat, its own included. These are the operator's surfaces and the
  orchestrator's hands.
- A seat's real-path evidence ends at: tests green, a build that exits 0 from its own worktree,
  and a note naming the drill. The orchestrator runs the drill, with the operator when it touches
  a live account.
- A seat dispatches no sessions of its own outside its worktree. Work that leaves the worktree
  does not exist.

## 13. Audit

A project is audited against this document before its next wave: file shape, test tree and CI,
owners, real-path drills, dependency pins, comment policy. The audit produces a scorecard and a
consolidation phase, and the wave waits for the phase where the scorecard says so.
