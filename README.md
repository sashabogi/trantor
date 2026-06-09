# claude-relay

A tiny message bus that lets **independent Claude Code sessions talk to each other live** —
locally or across machines over Tailscale. Native Claude Code has no bridge between two
separately-started sessions (Agent Teams is lead-spawned + local-only); this fills that gap.

Two pieces:
- **`hub.mjs`** — an HTTP message bus (binds `0.0.0.0` so localhost *and* Tailscale peers reach it).
  State persists to `~/.claude-relay/bus.json`.
- **`mcp.mjs`** — an MCP server each session loads. Tools: `relay_whoami`, `relay_peers`,
  `relay_send(to,text)`, `relay_inbox`, `relay_wait(timeout)`.

## Quickstart (install as a plugin — recommended)

```bash
# 1. Clone + install deps (the MCP server needs them)
git clone https://github.com/sashabogi/claude-relay ~/.claude-relay-src
cd ~/.claude-relay-src && npm install

# 2. Start a hub (always-on, local). Pick a port; default 4477.
#    For a single machine, localhost is enough; for multiple machines, bind a shared/Tailscale host.
node hub.mjs &                         # http://127.0.0.1:4477
mkdir -p ~/.claude-relay
echo '{"url":"http://127.0.0.1:4477"}' > ~/.claude-relay/config.json   # where sessions find the hub

# 3. Install the plugin (auto-register hook + handoff hook + relay MCP tools)
claude plugin marketplace add sashabogi/claude-relay
claude plugin install claude-relay
```

After install, **every new `claude` session** auto-registers with the hub and gets a `<claude-relay>`
roster of other live sessions, plus the `relay_*` MCP tools — no per-session setup. (Already-running
sessions won't have it until restarted — but they can still talk to the hub via plain `curl`.)

Verify it worked: open a fresh `claude` in any project and it should print a roster (if other sessions
are live) and respond to `relay_peers`.

## Run

**1. Start the hub** (once, anywhere both sessions can reach — a laptop for local, or Netcup for always-on):
```bash
node hub.mjs                      # default 0.0.0.0:4477
curl -s localhost:4477/health
```

**2. Add the relay to a session** (give each session a distinct RELAY_SESSION id):
```bash
claude mcp add relay \
  -e RELAY_URL=http://127.0.0.1:4477 \
  -e RELAY_SESSION=macbook \
  -- node /Users/sashabogojevic/development/claude-relay/mcp.mjs
```
Then in that session: `relay_whoami`, `relay_peers`, `relay_send(to:"mini", text:"hi")`,
`relay_wait(timeout:30)` to block for a reply.

**3. Cross-machine (MacBook ↔ Mac Mini over Tailscale):**
Run the hub on one box (or Netcup), then point each session's `RELAY_URL` at the hub's Tailscale IP:
- MacBook hub: `RELAY_URL=http://100.116.255.80:4477`
- Mac Mini session: `RELAY_SESSION=mini RELAY_URL=http://100.116.255.80:4477`
(For always-on, run the hub on Netcup `100.79.242.104` and point both there.)

## Verified
A real spawned `claude -p` session loaded the MCP, read its inbox, reasoned about a question,
and replied via `relay_send` — the message was received by a separate process. End-to-end live.

## Headless test harness
```bash
RELAY_PORT=4477 node hub.mjs &
curl -s -XPOST localhost:4477/send -d '{"from":"MAIN","to":"B","text":"what is 17*3? reply via relay_send to MAIN"}'
claude -p "Use the relay MCP: relay_inbox, answer MAIN's question, relay_send the reply." \
  --mcp-config relay-B.json --dangerously-skip-permissions
curl -s "localhost:4477/inbox?session=MAIN&since=0"   # -> B's reply
```

## Context-handoff / successor sessions (the headline feature)

Instead of compacting a full window, **hand the work to a fresh session with a new full window.**

- **`hooks/precompact.mjs`** (PreCompact) — fires right before Claude Code compacts. It summarizes the
  recent transcript into a rich handoff (via `scrooge` if present, else a raw tail), saves it to
  `~/.claude-relay/handoffs/<project>-<ts>.json`, and pings the hub so siblings know.
- **`hooks/sessionstart.mjs`** — a fresh session started in the same project detects the unconsumed
  handoff, injects a `🔄 You are taking over…` block (summary + git state + a pointer to the full prior
  transcript, which Foundation/Gaia has ingested and is searchable), and marks it consumed.
- **`/claude-relay:relay-handoff`** — trigger a handoff *proactively* (the model writes a higher-quality
  one than the auto-summary because it has full context). Then open a fresh terminal here.

Net: "compaction, but better summary + a brand-new million-token window + searchable history." Verified
end-to-end (PreCompact wrote a handoff; a fresh SessionStart loaded and consumed it).
