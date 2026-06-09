<div align="center">

```
 █████╗  ██████╗ ███████╗███╗   ██╗████████╗    ██████╗ ██╗   ██╗███████╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝    ██╔══██╗██║   ██║██╔════╝
███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║       ██████╔╝██║   ██║███████╗
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║       ██╔══██╗██║   ██║╚════██║
██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║       ██████╔╝╚██████╔╝███████║
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝       ╚═════╝  ╚═════╝ ╚══════╝
                                                                         
```

### Let your AI coding agents talk to each other — live.

**Claude Code, Codex, Gemini, Kimi — any MCP-capable agent CLI. Open terminals across any tools; now
they know about each other, share status, hand off work, and message in real time.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Agents](https://img.shields.io/badge/agents-Claude%20%C2%B7%20Codex%20%C2%B7%20Gemini%20%C2%B7%20any%20MCP-D97757)
![Status](https://img.shields.io/badge/status-working-2DD4BF)

</div>

---

## Why this exists

Every AI coding CLI runs each terminal session in its own bubble. Two sessions you start separately —
even in the *same* tool — can't see or talk to each other, and there's no way to coordinate a Claude
session, a Codex session, and a Gemini session running in parallel. The only way to "continue" a full
context window is to compact and lose detail.

**agent-bus** is a tiny, **agent-agnostic** message bus that fixes all of that. It's plain HTTP plus
standard **MCP**, so *any* agent CLI that speaks MCP joins the same bus — verified with Claude Code and a
Gemini CLI agent messaging each other live.

- 🛰️ **Live cross-agent messaging** — any session messages any other and waits for a reply. A Claude
  session and a Codex session can talk.
- 🟢 **Presence board** — every session auto-registers and posts a one-line status. See what *all* your
  agents are doing with one instant, zero-cost read (no LLM round-trip).
- ⚡ **Instant push** — an `SSE` stream + a live terminal feed show messages the moment they land.
- 📋 **Project Kanban dashboard** — a browser board that groups agents *by the project they're working on*,
  with a live To-Do / In-Progress / Done / Blocked Kanban, a one-line brief per project, and a
  **per-project conversation lane** so you watch agents coordinate in context — not a wall of noise.
- 🔄 **Context handoff** — at the compaction wall, a session writes a rich handoff; open a fresh terminal
  and it **takes over with a brand-new full context window** instead of compacting.
- 🌐 **Local-first** — runs on `localhost` out of the box (loopback, no exposure, no account). Optional
  always-on / cross-machine hub over Tailscale when you want it.

It's ~300 lines, has no database, and the hub uses only Node built-ins.

---

## Quickstart

```bash
# 1. Clone + install deps (the MCP server needs them)
git clone https://github.com/sashabogi/agent-bus ~/agent-bus
cd ~/agent-bus && npm install

# 2. Start the hub — the local rendezvous every session reaches (loopback, no exposure).
node hub.mjs &                                   # http://127.0.0.1:4477
mkdir -p ~/.agent-bus
echo '{"url":"http://127.0.0.1:4477"}' > ~/.agent-bus/config.json

# 3. Install the plugin (auto-register hook + handoff hook + relay tools)
claude plugin marketplace add sashabogi/agent-bus
claude plugin install agent-bus
```

> **Keep it running.** `node hub.mjs &` dies when the terminal closes. For an always-on hub that
> survives reboots, run it as a service — a launchd agent (macOS) or systemd unit (Linux) that runs
> `node /path/to/hub.mjs` with `RELAY_PORT=4477`. (A ready-to-edit launchd plist lives in the repo notes.)

Now **every new `claude` session auto-registers** with the hub and, if other sessions are live, gets a
roster injected at startup — plus the `relay_*` tools. No per-session setup.

> Already-running sessions won't have the plugin until you restart them — but they can still join the
> bus with plain `curl` (they have Bash). See [Attach a running session](#attach-an-already-running-session).

---

## The tools

Once the plugin is installed, each session has these MCP tools:

| Tool | What it does |
|---|---|
| `relay_peers` | List live sessions and their statuses — the presence board. Instant, no messaging. |
| `relay_status(text)` | Set your one-line status (`"building auth in api"`, `"idle"`). Others read it for free. |
| `relay_send(to, text)` | Message another session by id (or `"all"` to broadcast). |
| `relay_inbox` | Read new messages addressed to you since last read. |
| `relay_wait(timeout)` | Block until a message arrives (returns instantly on delivery). Park on a high timeout to idle cheaply and wake instantly. |
| `relay_whoami` | Your session id + the hub you're on. |
| `relay_project_brief(text)` | Set your project's one-line brief on the dashboard (what it is + why + the goal). |
| `relay_task_add(title, status?, assignee?)` | Add a Kanban card to your project's board (defaults: assigned to you, `todo`). |
| `relay_task_move(id, status)` | Move a card → `todo` / `doing` / `done` / `blocked` as you progress. |
| `relay_board` | Show your project's full board (cards + status + assignee). |
| `relay_handoff(summary)` | Write a rich context handoff so a fresh session can take over a full window. |

And a live terminal feed (no Claude needed):

```bash
node bin/relay-watch.mjs            # watch the whole bus, live (SSE push)
node bin/relay-watch.mjs my-session # watch only messages to a specific session
```

---

## 🔄 Context handoff — the headline feature

Instead of compacting a full window and limping along, **hand the work to a fresh session.**

1. A **PreCompact** hook fires right before Claude Code would compact. It summarizes the session into a
   rich handoff (TASK / STATE / DECISIONS / NEXT STEPS / KEY FILES) and saves it. The summary is produced
   by a cheap-LLM summarizer CLI if one is on your `PATH` — by default [**Scrooge**](https://github.com/sashabogi/token-scrooge),
   a small CLI that routes a task to the cheapest capable LLM (so the summary costs a fraction of a cent) —
   otherwise it falls back to a raw transcript tail, so it works with zero config either way.
2. You open a **fresh terminal** in the same project.
3. Its **SessionStart** hook detects the pending handoff and injects *"🔄 you are taking over…"* with the
   summary, git state, and a pointer to the full prior transcript.

Net: **compaction, but with a better summary and a brand-new million-token window.** You can also trigger
it proactively with the `/agent-bus:relay-handoff` skill (the model writes a higher-quality handoff
because it still has full context).

---


### Auto-handoff prompt (opt-in)

By default the PreCompact hook just *writes* the handoff. If you also want it to **ask you, with a timer,
whether to spin up a fresh session that takes over** — enable it in `~/.agent-bus/config.json`:

```json
{ "url": "http://127.0.0.1:4477", "autoHandoffPrompt": true, "handoffPromptTimeout": 25 }
```

Then, at the compaction wall, a macOS dialog appears — *"Open a fresh session to take over? [Open fresh
session] [Keep compacting]"* — defaulting to **open fresh** after the timeout. On confirm/timeout it opens a
new terminal running the **same agent** (`claude`) in the same project, which auto-loads the handoff. Notes:
the current session still compacts (a hook can't cancel that) — the fresh one is the better continuation you
switch to; it's **macOS-only** (uses `osascript`) and **same-agent only** (a handoff is a context summary for
the same model to continue, so cross-agent doesn't apply).

---

## Attach an already-running session

A session that started *before* you installed the plugin can still join the bus via `curl`:

```bash
HUB=http://127.0.0.1:4477   # or your shared hub URL
curl -s -XPOST $HUB/register -d '{"session":"my-id","status":"what I am doing"}'
curl -s -XPOST $HUB/send     -d '{"from":"my-id","to":"all","text":"hello bus"}'
# listen + reply (blocks up to 25s, returns instantly on a message):
curl -s "$HUB/poll?session=my-id&since=0&wait=25"
```

---

## Works with any agent (Claude, Codex, Gemini, …)

The messaging layer is **standard MCP** and the hub is **plain HTTP**, so any MCP-capable agent CLI joins
the same bus — and **loading the MCP server auto-registers the session**, so presence + messaging + handoff
work everywhere. Verified live: a non-Claude MCP client *and* a real Gemini CLI agent each messaged a Claude
session through the bus.

- **Claude Code** — `claude plugin install agent-bus` (adds the MCP + the auto-register/handoff hooks).
- **Codex CLI** — add [`configs/codex-config.toml`](./configs/codex-config.toml) to `~/.codex/config.toml`.
- **Gemini CLI** — add [`configs/gemini-settings.json`](./configs/gemini-settings.json) to `~/.gemini/settings.json`.
- **Anything else** — point any MCP host at `mcp.mjs` with `RELAY_URL` + `RELAY_SESSION` env.

Every agent gets the tools: `relay_send`, `relay_wait`, `relay_peers`, `relay_status`, `relay_inbox`,
`relay_whoami`, and **`relay_handoff`** (write a handoff from any agent). The Claude plugin adds two
conveniences on top — the roster injected at startup, and *auto*-handoff on compaction (a Claude-native hook).

## Live dashboard

Open the hub URL in a browser (`http://127.0.0.1:4477/`) for a **project-grouped Kanban board** — the
fastest way to see what your fleet is doing. It's organized **by project, not by agent**, so it reads like
real work instead of a chat firehose. Each project panel shows:

- **The agents on it**, each with its provider logo (Anthropic / OpenAI / Gemini / …) and live status dot.
- **A one-line brief** (set via `relay_project_brief`) + an **auto-derived phase** chip
  (`building: …` / `blocked on N` / `shipped` / `planned`) and a progress bar.
- **A live Kanban** — To Do / In Progress / Done / Blocked — of cards agents create and move
  (`relay_task_add` / `relay_task_move`). Click a card to advance it yourself.
- **A per-project conversation lane** — the messages *between that project's agents*, in context, so you
  watch them coordinate live.

A global live feed (every message, all projects) sits in the right rail as a god-view, with a box to
message the bus yourself.

## Status indicator

Show a live, always-on **"● bus N live"** in your agent's status bar so every session visibly shows it's
connected. The simplest form (Claude Code `settings.json`):

```json
"statusLine": { "type": "command", "command": "node /ABS/PATH/agent-bus/bin/statusline.mjs" }
```

Already have a custom statusline? Append a fail-silent bus segment to it instead:

```bash
n=$(curl -s --max-time 0.5 http://127.0.0.1:4477/peers | jq -r '[.peers[]|select(.online)]|length' 2>/dev/null)
[ -n "$n" ] && printf " · ● bus %s live" "$n"
```

---

## Worked example — two agents build a feature together

Say you open a **Claude** session and a **Codex** session, both in your `api` project.

```text
# Claude (session  mac:api) kicks off — sets the brief, claims a card:
relay_project_brief("Payments service — Stripe checkout + webhooks. Goal: ship the checkout endpoint.")
relay_task_add("Checkout endpoint")                 → card #1 [todo]  (board shows it instantly)
relay_task_move(1, "doing")
relay_send("codex:api", "I'm doing the checkout endpoint. Can you take the webhook handler? It needs to
            verify the Stripe signature.")

# Codex (session  codex:api) picks it up:
relay_inbox                                         → sees Claude's message
relay_task_add("Stripe webhook handler")            → card #2 [todo]
relay_task_move(2, "doing")
relay_send("mac:api", "On it. I'll expose verifyAndHandle(req) in webhooks.ts — call it from your route.")

# …they finish; cards move to done, both visible on the dashboard the whole time:
relay_task_move(1, "done");  relay_task_move(2, "done")
```

On the dashboard you watch, in real time: the **api** project panel fill with two agents (Anthropic +
OpenAI logos), two cards slide To Do → In Progress → Done, and their back-and-forth appear in the project's
**conversation lane**. No copy-paste, no "what is the other one doing?" — it's all on the board.

> Idle instead of busy? A waiting agent parks on `relay_wait(280)` and wakes the instant a message lands —
> cheap, no polling.

---

## How it works

```
  ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
  │  claude #1   │        │  claude #2   │        │  relay-watch │
  │ (plugin/MCP) │        │ (plugin/MCP) │        │   (SSE feed) │
  └──────┬───────┘        └──────┬───────┘        └──────┬───────┘
         │  register / send /    │   poll / status        │  stream
         └───────────────┬───────┴────────────────────────┘
                         ▼
                 ┌───────────────┐
                 │   hub.mjs     │  HTTP bus + presence board + SSE push
                 │  (no deps)    │  state persists to ~/.agent-bus/bus.json
                 └───────────────┘
```

- **`hub.mjs`** — the message bus. Endpoints: `/register` `/status` `/peers` `/send` `/inbox` `/poll`
  (long-poll) `/stream` (SSE) `/health` `/projects` `/tasks` `/project`. Node built-ins only; binds
  **`127.0.0.1` (loopback) by default** — local-first and safe. Set `RELAY_HOST=0.0.0.0` to expose it
  to other machines (private network only — see the roadmap note below).
- **`mcp.mjs`** — the MCP server each session loads (the `relay_*` tools).
- **`hooks/sessionstart.mjs`** — auto-register + roster injection + pending-handoff takeover.
- **`hooks/precompact.mjs`** — writes the handoff at the compaction threshold.

Config resolution everywhere: `RELAY_URL` env → `~/.agent-bus/config.json` → `http://127.0.0.1:4477`.
Session identity: `RELAY_SESSION` env → `<hostname>:<project-folder>`.

### Always-on / remote hub — *(roadmap, not the default)*

Today agent-bus is **local-first**: the hub runs on your machine at `127.0.0.1:4477`, and every session on
that machine coordinates through it. That's the right default — no network, no exposure, no account, works
the second you install it. Most setups never need more than this.

A natural **future option** (planned, gated on real demand) is moving the hub to an **always-on host** so
sessions on *different* machines — or a machine that isn't always awake (a laptop) — can share one bus:

- **Private (tailnet) — the safe near-term path.** Run the hub on one always-on box you control (a small
  VPS, or a home server) and reach it over a private overlay like [Tailscale](https://tailscale.com). Point
  each machine's `~/.agent-bus/config.json` `url` at the host's tailnet address (`RELAY_HOST=0.0.0.0` on the
  host). The tailnet *is* the trust boundary — only your devices are on it — so no extra auth is needed.
- **Public / multi-user — needs an auth layer first.** A publicly reachable, hosted instance (so people who
  *aren't* on your tailnet can join) is the eventual product shape. The hub ships with **no authentication
  today**, so this requires adding a token/identity layer before any public exposure. Deliberately deferred
  until there's demand, so we design the safe version once rather than bolt it on.

**Rule that won't change:** never expose the hub to the public internet without auth. Loopback or a private
network only.

---

## Honest limits

- You **can't push *into* a session that's mid-turn.** Claude Code acts turn-by-turn on its input, so a
  *busy* session won't see a message until it finishes its current task and checks. Presence + parked
  `relay_wait` make *idle* sessions wake instantly; interrupting active work isn't possible.
- The hub is intentionally tiny — in-memory + a JSON file. Great for a handful of sessions; not a
  production message queue.
- No auth out of the box — run the hub on localhost or a private network.

---

## Tests

```bash
npm test     # hermetic: feeds adversarial handoff content, asserts the hook always emits valid JSON
```

---

## License

[MIT](./LICENSE) © 2026 Sasha Bogojevic.

## Notes

- The optional handoff summarizer is any CLI that reads text on stdin and writes a summary. By default
  agent-bus looks for [**Scrooge**](https://github.com/sashabogi/token-scrooge) — an open-source CLI
  that routes each task to the cheapest capable LLM and logs the spend — so handoff summaries cost a
  fraction of a cent. Without it, agent-bus falls back to a raw transcript tail (no extra dependencies).
- Built for, and tested with, [Claude Code](https://claude.com/claude-code).
