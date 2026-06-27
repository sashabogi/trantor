---
name: crew
description: Orchestrate a multi-agent build with Trantor — get an Advisor recommendation (solo/scrooge/crew/hybrid based on the user's plans and the work), fire up helper AI CLIs (Codex, GLM, Kimi, DeepSeek) with pinned models in visible terminal windows, assign difficulty-tagged work over the bus, track it on the Kanban dashboard with a testing gate, delegate grunt to Scrooge, supervise actively, integrate, ship. Use when the user wants several AI agents building something together, says "fire up the crew/agents", "build it with trantor / with the crew", or asks to coordinate other coding CLIs on a task.
---

# Trantor crew — the unified playbook (brain × body)

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
economics (quota profile) × context horizon and returns mode + per-package routing — each
route carries a `reason`, and `crew.why` explains the SEAT COUNT (seats follow the work,
not the install list). Mark packages you'll own yourself with `owner:"self"` (foundation/
integration are auto-reserved). **Never present a bare go/no-go.** In your TEXT REPLY (not
inside a question dialog), paste verbatim: `routing_table_md`, the `why` bullets, `crew.why`,
and the real-money total + quota pools. ONLY THEN ask go / adjust / hold. When creating the
board, use `card_args` exactly — each entry is a ready `relay_task_add` call (title,
difficulty, assignee with your project substituted, model). Cards without their model set
are a defect. If the profile is unset, say so and suggest `trantor profile set …`.

## Phase 0 — plan (if the user wants a plan first)
PRD.md + TDD.md. The TDD MUST define one file-set per agent (no merge conflicts) and an
explicit EVENT/INTERFACE CONTRACT — cross-agent bugs come from contract drift.

## Phase 1 — board setup
1. `relay_project_brief("<what + why + goal>")`
2. One card per package: `relay_task_add(title, assignee, difficulty, model)` — set `model`
   to the advisor-routed model (or the CLI's default name); difficulty + model show as badges
   on the card. Assignees: `codex:<project>` etc. Keep one for yourself.
3. Open the dashboard: `trantor ui` (or `open -na "Google Chrome" --args --new-window <hub-url>`)

## Phase 2 — fire up the crew (with the Advisor's models)
**Each crew card from `relay_advise` carries a `launch` spec — run it VERBATIM; never invent a
CLI invocation or run an agent "in a terminal" yourself.** Spawn every seat in one call:
`trantor up <launch> <launch> … --task <kind> --difficulty <diff>`. The live roster + the
EXACT launch spec per provider (do not improvise these):

| seat | launch spec | notes |
|---|---|---|
| Codex | `codex` (or `codex:gpt-5.5` to pin) | OpenAI CLI |
| Kimi | `kimi` | Moonshot coding-plan |
| DeepSeek | `deepseek:deepseek` | runs via opencode; `deepseek` alone = CLI default |
| **GLM (Z.ai)** | **`glm:zai-coding-plan`** | **runs via opencode, NOT a bare `glm`/`zai` terminal command.** `glm:zai-coding-plan/glm-5.2` pins a model; `glm:zai-coding-plan` live-selects. (Legacy `opencode:zai-coding-plan` still works.) |
| **OpenRouter (BYOM)** | **`openrouter`** | **the bring-your-own-model on-ramp — one key fronts hundreds of vendors (incl. ones with no CLI).** Bare `openrouter` live-selects the best OpenRouter model for the difficulty; pin one with `openrouter:openrouter/<vendor>/<model>`. Its own bus identity `openrouter:<project>` (never collides with the GLM `opencode` seat). |

`agent:provider` live-selects the best model now; `agent:provider/model` pins one. Example:
`trantor up codex kimi deepseek:deepseek glm:zai-coding-plan --task code --difficulty hard`.
**Whatever the advisor's `launch` field says, run that verbatim** — the roster above is just the
built-in menu, but the advisor picks the right seats/specs for THIS work (a user who's only brought
an OpenRouter key gets `openrouter` for everything; one who brought five providers gets a
load-balanced spread). **BYOM is fully general:** the roster is DERIVED, not hardcoded — ANY
opencode-supported provider the user configures becomes a seat with its own bus label, no code
change. A user adds one with `trantor provider add <name> --key … --plan api` (then
`scrooge-capabilities` to score it for difficulty routing); `trantor provider` lists all seats and
`trantor models [<provider>]` browses the live models + the router's pick per difficulty. If the
advisor routes to a brought provider you don't recognize, that's expected — run its `launch` spec.

⚠️ **Gemini CLI is RETIRED (Google killed the free seat 2026-06-18).** The advisor no longer
offers it and you must NOT fire up `gemini` — `gemini --yolo` exits 1 and crash-loops on the
bus. Its replacement seat is **GLM via `glm:zai-coding-plan`**. (Gemini still serves as a
Scrooge cheap-model via `GEMINI_API_KEY` — that's a separate, working path, not a crew seat.)
Only a holder of a paid Gemini enterprise key should ever `trantor up gemini`.

(If `trantor` isn't on PATH, the same launcher is `bash <plugin-root>/bin/crew.sh up …`.)
The launcher auto-wires configs, spawns serialized runner windows, then **VERIFIES each agent
on the bus with one retry**. READ ITS OUTPUT: it ends "crew verified" or "✗✗ CREW INCOMPLETE"
naming no-shows. **Never assign work to an unverified agent.** The bus is the truth. If a seat
fails to verify, run `trantor doctor` — it shows each CLI's wired/auth state and the exact fix.

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
   doing · dead agent → `trantor up <agent>` (re-verifies) + resend contract · silent-but-alive
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
user is finished: `trantor down`.

## Rules
- Coordinate ONLY over the bus; messages <280 chars; the dashboard lanes are the user's view.
- Never edit a crew member's file unless integration is broken AND they're dead/silent.
- Trust the verifier, the sweep, and the gate — not assumptions or optimistic reports.
- If a CLI fails (auth/model/quota), tell the user plainly and continue with the rest.
- Telemetry for cost reporting lands in `~/.agent-bus/logs/` automatically; the dashboard's
  🪙 pill shows live Scrooge spend/savings.
