<div align="center">

```
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗      ██████╗ ███████╗██╗      █████╗ ██╗   ██╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝      ██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗        ██████╔╝█████╗  ██║     ███████║ ╚████╔╝
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝        ██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗      ██║  ██║███████╗███████╗██║  ██║   ██║
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝      ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝
```

### Let your Claude Code sessions talk to each other — live.

**Open six terminals. Now they know about each other, share status, hand off work, and message in real time.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-D97757)
![Status](https://img.shields.io/badge/status-working-2DD4BF)

</div>

---

## Why this exists

Claude Code runs each terminal session in its own bubble. Two sessions you start separately can't
see or talk to each other — Agent Teams only covers teammates one lead *spawns*, locally. So if you
run several Claude sessions at once (different projects, a long build here, research there), they're
blind to each other, and the only way to "continue" a full context window is to compact and lose detail.

**claude-relay** is a tiny message bus that fixes all of that:

- 🛰️ **Live messaging** — any session can `relay_send` to any other and `relay_wait` for a reply.
- 🟢 **Presence board** — every session auto-registers and posts a one-line status. See *what all your
  sessions are doing* with a single instant, zero-cost read (no LLM round-trip).
- ⚡ **Instant push** — an `SSE` stream + a `relay-watch` terminal feed show messages the moment they land.
- 🔄 **Context handoff** — at the compaction wall, a session writes a rich handoff; you open a fresh
  terminal and it **takes over with a brand-new full context window** instead of compacting.
- 🌐 **Local or cross-machine** — one machine over `localhost`, or many machines over Tailscale/any network.

It's ~300 lines, has no database, and the hub uses only Node built-ins.

---

## Quickstart

```bash
# 1. Clone + install deps (the MCP server needs them)
git clone https://github.com/sashabogi/claude-relay ~/claude-relay
cd ~/claude-relay && npm install

# 2. Start a hub — the rendezvous both sessions reach.
#    Local-only: run it right here. Multi-machine: run it on any always-on box they can all reach.
node hub.mjs &                                   # http://127.0.0.1:4477
mkdir -p ~/.claude-relay
echo '{"url":"http://127.0.0.1:4477"}' > ~/.claude-relay/config.json

# 3. Install the plugin (auto-register hook + handoff hook + relay tools)
claude plugin marketplace add sashabogi/claude-relay
claude plugin install claude-relay
```

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
it proactively with the `/claude-relay:relay-handoff` skill (the model writes a higher-quality handoff
because it still has full context).

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
                 │  (no deps)    │  state persists to ~/.claude-relay/bus.json
                 └───────────────┘
```

- **`hub.mjs`** — the message bus. Endpoints: `/register` `/status` `/peers` `/send` `/inbox` `/poll`
  (long-poll) `/stream` (SSE) `/health`. Node built-ins only; binds `0.0.0.0` by default.
- **`mcp.mjs`** — the MCP server each session loads (the `relay_*` tools).
- **`hooks/sessionstart.mjs`** — auto-register + roster injection + pending-handoff takeover.
- **`hooks/precompact.mjs`** — writes the handoff at the compaction threshold.

Config resolution everywhere: `RELAY_URL` env → `~/.claude-relay/config.json` → `http://127.0.0.1:4477`.
Session identity: `RELAY_SESSION` env → `<hostname>:<project-folder>`.

### Cross-machine

Run the hub on any box every machine can reach (a small VPS, or one always-on machine on your
[Tailscale](https://tailscale.com) tailnet), point each session's config `url` at it, and they coordinate
across machines exactly like local ones. Keep the hub on a private network (tailnet/VPN) or add auth before
exposing it publicly.

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
  claude-relay looks for [**Scrooge**](https://github.com/sashabogi/token-scrooge) — an open-source CLI
  that routes each task to the cheapest capable LLM and logs the spend — so handoff summaries cost a
  fraction of a cent. Without it, claude-relay falls back to a raw transcript tail (no extra dependencies).
- Built for, and tested with, [Claude Code](https://claude.com/claude-code).
