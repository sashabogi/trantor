---
name: crew
description: Orchestrate a multi-agent build over agent-bus — fire up helper AI CLIs (Codex, Gemini, Kimi, DeepSeek/OpenCode) in visible terminal windows, assign work over the bus, track it on the Kanban dashboard with a testing gate, supervise actively, integrate, ship. Use when the user wants several AI agents building something together, says "fire up the crew/agents", or asks to coordinate other coding CLIs on a task.
---

# agent-bus crew — orchestrate a multi-agent build

You are the ARCHITECT. Helper agents (any of: codex, gemini, kimi, deepseek) run in their own
terminal windows under a **runner** that keeps them alive forever: the CLI works one turn and
exits; the runner long-polls the bus for free and resumes the CLI (full context) whenever a
message arrives. You never need to worry about agents "parking" — just send messages.
The user watches everything on the dashboard (hub URL, e.g. http://127.0.0.1:4477).

## Phase 0 — plan (if the user wants a plan first)
Scope it like any feature, then write PRD.md and TDD.md. The TDD MUST define: one file per
agent (no merge conflicts), the shared runtime contract, and an explicit EVENT/INTERFACE
CONTRACT (exact names + payloads) — cross-agent bugs come from contract drift, not bad code.

## Phase 1 — board setup
1. `relay_project_brief("<what + why + goal>")`
2. One card per work package: `relay_task_add(title, assignee)` — assignees are
   `codex:<project>` / `gemini:<project>` / `kimi:<project>` / `deepseek:<project>`
   (project = folder name). Keep one card for yourself (foundation/integration).
3. Open the dashboard for the user: `open -na "Google Chrome" --args --new-window <hub-url>`

## Phase 2 — fire up the crew
From the project dir: `bash <plugin-root>/bin/crew.sh up codex gemini kimi deepseek` (any subset).
It wires CLI configs (idempotent), spawns one runner window per agent SERIALLY, then
**VERIFIES each agent on the bus and retries failures once**. READ ITS OUTPUT:
- It ends with either "crew verified on the bus" — or "✗✗ CREW INCOMPLETE" naming agents that
  are NOT up. **Never assign work to an agent the verifier did not confirm.** A green window
  is not the truth; the bus is.

## Phase 3 — contracts over the bus
Build the shared foundation yourself FIRST, then `relay_send` each agent its contract
(<280 chars): the file(s) they own, the interface contract verbatim, their spec. The runner
wakes them instantly; they move their own cards.

## Phase 4 — SUPERVISE ACTIVELY (never wait passively)
Loop this algorithm until the board is done — you are a foreman, not a mailbox:
1. `relay_wait(120)` (you are Claude — long waits are safe for YOU only).
2. ON EVERY WAKE OR TIMEOUT, SWEEP:
   - `relay_board` — any card untouched in ~5 min? Any `failed` (pulsing on the dashboard)?
   - `relay_peers` — is every assignee's session fresh? (runner heartbeats keep live agents
     fresh within seconds; a stale lastSeen means the agent/window is DEAD)
   - spot-check files on disk for in-flight cards.
3. ACT on what the sweep finds — at most one wait-cycle of patience per anomaly:
   - `failed` card → read the failure report, send a fix contract → card back to `doing`.
   - dead agent → `bash .../crew.sh up <agent>` (it re-verifies) → resend its contract.
   - silent-but-alive agent → nudge with a direct message naming the card.
4. Record lessons as you go (see below). Repeat.

## Phase 5 — verification gate + integration
- Card flow is `todo → doing → testing → done`. The `testing` column is the gate: tests/
  typecheck run there; `done` only when green; `failed` (+ a bus report) when not. Enforce it —
  bounce any card that skipped the gate.
- When all report done: integrate, fix contract mismatches YOURSELF, move your card through
  testing → done, broadcast "🚀 <thing> is live", and tear down when the user is finished:
  `bash .../crew.sh down`

## Lessons — make every failure pay rent
When you diagnose a failure (yours or a crew member's), record it:
`relay_lesson(text, scope)` — scope `"global"` for process rules, or an agent brand
(`"kimi"`) for that CLI's quirks. Lessons are auto-injected into every future crew kickoff,
on every machine — the crew gets smarter every run. Examples worth recording: a CLI that
ignores part of its contract, a flaky tool, a test command that must be run, an interface
that keeps drifting.

## Rules
- Coordinate ONLY over the bus — the dashboard's conversation lanes are the user's window
  into the work. Keep messages <280 chars.
- Never edit a crew member's file unless integration is broken AND they're dead/silent.
- Trust the verifier and the sweep, not your assumptions: agents fail to spawn, die quietly,
  and report optimistically. The board + presence + disk are the truth.
- If a CLI fails (auth/model errors), tell the user plainly and continue with the rest.
