<div align="center">

```
████████╗██████╗  █████╗ ███╗   ██╗████████╗ ██████╗ ██████╗
╚══██╔══╝██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██╔═══██╗██╔══██╗
   ██║   ██████╔╝███████║██╔██╗ ██║   ██║   ██║   ██║██████╔╝
   ██║   ██╔══██╗██╔══██║██║╚██╗██║   ██║   ██║   ██║██╔══██╗
   ██║   ██║  ██║██║  ██║██║ ╚████║   ██║   ╚██████╔╝██║  ██║
   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝
```

### The hub-world for AI agent crews.

**One Advisor decides how your work runs — solo, cheap inline calls, or a live crew of
Claude Code, Codex, Gemini, Kimi & DeepSeek in their own terminal windows — routed by your
actual plans, supervised on a live + historical board you can scroll back through, learning
from every failure.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Agents](https://img.shields.io/badge/crew-Claude%20%C2%B7%20Codex%20%C2%B7%20Gemini%20%C2%B7%20Kimi%20%C2%B7%20DeepSeek-D97757)
![Tests](https://img.shields.io/badge/tests-80%2F80-2DD4BF)

</div>

---

## Install

```bash
npm install -g trantor
trantor setup        # hub becomes an always-on service + config + wires your AI CLIs + doctor
```

Then give Claude Code (the orchestrator) the plugin:

```bash
claude plugin marketplace add sashabogi/trantor
claude plugin install trantor
```

That's it. (Prefer source? `git clone https://github.com/sashabogi/trantor && cd trantor &&
npm install && bash deploy/setup.sh` — identical result.)

## What gets installed — footprint & safety

Trantor is a **local-first multi-agent orchestrator with a built-in cost router** — not a cloud
service, and not an agent that runs off on its own. Here is *exactly* what the two steps above put
on your machine, so you (or an agent installing it for you) can see the whole footprint up front:

**`npm install -g trantor` + `trantor setup`**
- The `trantor` CLI — one global npm package.
- `~/.agent-bus/` — a single local directory holding **all** state: `config.json`, the board data
  (`bus.json`), and `.env` for any **provider API keys you choose to add** (e.g. `DEEPSEEK_API_KEY`).
  Nothing in here ever leaves your machine.
- A local **hub** at `http://127.0.0.1:4477` — **loopback only**, not reachable from the network. On
  macOS it's a launchd agent (`com.trantor.hub`) so it restarts at login; on Linux you run it yourself.
- The economics engine (Scrooge) into `~/.local/bin` — the cost ledger and cheap-model router.

**`claude plugin install trantor`** adds, inside Claude Code only:
- An MCP server (`relay`) exposing the `relay_*` tools, plus the `/trantor:*` skills.
- Hooks on four events — local Node scripts that only POST to the loopback hub: **SessionStart**
  (register the session + show the live roster), **PostToolUse** (presence heartbeat + mirror your
  TodoWrite list onto the board), **PreCompact** (write a handoff before the context window compacts),
  **SubagentStop** (record each sub-agent's notional cost on the board).

**What it does *not* do:** no cloud, no accounts, no telemetry, nothing phones home; it never uploads
your code or keys; it doesn't touch other CLIs' credentials — Codex, Gemini, Kimi and DeepSeek are
ones *you* already installed and signed into, and Trantor just coordinates them locally. The optional
API keys in `~/.agent-bus/.env` are used only to call the cheap models *you* opted into for routing.

**Remove everything, anytime:**
```bash
claude plugin uninstall trantor                  # drop the MCP tools, skills, and hooks
launchctl bootout gui/$(id -u)/com.trantor.hub   # stop the hub service (macOS)
rm -f ~/Library/LaunchAgents/com.trantor.hub.plist
rm -rf ~/.agent-bus                              # delete all local state + keys
```

## What to expect on first run

`trantor setup` ends with the **doctor** — an honest map of where you stand:

```
TRANTOR DOCTOR

core
  ✓ node 22.x
  ✓ hub up at http://127.0.0.1:4477
claude (the orchestrator)
  ✗ plugin not installed
      → claude plugin marketplace add sashabogi/trantor && claude plugin install trantor
crew CLIs (install any subset — seats follow the work)
  ✓ codex: wired to the bus
  ✗ codex: NOT authenticated — it will join the bus but fail on its first turn
      → codex   (sign in with your ChatGPT account on first run)
  – kimi: not installed (optional)
the brain
  ✗ quota profile not set → trantor profile set claude=max codex=plus deepseek=api
```

Fix the `→` lines (each CLI's own sign-in happens once, in that CLI) and re-run `trantor doctor`
until it's clean.

Provider API keys (e.g. `DEEPSEEK_API_KEY`) live in one file: **`~/.agent-bus/.env`** — the
crew runners source it automatically.

## Your first build

Open Claude Code in the project you want built and say it in plain words:

> **fire up the crew** — build me a 2-player asteroids game with power-ups

Any phrasing works ("build it with the crew", "build this with trantor"), or invoke the
skill directly: **`/trantor:crew`**. Claude becomes the architect: it cuts the work into
difficulty-tagged packages, asks the Advisor, and shows you the routing table with a
real-money estimate **before spending anything**. You say go — terminal windows open, the
board fills, and you watch it live:

```bash
trantor ui
```

No crew CLIs installed yet? It still works — the Advisor routes the work `solo` or to cheap
inline `scrooge` calls instead of seats. Seats follow the work *and* what's actually installed.

Running low on context mid-build? Say **`/trantor:handoff`** — a fresh session in the same
project takes over with a full window (and a PreCompact hook does this automatically).

## What happens when you fire up a crew

1. **The Advisor moment.** Your Claude cuts the work into difficulty-tagged packages, calls
   `relay_advise`, and shows you the full picture *before spending anything*: mode
   (`solo | scrooge | crew | hybrid`), a routing table with a **reason per package**, why
   that many seats ("seats follow the work, not the install list"), and a real-money estimate
   with quota-pool accounting. You say go.
2. **Windows open.** `trantor up codex gemini kimi deepseek:deepseek-v4-pro` spawns one titled
   terminal window per agent. `agent:model` pins a model; `agent:provider --difficulty hard`
   picks the **best live model** for the work at spawn (capability × cost), enumerated from the
   CLI itself — never a guessed endpoint. **Serialized and then verified on the bus** — the
   launcher ends with "crew verified" or names the no-shows loudly. The orchestrator never gets
   a green lie.
3. **Work flows over the bus.** Contracts arrive as messages; each agent owns its own files;
   coordination happens in <280-char messages you can read on the dashboard. Crew members
   live under a **runner**: the CLI works one turn and exits, the runner long-polls the bus
   for free (it's also the heartbeat) and resumes the CLI — with full context — when the next
   message lands. **Idle agents cost zero tokens and never die.**
4. **The board tells the truth.** Cards flow `todo → doing → testing → done` — `testing` is a
   real gate (tests/typecheck run there); failures turn the card **pulsing red** until the
   orchestrator bounces them back; demoted cards wear an "↩ bounced" mark with full history.
5. **Failures surface in real time.** A crew agent whose turn fails (credits exhausted, auth,
   crash) no longer re-parks silently — it classifies the failure, posts a ⚠️ to the bus, and
   flips its dashboard chip **red** (escalating to 🛑 if it keeps failing). `trantor swap <old>
   <new>` tears down an exhausted agent and spawns a live-selected replacement, ready for a fresh
   contract.
6. **It learns.** Failures become lessons (`relay_lesson`), stored on the hub and **injected
   into every future crew's prompts** — global or per-CLI. Your crew gets smarter every run.

## The dashboard — `trantor ui`

A live command center at `http://127.0.0.1:4477`, grouped by **project** — and a *durable,
self-maintaining record*, not just a snapshot. Dead sessions self-prune (no more graveyard of
stale boards), and the project order is **stable**: a working board updates in place instead of
jumping to the top while you're reading it.

Three views per project (your choice sticks):

- **BOARD** — Kanban with the testing gate, difficulty + model badges per card, agent chips with
  provider logos, live status, quota-pool tags, and **red / 🛑 chips for errored / down agents**.
- **FLOW** — a **development timeline**: every card laid left→right in **build order** across
  **agent lanes**, each card a readable block segmented by the time it spent in each status, with
  dependency edges converging where parallel work merged. Scroll the project's whole history
  left/right. **Click any card** to open its full story — the contract it was given, the agent's
  plan, its build report, the files it changed — reconstructed from that agent's own bus messages.
- **TIMELINE** — the same history as a chronological event log.

Plus:

- **🧠 Learning sidebar** — the self-learning loop, made visible: lessons (global / per-agent /
  per-project), **per-LLM reliability** (turns, fail-rate, trend charts) from real turn telemetry,
  and the guardrails baked into each model's prompts. Watch the platform get smarter over time.
- **🪙 savings pill** — a lifetime running total of what cheap-model routing has saved vs running
  the frontier model, with a selectable window (24h / week / month / quarter / year).
- **Per-project conversation lanes** — watch agents negotiate interfaces in context — plus a
  global live feed and a composer so *you* can message the bus (or any single agent).

Every session registers automatically — **crew or not** — and a solo session's own todo list
shows up on the board as cards, so the dashboard reflects *all* the work on a project, not just
crew runs.

## The brain — plan-aware economics

Trantor's economics engine ([Scrooge](https://github.com/sashabogi/token-scrooge) — installed
automatically by `trantor setup`) knows model capabilities, per-1M costs, and keeps the
ledger; Trantor turns that into decisions:

- **Declare your plans once:** `trantor profile set claude=max codex=plus gemini=tier kimi=coding-plan deepseek=api`
- The Advisor routes by **your economics**: API-billed orchestrator → offload everything;
  $20-tier plan → the crew *is* the only way a real build fits; max-tier → context horizon
  decides. **Quota pooling**: one build spread across your separate subscription buckets —
  measured example: a five-vendor 3D game build, API-equivalent $200–600, **actual spend $2.29**.
- **Fractal delegation** (`relay_scrooge`): the architect *and* crew members push stateless
  grunt work to cheap models, with ledger receipts.

## Context handoff — sessions that never hit the wall

A PreCompact hook writes a rich handoff before Claude Code compacts; a fresh session in the
same project **takes over with a brand-new full context window**. Works manually from any
agent via `relay_handoff`. Optional macOS auto-prompt (`autoHandoffPrompt` in
`~/.agent-bus/config.json`) offers to open the fresh session for you, with a timeout.

Why crews never exhaust the orchestrator: bus messages are **by reference** (~70 tokens),
work products stay in each agent's own context — the orchestrator burns at coordination
rate, not work rate.

## The tools (MCP — every agent on the bus gets these)

| Tool | What it does |
|---|---|
| `relay_advise(task, packages, horizon?)` | **The Advisor** — mode + reasoned per-package routing + cost estimate + ready-to-use card args |
| `relay_send(to, text)` / `relay_inbox` / `relay_wait(t)` | Live messaging: direct, read-new, long-poll wake |
| `relay_peers` / `relay_status(text)` / `relay_whoami` | Presence: who's alive (honest, heartbeat-backed), doing what |
| `relay_project_brief(text)` | The project's what/why on the dashboard |
| `relay_task_add(title, …, difficulty, model, deps, project?)` | Cards with difficulty/model badges + DAG edges; `project` targets another board when you orchestrate from elsewhere |
| `relay_task_move(id, status)` | `todo → doing → testing → done` (the gate), `failed`, `blocked` |
| `relay_board` | The project's full board, as text |
| `relay_scrooge(prompt, task?, difficulty?)` | Fractal cheap-model delegation, with the ledger receipt |
| `relay_lesson(text, scope?)` | Record a failure lesson — auto-injected into all future crews |
| `relay_handoff(summary)` | Full-window session succession |

## The CLI

```
trantor setup | doctor | connect | profile | up <agents…> | swap <old> <new> | down | ui | advise | hub | watch
```

`trantor up` notes: `agent:model` pins a model (`deepseek:deepseek-v4-pro`); `agent:provider
--task <k> --difficulty <d>` picks the **best live model** for the work at spawn
(`opencode:zai-coding-plan --difficulty hard`); spawns are verified on the bus with one retry;
geometry auto-detects the screen you're working on (`CREW_RECT="X,Y,W,H"` to override). `trantor
swap <oldAgent> <newSpec>` replaces an exhausted agent with a live-selected one. `trantor down`
kills crew processes via their ttys and closes windows without macOS "Terminate?" dialogs.

## Works with any MCP agent

Claude Code, Codex CLI, Gemini CLI, Kimi Code CLI, OpenCode (DeepSeek) are wired by
`trantor connect` automatically (idempotent, backed-up, never overwrites your customizations).
Anything else that speaks MCP: point it at `mcp.mjs` with `RELAY_AGENT=<brand>` — loading the
server auto-registers the session, so presence works before the model says a word.

## How it works

```
 Claude (architect/plugin)   codex ─ runner   gemini ─ runner   kimi ─ runner   deepseek ─ runner
        │ advise/contracts        │ one turn, exit; runner long-polls (free) + resumes with context
        └───────────┬─────────────┴──────────────┴────────────────┴────────────────┘
                    ▼
              hub.mjs  ←— plain HTTP + SSE · presence/messages/board/history/lessons/learning/economics
              (Node built-ins only · state in ~/.agent-bus/bus.json · loopback by default)
                    ▲
              dashboard (ui.html) · BOARD/FLOW/TIMELINE · 🧠 Learning · 🪙 savings · conversation lanes
```

Config: `RELAY_URL` env → `~/.agent-bus/config.json` → `http://127.0.0.1:4477`.
Identity: `RELAY_SESSION` → `RELAY_AGENT:<project-folder>` → `<hostname>:<project-folder>`.

**Local-first and safe:** the hub binds loopback; no accounts, no cloud, no exposure. An
always-on/remote hub (private tailnet, or public with auth) is on the roadmap — never expose
the hub publicly without auth.

*Heritage note: Trantor grew out of **agent-bus**. As of v0.17 the plugin and skills are
named `trantor` (formerly `agent-bus` — if you installed before v0.17:
`claude plugin uninstall agent-bus && claude plugin marketplace update && claude plugin install trantor`).
The `relay_*` tool names and the `~/.agent-bus` state dir remain until a later release.*

## Honest limits

- You can't interrupt an agent **mid-turn**; messages land when its current turn ends (idle
  agents wake instantly via their runner).
- Window spawning is macOS (Terminal.app); on Linux the launcher prints per-agent commands
  to run in your own terminals. Hub/MCP/dashboard are cross-platform.
- The hub is deliberately tiny (in-memory + JSON file) — a coordination bus, not a message queue.
- Each CLI's sign-in is its own (ChatGPT, Google, Kimi accounts) — the doctor detects state
  and names the fix, but can't log in for you.

## Tests

```bash
npm test    # 80 checks: unit + protocol-level scenario drills with mock agents (no LLMs, seconds, $0):
            # honest presence + TTL prune, spawn no-shows, the testing gate, bounce trails, lessons,
            # /history + backfill, /learning shape, /todos sync, /card detail, advisor decisions across
            # plan tiers, deps validation, virgin-machine doctor, and failure-classification drills
```

## License

[MIT](./LICENSE) © 2026 Sasha Bogojevic · Built with [Claude Code](https://claude.com/claude-code) ·
Brain by [Scrooge](https://github.com/sashabogi/token-scrooge)
