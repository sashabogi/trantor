---
name: prd-review
description: |
  Convene the crew's review of a project's brief (docs/PRD.md) and then of its design
  (docs/TDD.md): every live crew seat plus two Scrooge readers review the document independently
  against one rubric, the orchestrator synthesizes their verdicts into one consensus and puts it
  to the operator, and the build cards open only after the TDD passes. Use when a wake says
  "docs/PRD.md is the brief; run /trantor:prd-review", when asked to have the crew review a PRD
  or a TDD, or to resume at the TDD phase. Trigger: /trantor:prd-review [prd|tdd]
user-invocable: true
argument-hint: "[prd|tdd]"
---

# PRD review: the crew reads the brief before anyone builds

Ruled by the operator on 2026-09-02: every PRD that gets ingested is reviewed by as many members
of the crew as are live, the crew reaches consensus on whether it is good enough to move on to the
TDD, the TDD gets the same review, and only then does the build start. A solo orchestrator that
recaps the brief and proposes a plan is exactly what this replaces: one reader's blind spots become
the product's. Lateral cross-review is the reliability argument, so the reviews are INDEPENDENT.

You are the project's ORCHESTRATOR. You convene, you dispatch, you synthesize, you record. You do
not review the document yourself and you never vote: a verdict of yours would be one more opinion
from the one seat that also decides what the opinions mean.

Phase argument: none or `prd` runs the PRD phase and continues into the TDD phase on a pass;
`tdd` resumes at the TDD phase when the PRD card is already done (a turn or a session ended in
between).

## 0. The board first

1. `relay_board`. A card titled `PRD review: <project>` (for `tdd`: `TDD review: <project>`)
   that is not done is THE card: continue on it, never open a second one. Its notes hold the
   roster and every verdict so far.
2. `docs/PRD.md` must exist in the checkout. If it does not, say so and stop: there is nothing to
   review, and a review of a brief that is not written down is not a review.

## 1. Establish the reviewers

The reviewers are, by the ruling, every live seat of the project's crew plus two Scrooge readers
on two different models.

1. **Crew seats.** `relay_peers` lists the live sessions. A reviewer is every online
   `<cli>:<project>` seat of THIS project (`codex:<project>`, `glm:<project>`, `kimi:<project>`,
   …). Not reviewers: you, the operator's host session (`<host>:<project>`), and tool
   identities such as `genesis:<project>`.
2. **No crew live?** Bring one up FIRST through `/trantor:crew`: `relay_advise` with the review
   as the work, then `trantor up …` with the SUBSCRIPTION seats the operator's profile declares
   (`trantor profile`), and read the launcher's verdict: only a seat that verified on the bus
   reviews. Choosing the brief path already authorized a review crew; do not ask again, and do
   not substitute metered API seats the profile did not select.
3. **Two Scrooge readers.** `relay_scrooge` twice with the identical rubric and the full text of
   `docs/PRD.md` in the prompt (the cheap model sees only the prompt; use `task: "reason"`, or
   `task: "long-context"` for a brief beyond about 40k characters). Each receipt names its
   `provider/model`; the two must differ. If the second lands on the same model, retry it at a
   different `difficulty` (the router escalates to a different model). If two distinct models
   cannot be had, proceed with one and say so on the card: never describe one model twice as two
   independent readers.

The roster (seat ids plus the two `provider/model` receipts) goes into the review card's opening
note and is FROZEN: the TDD phase uses the same seats and the same two models. A seat that dies
between phases is restored with `trantor up`, not replaced by a different reviewer.

## 2. The rubric

One rubric for every reviewer, in this order, in these words:

1. **completeness** — what the brief covers and what it leaves unsaid;
2. **ambiguity** — statements that two builders would implement differently;
3. **feasibility and risk** — what is hard, what could fail, what depends on the unknown;
4. **missing requirements** — what the brief needs and does not contain;
5. **a proposed scope cut** — the one thing to drop or defer first;
6. **VERDICT: READY** or **VERDICT: REVISE**, with the gaps listed.

A review note that lacks any of the six parts is incomplete: bounce it to the reviewer with a
direct message naming the missing part. Never fill a part in on a reviewer's behalf.

## 3. One card, one item per reviewer

Run the two Scrooge reads first (they are stateless and need no card id), then open the card with
`relay_task_add`:

- title `PRD review: <project>`, phase `PRD`, difficulty `hard`, assigned to you, status `doing`;
- `checklist`: exactly ONE item per reviewer, labelled with the reviewer's identity
  (`codex:<project>`, `glm:<project>`, `scrooge deepseek/deepseek-v4-flash`, …);
- the opening `note`: the document path, the frozen roster, the six-part rubric, and the consensus
  rule from §4.

Append each Scrooge verdict UNCHANGED as a card note prefixed with its receipt's model, then tick
that model's item. Carrying a reader's verdict onto the card is transport, not a vote of yours.

Then `relay_send` every crew seat the same contract, as a DIRECT message (broadcasts do not wake
a seat), under 280 characters:

> PRD review card #<id>: read docs/PRD.md in your worktree. Note on the card, in order:
> completeness, ambiguity, feasibility+risk, missing requirements, one proposed scope cut, then
> VERDICT READY|REVISE with the gaps. Tick your item (index <n>). No file edits.

A seat records its review with `relay_task_move` to the card's CURRENT status carrying the note
(the note is the review; the move is how a note lands), then ticks only its own checklist item
with `relay_task_check`. Reviews are independent: a seat that quotes another seat's note gets a
bounce, not a tick.

## 4. Consensus, then the operator

Supervise as the crew skill's foreman loop: `relay_wait`, sweep the card and `relay_peers`, nudge
a silent seat by direct message, `trantor up` a dead one and resend its contract. The review is
in when every checklist item is ticked and every note has the six parts.

- **All READY** = the crew's pass.
- **Any REVISE** = you merge every gap from every reviewer, READY ones included, into ONE
  revision request: deduplicated, attributed, ordered by how many reviewers raised it.

Either way the outcome goes to the OPERATOR in ask mode: this gate is always asked, never
auto-fired. Present the roster, one line per verdict, the merged revision request when there is
one, and the crew's outcome, then ask (`AskUserQuestion` when the harness offers it, plain chat
otherwise). The operator may confirm the consensus, override a REVISE into a pass, or send a
unanimous READY back for revision. Record the decision and its reason as a card note.

- **Pass:** move the card to `testing` with the tally (`n READY / m REVISE`, the decision), then
  to `done`. Continue with the TDD phase.
- **Revise:** hand the operator the revision request; the operator revises `docs/PRD.md` or asks
  you to draft the revision for their approval. When the file changes, untick every item
  (`relay_task_check` with `done: false`), re-dispatch the same roster on the SAME card, and
  repeat §3 and §4.

## 5. TDD phase (`/trantor:prd-review tdd` resumes here)

The PRD card is done. Now one author writes the design and the same reviewers review it.

1. **Author.** Pick ONE live crew seat as the author (the strongest coding seat the profile
   gives you; say which and why on the card). Its contract: write `docs/TDD.md` from the accepted
   PRD, covering architecture, the interfaces and data flow (the event/interface contract between
   agents), file ownership as one file-set per seat, dependencies, the verification plan, risks,
   and a work breakdown of build packages each tagged `easy|medium|hard`. The author does not
   review its own design.
2. **Card.** Open or reuse exactly one `TDD review: <project>` card in phase `TDD`. Its checklist
   starts with `author <seat>: docs/TDD.md written`, followed by one item per reviewer of the
   frozen roster minus the author. The author ticks its item only once the file exists.
3. **Rubric, adapted to a design:** completeness (every PRD requirement has a home in the design),
   ambiguity, feasibility and risk, missing design pieces (interfaces, ownership, verification),
   a proposed scope cut, `VERDICT: READY` or `VERDICT: REVISE` with the gaps. Same Scrooge reads
   with `docs/TDD.md` in the prompt, same direct contracts to the seats, same note shape, same
   ticking rule.
4. **Same consensus, same operator gate** as §4, on the TDD card. A revision goes back to the
   author, not to the operator to write.

## 6. On a TDD pass: the build cards open themselves

The confirmed TDD is the gate. Do not ask the operator again merely to open its build cards.

**But confirm the TARGET PROJECT before dispatching, always.** An ambiguous instruction ("build it
where the answers are stored") is not a project name — it does not license bringing up seats in, or
sending contracts into, a DIFFERENT project than the one you are reviewing. Name the project and ask
the operator once if the brief points anywhere but here. Cross-project action is a breach unless the
operator linked the projects (`trantor policy link <a> <b> --reason "<why>"`), and the hub, the
`trantor up` CLI, and every seat's runner all refuse it mechanically — belt and braces, not a
substitute for getting the target right in the first place.

1. Move the TDD card through `testing` to `done` with the tally and the decision.
2. `relay_advise` with the work breakdown's packages, then one `relay_task_add` per package:
   phase `build`, the advisor's assignee and `model`, its `difficulty`, `deps` on the packages it
   needs first, and a `checklist` of its acceptance tests from the TDD's verification plan. A
   build card without its model set is a defect.
3. Start the build as the crew skill's phase 3: contracts over the bus, one file-set per seat.
   How far the build may go on its own (commit, push, deploy, handing off) is the project's
   autonomy dial (`trantor autonomy`); the dial governs the build, not the opening of its cards.
