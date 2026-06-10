# The Unified System — Scrooge (brain) × agent-bus (body)

*Design + build plan, 2026-06-10. Status: shipped in v0.13.0 (see "What ships now").*

## One sentence

One orchestration system that, for every piece of work, intelligently chooses **how to execute
it** — inline on the orchestrator, as a cheap stateless Scrooge call, or as a stateful crew
member in its own context window — based on **task shape, the user's plan economics, and the
context horizon**.

## The two halves

| | Scrooge (the brain) | agent-bus (the body) |
|---|---|---|
| Nature | function call — result returns **into your context** (by value) | colleague — works in **its own context**, reports by reference (~70-token bus messages) |
| State | stateless per call | stateful: native session resume across turns |
| Knows | capability registry, per-1M costs, difficulty gating, per-model lessons, the ledger | presence, Kanban + testing gate, contracts, supervision, handoff, the dashboard |
| Best at | small, discrete, self-contained grunt: drafts, extraction, classification, summaries, boilerplate | large, parallel, long-horizon: features, files, builds |
| Cost shape | absolute cheapest per task | **quota pooling** — spreads one build across separate subscription buckets |

**Decision rule:** small + stateless + result-fits-inline → Scrooge call. Large + stateful +
parallel or long-horizon → crew member. The orchestrator stays a foreman either way.

**Why crews win long builds (context math):** bus traffic is by-reference. The orchestrator's
context burns at *coordination rate* (~70 tokens/event), not *work rate* (10–200k tokens per
work product). A 1M-token orchestrator can supervise for days; inline execution kills it in
hours.

## Plan economics — the keystone input

The right mode depends on **what the user pays for the orchestrator**:

- **API-billed** → every orchestrator token is money. Offload aggressively: thin foreman,
  everything else on Scrooge + crew. (Pure cost play.)
- **$20 subscription** → the main session *cannot fit* a real build. Crew is the only path:
  the scarce Claude budget buys architecture + verification; the work runs on other vendors'
  quotas and pennies of Scrooge API.
- **Max-tier subscription** → marginal cost ≈ $0; the deciding axis becomes context horizon
  (and wall-clock parallelism).

**Quota pooling** (proven 2026-06-09): a five-vendor 3D game build with a rough API-equivalent
of $200–600 cost **$2.29 in actual money** — one DeepSeek API line; everything else absorbed by
four separate subscription pools no single one of which could have carried the build.

## The integration contract (what the body reads from the brain)

Scrooge's on-disk surface, consumed read-only — no changes to the scrooge repo:

- `~/.token-scrooge/registry.json` — providers, **models** `{cost_in, cost_out, context,
  good_for[], speed}`, `tasks` → ordered model preference lists
- `~/.token-scrooge/capabilities.json` — per-model `{intelligence, coding, math, reasoning,
  speed_tps}` (Artificial Analysis snapshot)
- `~/.token-scrooge/calls.jsonl` — the ledger: `{ts, model, task, project, tokens_in/out,
  cost_usd, ok}` per call
- `scrooge` CLI — one-shot execution: `scrooge -t <task> -d <difficulty>` with stdin piping

## New components (this build)

1. **Quota profile** — `~/.agent-bus/profile.json`: the user declares each provider's plan
   once (`claude: max | pro | api`, `codex: plus | pro | api`, …). Plans can't be detected
   reliably; declaring them is one command: `node bin/profile.mjs set claude=max codex=plus …`
2. **The Advisor** — `bin/advise.mjs` + MCP tool `relay_advise`: input = work packages with
   difficulty; reads profile + registry + capabilities; output = recommended mode
   (solo | scrooge | crew | hybrid), per-package agent/model routing, cost estimate, rationale.
   The skill calls it at kickoff — the "advisor moment": *"You're on a $20 plan; this is a
   6-package build — recommend crew mode, here's the routing and what it'll cost. Fire it up?"*
3. **Model-aware spawning** — `crew.sh up codex:gpt-5.5 deepseek:deepseek-v4-pro` → the runner
   passes each CLI's model flag. The advisor's routing becomes executable.
4. **Difficulty-tagged cards** — `relay_task_add(…, difficulty)`; hub stores it; dashboard
   badges it; the skill routes by it (easy → cheapest capable, hard → frontier).
5. **`relay_scrooge`** — fractal delegation: architect *and* crew members push grunt sub-tasks
   to cheap models inline, with the ledger keeping receipts. Routing all the way down.
6. **Economics on the dashboard** — hub `/economics` reads the ledger + profile; the UI shows
   live spend/savings, per-card model + difficulty, and each agent's quota pool. The dashboard
   is the UI Scrooge never had.
7. **Board truth-telling** — per-card history trail + "↩ bounced" annotations (a demoted card
   must look demoted, not deleted).
8. **Runner hardening** — wake-policy (broadcasts batched, direct messages wake), keep-alive
   fix, per-turn telemetry to `~/.agent-bus/logs/` (harvest never depends on window scrollback
   again), per-turn console banners.

## What ships now vs later

**Now (v0.13.0):** everything above, tested (mock scenario matrix + a real E2E mini-build).
**Later:** repo merge/rename + single binary; the advisor auto-detecting plan from usage
signals; public hosted hub + auth; Scrooge models gaining file-editing agency via courier
agents; cross-machine quota pooling.

## North-star invariants

- The orchestrator never carries work products it didn't need to see.
- Every execution path lands in one ledger; every failure becomes a lesson; every lesson
  reaches the next crew's prompt.
- The user is told *why* a mode was chosen, in one paragraph, before tokens are spent.
