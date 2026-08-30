# P0a — `server.live_handoff` semantics, and what the same page gave us for free (2026-08-30)

Source: herdr v0.8.2 official docs (session-state.mdx, fetched from the tagged revision).
Card #5575.

## The question: does `live_handoff` fit our handoff (ENDED→OPENED)?

**No — and that settles the design.** `server.live_handoff` replaces a running herdr SERVER
(update / remote-attach flows): the old server transfers live panes — PTYs, processes, agent
identity, durable metadata — to the new server so processes keep running across the
replacement. It is server succession, not agent succession. It explicitly does NOT preserve
transient coordination (in-flight API requests, waits, subscription streams — relevant to our
Phase 3 stream: reconnect and retry is the documented contract).

**Decision:** §5 ENDED→OPENED stays on the proven chain — graceful signal via herdr →
`trantor open` in the same pane — wrapped in the Phase 2 adapters (`pane.release_agent` on end).
No change to the TDD. Worth knowing operationally: `herdr update --handoff` exists (experimental,
opt-in) for updating herdr under a live fleet.

## The free finding #1: native agent session restore ≈ #5401 persistence

herdr restores session shape (workspaces/tabs/panes/cwd/layout) after a server restart, and —
**enabled by default** (`[session] resume_agents_on_restore`) — resumes agent panes natively by
re-running the agent's own resume command (`claude --resume <id>` for Claude Code, integration
v6+; codex/opencode/kimi equivalents listed per agent). Condition: the pane must have "reported
a native session reference through a current official Herdr integration."

That is card #5401 (W3-D: the session survives app restart AND reboot) mostly implemented by
the layer that owns it — once our panes report their sessions, which is exactly Phase 2.1.

## The free finding #2: ZERO herdr integrations are installed on this machine

`herdr integration status` (2026-08-30): every row "not installed" — claude, codex, opencode,
kimi, all 17. Consequences we have been living with:

1. **Agent state detection has run on heuristics the whole time.** The docs are explicit that
   integrations improve state fidelity. This is the probable mechanism behind the recurring
   "herdr says working but the runner is wedged" class (glm/deepseek runners wedged 11h,
   seat-why's reason for existing).
2. **Native session restore is dormant** — no session references were ever reported.
3. Phase 2.1 (report session→pane) may largely COME FREE from the official Claude integration
   (a hook at `~/.claude/hooks/herdr-agent-state.sh`) instead of our own sessionstart addition —
   or complement it (our hook still covers adopt/takeover edges where the integration lags).

**Recommendation (needs Sasha's approval — it modifies the harness):** install the official
integrations for the agents the fleet actually runs (`herdr integration install claude codex
opencode kimi`), then re-verify: (a) lifecycle fidelity in a P0b-style drill, (b) whether the
Claude integration's session reporting satisfies Phase 2.1's report-at-birth on its own,
(c) that its hook coexists with the trantor plugin's hooks (both are hooks in the same harness —
check ordering and that neither swallows the other's output). Decision and evidence go into the
Phase 2 card (#5579) when executed.

## TDD deltas from P0a

- Phase 3: the subscription stream's documented failure mode across server replacement is
  interruption + reconnect — the reconnect/re-seed design (session.snapshot) is confirmed
  required, not defensive.
- Phase 2: add the integration question above as the phase's first step (install-and-measure
  before writing our own reporter).
- After the salvage: `herdr update --handoff` is the fleet-safe way to update herdr itself.
