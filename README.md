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
Claude Code, Codex, GLM, Kimi, DeepSeek — or *any model you bring* — in their own terminal
windows, routed by your actual plans, supervised on a live + historical board you can scroll
back through, learning from every failure.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Agents](https://img.shields.io/badge/crew-Claude%20%C2%B7%20Codex%20%C2%B7%20GLM%20%C2%B7%20Kimi%20%C2%B7%20DeepSeek%20%C2%B7%20%2BBYOM-D97757)
![Tests](https://img.shields.io/badge/tests-passing-2DD4BF)

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

**Kimi Code CLI as orchestrator** (same capabilities — the `relay_*` MCP tools, the crew/handoff/
research skills, and the full hook set: session registration, focus cards, todo mirroring,
heartbeats, inbox delivery, handoff/baton pass, sub-agent cards):

1. Register the relay MCP server in `~/.kimi-code/mcp.json`:

   ```json
   {
     "mcpServers": {
       "relay": {
         "command": "node",
         "args": ["<absolute-path-to-trantor>/mcp.mjs"],
         "env": { "RELAY_AGENT": "kimi-orch" },
         "startupTimeoutMs": 15000,
         "toolTimeoutMs": 150000
       }
     }
   }
   ```

2. In the Kimi TUI: `/plugins install <absolute-path-to-trantor>` (or the GitHub URL), then
   `/reload`, then start a new session.

Since 0.17.76 the Kimi hooks are a **dialect bridge**, not a fork: `kimi/bridge.mjs` runs the
canonical hooks as children and translates Kimi's input/output conventions at the edges
(SessionStart context is stashed and delivered on the first prompt). Kimi hooks therefore sign
their hub calls, follow per-project hub pins, and inherit every future hook fix automatically.
Do **not** set `RELAY_URL` in MCP configs — a hardcoded URL overrides the per-project pin and
splits the project across hubs; the pin decides the hub.

Notes: Kimi plugin installs are **snapshots** (`~/.kimi-code/plugins/managed/trantor/`) — after
updating trantor, re-run `/plugins install` to refresh the skills/hooks. The MCP entry above always
runs your live checkout, so the relay server itself never goes stale. Invoke the skills with
`/skill:crew`, `/skill:handoff`, `/skill:research`. Set `TRANTOR_DEBUG_HOOKS=1` on the `kimi`
process to dump raw hook payloads to `~/.agent-bus/kimi-hook-debug.jsonl`.

The orchestrator's bus identity is `kimi-orch:<project>` — deliberately distinct from `kimi:<project>`,
which belongs to a kimi CREW SEAT (`trantor up kimi`). Same doctrine as the openrouter seat label:
one bus peer per role, so an orchestrator and its own kimi seat never share a heartbeat, inbox, or
card attribution.

That's it. (Prefer source? `git clone https://github.com/sashabogi/trantor && cd trantor &&
npm install && bash deploy/setup.sh` — identical result.)

**Recommended companion (macOS):** [**cmux**](https://cmux.com) — `brew install --cask cmux` — a
native terminal built for running multiple AI agents. Trantor groups each crew into one cmux workspace
with live per-seat status in the sidebar and project-scoped teardown. See
*[Grouped crews in cmux](#grouped-crews-in-cmux-recommended)*. Optional — crews also run in tmux or plain
Terminal windows.

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
your code or keys; it doesn't touch other CLIs' credentials — Codex, Kimi, DeepSeek, GLM (and any
provider you bring) are ones *you* already installed and signed into, and Trantor just coordinates
them locally. The optional API keys in `~/.agent-bus/.env` are used only to call the models *you*
opted into for routing.

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
crew runners source it automatically, and it wins over anything Scrooge has.

That precedence is the point. Scrooge (the cheap-model router) keeps its own keys in
`~/.token-scrooge/.env`, and if the crew has no key of its own it falls through to Scrooge's. That
still works, but then one key authenticates both and your provider bill cannot tell them apart —
a crew seat and a batch of grunt summaries land on the same line item. Give the crew **separate
keys**, minted in the provider console rather than copied, and each shows up on its own line and
can be capped independently. `trantor doctor` reports which key each surface resolves to, masked,
under "provider keys".

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
2. **Windows open.** `trantor up codex kimi deepseek:deepseek glm:zai-coding-plan` spawns the crew in
   visible terminals — grouped into **one [cmux](https://cmux.com) workspace per project** when cmux is
   installed (seats tiled, live status in the sidebar; see *[Grouped crews in cmux](#grouped-crews-in-cmux-recommended)*
   below), else tmux, else one titled Terminal window per seat. The seats aren't a fixed list — they're **whatever you've got**:
   the native CLIs (Codex, Kimi) plus *any* provider wired through OpenCode (DeepSeek, GLM, and
   **OpenRouter's hundreds of models, or a custom endpoint you bring** — see *Bring your own
   model* below). `agent:model` pins a model; `agent:provider --difficulty hard` picks the
   **best live model** for the work at spawn (capability × cost), enumerated from the provider
   itself — never a guessed endpoint. **Serialized and then verified on the bus** — the launcher
   ends with "crew verified" or names the no-shows loudly. The orchestrator never gets a green lie.
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

### Grouped crews in cmux (recommended)

Trantor runs crews in visible terminals so nothing dies or fails silently. On macOS it prefers
**[cmux](https://cmux.com)** — a native, Ghostty-based terminal *built for managing multiple AI coding
agents* — and falls back to **tmux**, then plain Terminal windows.

With cmux, each crew becomes **one workspace tab per project**, its seats tiled inside, every pane
labeled `<agent> · <project>`, and each seat pushes its **live state into cmux's sidebar** —
`building` (blue) while a turn runs, `idle` when it's waiting, `error`/`down` (red) on a failed turn —
plus a per-crew progress pill. Teardown is **project-scoped**: `trantor down` closes only *this*
project's workspace, so when you run several sessions each driving its own crew, one session's teardown
can't nuke another's. `trantor down <agent>` drops a single seat; `trantor down --all --yes` tears down
every project's crew.

Since 0.18.20, **seat trouble wakes the foreman instead of hoping someone looks**: a failing or
dead seat direct-messages the project's orchestrator (broadcasts wake nobody), a detached
watchdog reports a turn running silent past 15 minutes — once, without killing it — and the
failure classifier tells a provider backend error ("retry or swap") from real quota exhaustion
("wait the window out"). The duty seat itself now runs under a launchd keepalive, so the fleet's
janitor relaunches after a crash or reboot instead of dying silently, and the hub routes
escalations back to their senders whenever the janitor goes dark.

**One-time setup:**
- Install cmux — `brew install --cask cmux` (or grab it from **[cmux.com](https://cmux.com)**).
- Trantor drives cmux over its control socket, which is off to outside processes by default. Enable it in
  `~/.config/cmux/cmux.json` (cmux auto-reloads):
  ```json
  { "automation": { "socketControlMode": "allowAll" } }
  ```
  This lets local processes drive your terminals. Leave it on the default `cmuxOnly` and Trantor
  automatically falls back to AppleScript (same grouped layout, minus the native sidebar status).
- The `cmux` CLI is symlinked onto your PATH on your first `trantor up`.

No cmux or tmux? Crews still work — one titled Terminal window per seat, still project-scoped teardown.

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

## The board keeps itself honest

Cards carry their **story on the card**: every `note` lands in a permanent per-card log (last 40
entries) that survives restarts, retention, and id remaps — the drawer shows it as the card's
narrative, so clicking an old card tells you what actually happened, not a one-line status trail.
The `todo` lane has a lifecycle: cards untouched for 14 days (`RELAY_TODO_STALE_MS`) move to
STALE with an "aged out" note instead of rotting silently, and todo tiles wear an age badge from
day 7. A commit closes the session's focus card and the two link both ways. `trantor doctor`
cross-checks every hub you know about against the per-project pins and reports any **split-brain**
(a project live on two hubs) with the exact fix — and `trantor adopt <project>` migrates a project
between hubs in one verified step, telling stale sessions to restart.

Crew output is gated mechanically, too: `bin/slop-gate.mjs` runs the vendored
[anti-slop](https://github.com/dmmulroy/anti-slop) Oxlint rules over an agent's **changed files
only** — unexplained type assertions, `unknown` laundering, runtime `typeof`, Reflect tricks and
friends fail the card before it can reach done, while legacy debt burns down on its own card
instead of blocking everyone. A surface that has paid its debt off stays paid: `desktop/src` is at
zero and `npm test` now lints it in full (`node bin/slop-gate.mjs --surface desktop/src`).

## The brain — plan-aware economics

Trantor's economics engine ([Scrooge](https://github.com/sashabogi/token-scrooge) — installed
automatically by `trantor setup`) knows model capabilities, per-1M costs, and keeps the
ledger; Trantor turns that into decisions:

- **Declare your plans once:** `trantor profile set claude=max codex=plus zai=coding-plan kimi=coding-plan deepseek=api`
- The Advisor routes by **your economics**: API-billed orchestrator → offload everything;
  $20-tier plan → the crew *is* the only way a real build fits; max-tier → context horizon
  decides. **Quota pooling**: one build spread across your separate subscription buckets —
  measured example: a five-vendor 3D game build, API-equivalent $200–600, **actual spend $2.29**.
- **Fractal delegation** (`relay_scrooge`): the architect *and* crew members push stateless
  grunt work to cheap models, with ledger receipts.

## Bring your own model (BYOM)

The crew roster isn't a hardcoded list — it's **derived from what you've configured**. Trantor
ships built-in seats for Codex and Kimi (native CLIs) and DeepSeek + GLM (via OpenCode), but
**any** provider OpenCode can reach becomes a first-class seat with its own identity on the
board — no code change, no waiting for us to add it.

- **OpenRouter is the on-ramp.** One key fronts **hundreds of models** (incl. vendors that have
  no CLI of their own). Drop `OPENROUTER_API_KEY` in `~/.agent-bus/.env` and `openrouter` is a
  seat: `trantor up openrouter` live-selects the best model for the work, or
  `trantor up openrouter:openrouter/<vendor>/<model>` pins one.
- **Add any provider in one command:**
  ```bash
  trantor provider add <name> --key sk-… --plan api          # a provider OpenCode already knows
  trantor provider add acme --key sk-… --base-url https://api.acme.ai/v1 --models acme-lg,acme-sm
  ```
  The second form wires a **custom OpenAI-compatible endpoint** into OpenCode for you (no
  hand-editing config). Then `trantor provider` lists every seat with its availability + tier, and
  `trantor models [<provider>]` browses the live models behind a seat — including the router's pick
  per difficulty so you can see *hard → strong, easy → cheap* at a glance.
- **It routes by difficulty, not just price.** `scrooge-capabilities` scores a provider's whole
  catalog (real Artificial-Analysis benchmarks where a model matches, a price-tier proxy for the
  long tail) and the router weighs **capability × cost, gated by the work's difficulty** — so hard
  work escalates to a genuinely strong model while easy work stays cheap. Run it once (a weekly
  cron keeps it fresh): `scrooge-capabilities`.
- **Every seat is its own colleague.** Each opencode-driven provider gets a distinct bus label
  (`glm:<project>`, `openrouter:<project>`, `acme:<project>`), so they never collide and each shows
  up as its own agent on the dashboard.

> Brought a key for Inception, a new Japanese model, a niche fine-tune? `trantor provider add` it,
> `scrooge-capabilities` scores it, and the Advisor routes to it by difficulty — same as the
> built-ins.

## Context handoff — sessions that never hit the wall

A PreCompact hook writes a rich handoff before Claude Code compacts; a fresh session in the
same project **takes over with a brand-new full context window**. Works manually from any
agent via `relay_handoff`. Optional macOS auto-prompt (`autoHandoffPrompt` in
`~/.agent-bus/config.json`) offers to open the fresh session for you, with a timeout.

Since 0.18.18 the succession is a machine, not a ritual: at 90% context the running agent is
told to finish or checkpoint and author the boundary handoff itself; the app's banner counts
down ("handing off in 10s") when the dial allows; an automatic digest defers to a fresh
model-authored handoff instead of superseding it; the successor is injected a capped ≤4KB recap
(the verbatim tail stays on disk, one path away) and gets a kickoff prompt so it recaps without
being spoken to; and a session hosted in a Workspace pane is replaced in place by a detached
driver — the same chain the app's [Hand off now] button runs.

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
| `relay_task_add(title, …, difficulty, model, deps, note?, project?)` | Cards with difficulty/model badges + DAG edges; `note` seeds the card's **permanent log**; `project` targets another board when you orchestrate from elsewhere |
| `relay_task_move(id, status, note?)` | `todo → doing → testing → done` (the gate), `failed`, `blocked` — moves to testing/done should carry a `note`: what you did + the evidence, stored on the card forever |
| `relay_task_check(id, index, done?)` | Tick one acceptance item on a card's checklist (seeded via `relay_task_add`'s `checklist`) — checked/total is the card's one honest progress denominator |
| `relay_board` | The project's full board, as text |
| `relay_scrooge(prompt, task?, difficulty?)` | Fractal cheap-model delegation, with the ledger receipt |
| `relay_lesson(text, scope?)` | Record a failure lesson — auto-injected into all future crews |
| `relay_handoff(summary)` | Full-window session succession |

## The CLI

```
trantor setup | doctor | connect | profile | provider | models
        | up <agents…> | swap <old> <new> | down | seat-why <agent> | ui | advise | hub | watch
        | adopt <project> | reconcile | duty | orchestrate | patrol | app | backfill | init-hooks
```

- **`trantor provider`** — `list` every crew seat (built-in + brought) with availability + tier ·
  `add <name> --key … [--plan api] [--base-url <url> --models a,b]` to bring any provider (custom
  endpoints are wired into OpenCode for you) · `remove <name>`.
- **`trantor models [<provider>]`** — browse the live models behind each seat + the router's pick
  per difficulty.
- **`trantor up`** — `agent:model` pins a model (`deepseek:deepseek-v4-pro`); `agent:provider
  --task <k> --difficulty <d>` picks the **best live model** for the work at spawn
  (`glm:zai-coding-plan --difficulty hard`); spawns are verified on the bus with one retry;
  geometry auto-detects the screen you're working on (`CREW_RECT="X,Y,W,H"` to override).
- **`trantor swap <oldAgent> <newSpec>`** replaces an exhausted agent with a live-selected one.
- **`trantor seat-why <agent> [--json]`** — WHY a seat is down, from evidence (the err file first,
  then logs, tracked panes, live pids): `live`, `dead-quota`, `dead-auth`, `dead-crash`,
  `no-runner`, or `no-pane`, each with the advice that actually fits. A quota-dead seat is
  indistinguishable from a broken bus until you read the err file — this reads it for you.
- **`trantor down`** kills crew processes via their ttys and closes windows without macOS
  "Terminate?" dialogs.

## Works with any MCP agent

Claude Code, Codex CLI, Kimi Code CLI, **DeepSeek Harness (`dsh`)**, and **OpenCode** (the
universal adapter — DeepSeek, GLM, OpenRouter, and any provider you bring) are wired by
`trantor connect` automatically (idempotent, backed-up, never overwrites your customizations).
For `dsh`, connect builds a full profile (`~/.dsh/profiles/trantor`): DeepSeek's own Claude Code
hooks bridge running the trantor hooks, plus their MCP client running the relay server — then
`trantor up dsh` runs it as a crew seat (fresh session per turn; uses `DEEPSEEK_API_KEY`). Anything else that speaks MCP: point it at
`mcp.mjs` with `RELAY_AGENT=<brand>` — loading the server auto-registers the session, so presence
works before the model says a word.

*(Gemini CLI: Google retired the free seat in 2026, so it's no longer a default crew seat —
GLM via OpenCode is its replacement. Gemini still works as a Scrooge cheap-model via
`GEMINI_API_KEY`, and a paid-key holder can still run `trantor up gemini`.)*

## How it works

```
 Claude (architect/plugin)   codex ─ runner   kimi ─ runner   opencode ─ runner (DeepSeek·GLM·OpenRouter·BYOM)
        │ advise/contracts        │ one turn, exit; runner long-polls (free) + resumes with context
        └───────────┬─────────────┴──────────────┴───────────────────────────────────┘
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
npm test    # unit + 120+ protocol-level scenario drills + capability-routing, all with mock agents
            # (no LLMs, seconds, $0): honest presence + TTL prune, spawn no-shows, the testing gate,
            # bounce trails, lessons, /history + backfill, /learning shape, /todos sync, /card detail,
            # advisor decisions across plan tiers, BYOM roster derivation + brought-provider routing,
            # difficulty-aware model selection, deps validation, virgin-machine doctor, failure drills
```

## License

[MIT](./LICENSE) © 2026 Sasha Bogojevic · Built with [Claude Code](https://claude.com/claude-code) ·
Brain by [Scrooge](https://github.com/sashabogi/token-scrooge)
