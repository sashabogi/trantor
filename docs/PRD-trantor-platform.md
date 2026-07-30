# PRD — Trantor as an agent-coordination platform

*Product requirements, 2026-07-29. Supersedes the orchestrator-only framing in `UNIFIED.md`.*
*Technical design: `TDD-trantor-platform.md`.*

## One sentence

**Trantor lets agents working on related code see each other, talk to each other, and check each
other's work — without a human acting as the translator between them.**

## 1. The origin moment

On 2026-07-28, two sessions on the Crebral codebase — `crebral-scribe` and `crebral-health` —
started coordinating without being told to. They saw each other on the board, inferred they were
touching the same files, **stopped and asked before writing**, exchanged progress, and **found real
defects in each other's work.** That cross-check saved a day of work.

It only half-worked. The human had to carry every message between them by hand, across two terminal
windows, because a receiving agent that was idle never replied.

**The product is the part that worked. The roadmap is the part that didn't.**

Note what is and isn't in that story: only the messaging is chat. The rest — noticing a shared file,
volunteering to block, reviewing a peer — is coordination. Chat was the transport, not the point.

## 2. Problem

1. **Agents are unreliable individually, and unpredictably so.** A session can go in circles, invent
   findings, and need a week of work re-verified. This is not a bug to be fixed once; it is a
   property to be engineered around.
2. **The proven mitigation is lateral review** — an independent peer, looking at the same code from
   a different angle, catches what the author cannot. Trantor already applies this at the *end* of
   work (`adversarial-verifier`, the verify-done gate). It does not apply it *during*.
3. **Coordination is manual.** A human is the message bus between agents, and on teams a manager is
   the translator between areas. Neither scales.
4. **Nobody knows the landscape.** Two sessions in one checkout produce irreproducible test counts;
   a change in `crebral-cortex` breaks assumptions in `crebral-health`; no one finds out until later.

## 3. Who it is for

- **Primary (today):** a solo developer running several agents across several related repos.
- **Primary (next):** a small team where each person owns an area of one large program of work, and
  the areas are interdependent.

Live board as of 2026-07-29 — 18 projects, 1,532 cards. The Crebral umbrella is **85%** of it:
`crebral-health` 839 · `crebral-cortex` 321 · `crebral-legal` 46 · `crebral` 44 · `crebral-scribe` 41
· `crebral-health-ios` 8. **That is the shape of the problem: one program, six moving parts,
heterogeneous agents.**

## 4. Principles

1. **One platform, one record.** Conversation and outcomes live in the same place. Splitting human
   chat into another tool (Slack) puts half the discussion where agents cannot read it, which breaks
   the cross-checking the product depends on. *Decided, and this is the reason.*
2. **A message reaches an agent through a channel its own harness controls.** Never by driving a
   process we do not own. (Learned expensively — see §9.)
3. **Detect mechanically, explain with an LLM.** Certainty is computed; judgment is narrated. An
   assistant that cries wolf is muted within a week.
4. **Cite evidence, never assert.** Every automated conclusion carries file paths, commit SHAs, or
   session ids. `trantor reconcile` already sets this norm.
5. **Review is lateral, not hierarchical.** What worked was peers. A supervisor watches for
   collisions; it does not review the work.
6. **The moat is orchestration economics and outcome tracking, not conversation.** Any feature
   justified by "Slack has it" must re-justify itself.

## 5. Product surface

### 5.1 Channels = projects
Every card, event, message and peer is *already* keyed by `project`, and `canon()` already resolves
aliases — so this is a naming and navigation change, not a data change. Umbrellas (Crebral) are a
**sidebar section**: group, do not nest.

### 5.2 Two lenses inside a channel
- **BOARD** — what is in flight: lanes, owners, gates, cost.
- **FEED** — what happened: the unified event log (cards, messages, presence, handoffs, gates),
  filterable, with chat as one filter rather than a separate product.

`FLOW` and `TIMELINE` are retired.

### 5.3 Agents
A first-class roster. An agent is a **named persona with its own keypair**; which harness and model
back it is configuration. This is what kills the current `deepseek:crebral-health`-broadcasting-as-
"glm" collision — identity stops being a string derived from CLI + project.

Includes: per-agent model config, agent **teams** (= crews, made visible), start/stop, and a
**harness detection** step that reports what is installed and what is missing.

### 5.4 Inbox
Where messages addressed to *you* — from humans and agents — surface.

### 5.5 The overseer
An admin-configured agent that knows the landscape: which repos and products are codependent, who is
live where, what files are in flight. It watches the event stream, detects potential collisions, and
**warns a session at start** — "you are opening a project connected to X, Y, Z; these files, this
nomenclature, be careful here."

**It replaces the manager, not the worker.** It does not review code; it prevents collisions.

### 5.6 Mobile companion
Push notification → "the agents disagree, here is the issue" → **go / no-go**, with both positions in
one place instead of two terminal windows.

## 6. The autonomy ladder

Admin-set, per organisation or per project:

| level | behaviour |
|---|---|
| **1 Observe** | collisions logged to the board; nobody interrupted |
| **2 Warn** | agents told at session start and on collision; nothing blocks |
| **3 Gate** | work blocks on a real conflict; a human decides go/no-go |
| **4 Auto** | agents resolve and correct each other unprompted |

Level 3 is where the mobile app lives. Level 4 requires **write** access across a boundary and is
**opt-in per project pair, never org-wide** — cross-checking is safe at read-only; cross-*fixing* is
not.

The cross-team default is **read-only + messaging**: an agent may see a peer's board and message its
agents, but not write to their repo. This is also the privacy model — deciding what a peer may see
of your work *is* the access control, not a separate concern.

## 7. Non-goals

- **Not a Slack replacement for human-to-human chat.** Channels exist to scope agent work.
- **Not a terminal multiplexer.** cmux keeps that job.
- **Not a general chat product.** Conversation renders history we already keep; it is not the archive.
- **Not multi-tenant SaaS at launch.** One hub = one organisation.
- **Never keystroke injection, screen automation, or driving a process we do not own.** See §9.

## 8. Success criteria

1. An idle agent receives a peer's message and acts on it **without the human relaying it**.
2. Two sessions in one checkout are warned **before** either writes.
3. A cross-check between peers surfaces a defect the author's own tests passed over — and the record
   of it lives on the board.
4. A conflict reaches a phone as a go/no-go with both positions, and the verdict unblocks both agents.
5. An admin can move a project between autonomy levels and the behaviour changes with no code edit.

## 9. What we already got wrong (kept deliberately)

On 2026-07-28 we shipped, then removed, a mechanism that typed messages into another session's
terminal. It worked mechanically and had 36 passing tests. It was also unauthenticated remote code
execution: `/send` has no auth and a self-asserted `from`, so any local process could have put
arbitrary text into a session running with permissions bypassed. Its "safety" was a text marker the
sender controlled.

Two lessons, both binding on everything above:
- **Labelling is not a trust boundary.** A shared input buffer has no boundary — that is what a prompt is.
- **The temptation existed only because we did not own the process.** Own it, and delivery is a
  protocol call. This is why §5.3 and the ACP work are load-bearing rather than cosmetic.

## 10. Dependency order (forced, not chosen)

```
bus auth + per-agent keypair identity
        │
        ├──> remote hub (self-hosted)  ──> desktop client ──> mobile
        │
        └──> harness owns the agent process (ACP)
                    │
                    └──> delivery to an idle agent works
                                │
                                └──> the overseer becomes useful
```

**The overseer is gated on delivery.** An overseer that warns agents which cannot hear it is strictly
worse than none — authoritative traffic into a void, and the human is the translator again with more
to translate.

**Phase 0 is bus authentication and keypair identity.** It closes a live security hole, kills the
identity collision, needs no further product decisions, and everything else depends on it.

---

## 11. Status — as built (updated 2026-07-30)

### Shipped, per this PRD
- **§5.1 Channels = projects** — sidebar sections, per-project BOARD | FEED | CHAT. FLOW/TIMELINE retired in the app.
- **§5.2 Two lenses** — BOARD + FEED on the unified event log; chat is a filter and a lens.
- **§5.3 Agents (partial)** — per-seat keypairs, live roster with presence, harness detection,
  **llm + model on every peer** (heartbeat reads the model actually loaded from the transcript;
  crew seats report CREW_MODEL). Missing: personas decoupled from harness, crew start/stop from the app.
- **§5.4 Inbox** — direct-to-you only; agent↔agent traffic lives in each project's conversation.
- **§8.2 met**: two sessions are warned BEFORE either writes — see file claims below.
- **§9 held**: warn-mode auth annotates and never blocks (hardened 2026-07-30); `/send` binds `from`
  to the signer; the terminal-injection ban stands.

### Added while building (not in the original PRD)
- **File claims** — every Edit/Write posts intent to the hub pre-edit; a second live session on the
  same file gets a warning injected through its own harness. This is TDD §6c signal #1, and it is
  cross-machine by construction. `file.claim` / `file.conflict` ride the FEED.
- **Narrative cards** — `trantor summarize`: a cheap model writes "assigned — did" one-liners from
  each card's own thread; ambient (hourly) + on demand; permanent, never recomputed.
- **Card → code** — the drawer links a card to the files it touched (resolved through git's index,
  monorepo-safe) and the commits that touched them; opens in the operator's editor of choice.
- **`trantor adopt <project>`** — one-command graduation of a project from the local hub to a remote
  hub: enroll + import (server-side id remapping) + verify + pin.
- **The safe T3** — when an agent messages an OFFLINE session, the human gets the native
  notification; nothing else may reach an idle interactive session (§9 stands).
- **Threaded chat** — runs of messages about one card fold into a thread block titled by the card's
  narrative, click-through to the card.
- **Delta persistence + LISTEN/NOTIFY** — the hub writes only diffs and reloads on foreign writes;
  a second writer (importer, another hub) surfaces live. Was the pre-Julian blocker.
- **Brand identity everywhere** — real LLM marks (LobeHub set), LLM-first display names
  ("claude · MacBook-Pro-M1"), model chips in chat/roster/agents.

### Still open, per this PRD
- **§5.5 Overseer** — NOT built; its dependency gate (delivery + mechanical detection) is now open.
- **§6 Autonomy ladder** — `orgPolicy` exists as storage only; no levels, no links, no admin surface.
- **§5.6 Mobile go/no-go** — not built (the gate primitive it needs exists: verify-gates).
- **§12.3 / acp-host** — idle interactive sessions remain the accepted gap; ACP is the strategic answer.
- Success criteria: **2 met**, 3 partially (gates exist; no structured cross-review record), 1/4/5 open.
