# claude-relay

A tiny message bus that lets **independent Claude Code sessions talk to each other live** —
locally or across machines over Tailscale. Native Claude Code has no bridge between two
separately-started sessions (Agent Teams is lead-spawned + local-only); this fills that gap.

Two pieces:
- **`hub.mjs`** — an HTTP message bus (binds `0.0.0.0` so localhost *and* Tailscale peers reach it).
  State persists to `~/.claude-relay/bus.json`.
- **`mcp.mjs`** — an MCP server each session loads. Tools: `relay_whoami`, `relay_peers`,
  `relay_send(to,text)`, `relay_inbox`, `relay_wait(timeout)`.

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
