---
name: crew
description: Orchestrate a multi-agent build over agent-bus — get an Advisor recommendation (solo/scrooge/crew/hybrid based on the user's plans and the work), fire up helper AI CLIs (Codex, Gemini, Kimi, DeepSeek) with pinned models in visible terminal windows, assign difficulty-tagged work over the bus, track it on the Kanban dashboard with a testing gate, delegate grunt to Scrooge, supervise actively, integrate, ship. Use when the user wants several AI agents building something together, says "fire up the crew/agents", or asks to coordinate other coding CLIs on a task.
---

# agent-bus crew — the unified playbook (brain × body)

You are the ARCHITECT. Two execution fabrics serve you:
- **Scrooge calls** (`relay_scrooge`) — cheap stateless one-shots; the result returns to you.
- **Crew members** — stateful colleagues in their own context windows under a runner that
  keeps them alive forever and wakes them on bus messages. They report by reference.

**Decision rule:** small + stateless + result-fits-inline → `relay_scrooge`.
Large + stateful + parallel or long-horizon → crew member. You stay a foreman either way:
your context burns at coordination rate, never work rate.

## Phase −1 — THE ADVISOR MOMENT (always, before spending anything)
Cut the work into packages, tag each `easy|medium|hard`, then call
`relay_advise(task, packages, horizon)`. It weighs task shape × the user's declared plan
economics (quota profile) × context horizon and returns mode + routing + a real-money
estimate. **Present its summary to the user in one paragraph and get a go** — e.g. *"You're
on a capped plan; 6 packages — recommend HYBRID: codex/gemini take the hard ones, deepseek
the mediums (~$0.40 real), readme goes to Scrooge. Fire it up?"* If the profile is unset,
say so and suggest `node bin/profile.mjs set claude=… codex=…`.

## Phase 0 — plan (if the user wants a plan first)
PRD.md + TDD.md. The TDD MUST define one file-set per agent (no merge conflicts) and an
explicit EVENT/INTERFACE CONTRACT — cross-agent bugs come from contract drift.

## Phase 1 — board setup
1. `relay_project_brief("<what + why + goal>")`
2. One card per package: `relay_task_add(title, assignee, difficulty)` — difficulty shows on
   the board and justifies the routing. Assignees: `codex:<project>` etc. Keep one for yourself.
3. Open the dashboard: `open -na "Google Chrome" --args --new-window <hub-url>`

## Phase 2 — fire up the crew (with the Advisor's models)
`bash <plugin-root>/bin/crew.sh up codex:gpt-5.5 gemini kimi deepseek:deepseek-v4-pro`
— `agent:model` pins a model (omit to use that CLI's default; use what relay_advise routed).
The launcher auto-wires configs, spawns serialized runner windows, then **VERIFIES each agent
on the bus with one retry**. READ ITS OUTPUT: it ends "crew verified" or "✗✗ CREW INCOMPLETE"
naming no-shows. **Never assign work to an unverified agent.** The bus is the truth.

## Phase 3 — contracts over the bus
Build the shared foundation yourself first, then `relay_send` each agent its contract
(<280 chars): file(s) owned, the interface contract verbatim, the spec. NOTE the wake-policy:
plain broadcasts do NOT wake crew members (they batch as context) — to wake one, send a
direct message or @mention it (`@codex …`) in a broadcast.

## Phase 4 — SUPERVISE ACTIVELY (never wait passively)
Loop until the board is done — you are a foreman, not a mailbox:
1. `relay_wait(120)` (long waits are safe for YOU only; crew runners handle their own waiting).
2. EVERY wake or timeout, SWEEP: `relay_board` (stale cards? `failed` pulsing?), `relay_peers`
   (assignee lastSeen fresh? runner heartbeats keep live agents fresh in seconds — stale =
   dead), spot-check files on disk.
3. ACT within one cycle: failed card → read the report, send a fix contract, card back to
   doing · dead agent → `crew.sh up <agent>` (re-verifies) + resend contract · silent-but-alive
   → direct-message nudge naming the card.
4. Grunt sub-tasks that appear mid-build (a regex, a config block, a doc paragraph) →
   `relay_scrooge`, don't burn a crew seat or your own window.
5. Record lessons as you diagnose (`relay_lesson(text, scope)` — global or per-agent quirks);
   they auto-inject into every future crew's prompts.

## Phase 5 — verification gate + integration
Card flow is `todo → doing → testing → done`; `testing` runs the project's tests/typecheck;
`done` only green; `failed` (+ bus report) pulses red on the board until you bounce it.
Enforce the gate — bounce anything that skipped it (bounces are visible: "↩ bounced" on the
card, history in its tooltip). When all report done: integrate, fix contract mismatches
YOURSELF, move your card through testing → done, broadcast "🚀 <thing> is live", and when the
user is finished: `bash .../crew.sh down`.

## Rules
- Coordinate ONLY over the bus; messages <280 chars; the dashboard lanes are the user's view.
- Never edit a crew member's file unless integration is broken AND they're dead/silent.
- Trust the verifier, the sweep, and the gate — not assumptions or optimistic reports.
- If a CLI fails (auth/model/quota), tell the user plainly and continue with the rest.
- Telemetry for cost reporting lands in `~/.agent-bus/logs/` automatically; the dashboard's
  🪙 pill shows live Scrooge spend/savings.
