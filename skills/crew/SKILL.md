---
name: crew
description: Orchestrate a multi-agent build over agent-bus — fire up helper AI CLIs (Codex, Gemini, Kimi, DeepSeek/OpenCode) in visible terminal windows, assign work over the bus, track it on the Kanban dashboard, integrate, ship. Use when the user wants several AI agents building something together, says "fire up the crew/agents", or asks to coordinate other coding CLIs on a task.
---

# agent-bus crew — orchestrate a multi-agent build

You are the ARCHITECT. Helper agents (any of: codex, gemini, kimi, deepseek) run in their own
terminal windows, join the bus automatically, and take instructions FROM YOU over the bus.
The user watches everything on the dashboard (the hub URL, e.g. http://127.0.0.1:4477).

## Phase 0 — plan (if the user wants a plan first)
Scope it like any feature: a couple of sharp questions, then write PRD.md and TDD.md in the
project. The TDD MUST define: one file per agent (so no merge conflicts), the shared runtime
contract, and an explicit EVENT CONTRACT (exact event names + payloads) — cross-agent bugs
come from contract drift, not bad code.

## Phase 1 — board setup
1. `relay_project_brief("<what + why + goal, one paragraph>")`
2. One Kanban card per work package via `relay_task_add(title, assignee)` — assignees are bus
   session ids: `codex:<project>`, `gemini:<project>`, `kimi:<project>`, `deepseek:<project>`
   (project = folder name). Keep one card for yourself (engine/integration).
3. Open the dashboard for the user: `open -na "Google Chrome" --args --new-window http://127.0.0.1:4477`

## Phase 2 — fire up the crew
Run (from the project dir): `bash <plugin-or-repo-root>/bin/crew.sh up codex gemini kimi deepseek`
— any subset; it auto-wires each CLI's MCP config first (connect.mjs, idempotent), opens one
titled window per agent, and each agent announces itself on the bus then parks on relay_wait(50)
loops. Wait for their "reporting" broadcasts (relay_wait) before sending work.

## Phase 3 — contracts over the bus
Build the shared foundation yourself FIRST (e.g. engine + index.html), then `relay_send` each
agent its contract. A good contract fits in 280 chars and contains: the ONE file they own, the
event-contract line verbatim, and their visual/behavioral spec. They move their own cards.

## Phase 4 — supervise and integrate
- Park on `relay_wait(280)` (you are Claude — 280 is safe for you; the crew must loop at 50).
- When an agent reports done, sanity-check its file (syntax + contract conformance).
- Nudge stragglers over the bus; check their file on disk before nudging.
- When all report: integrate, fix contract mismatches YOURSELF (don't round-trip trivia),
  move your card to done, broadcast: "🚀 <thing> is live".
- Tear down the crew windows when the user is done: `bash .../bin/crew.sh down`

## Rules
- Coordinate ONLY over the bus — the conversation lanes on the dashboard are the user's view
  into the work. Keep every message under 280 chars.
- Never edit a crew member's file unless integration is broken and they've gone quiet.
- relay_wait: crew CLIs cap tool calls (Codex ~120s, OpenCode ~60s) — they loop at 50;
  only you (Claude Code) park at 280.
- If a crew CLI fails (auth expired, model error), tell the user plainly and continue with
  the rest of the crew. Don't block the build on one agent.
