# TDD — Crew robustness: live model selection + real-time failure visibility

Status: IN BUILD (2026-06-15). DONE+verified+committed: **A core** (`scrooge route` + `crew.sh`
lazy `agent:provider` + prefix fix — commit 875c51f) and **B core** (runner real-time failure
visibility + hub health + advise "auto" — commit c09f2ff). Suite 57/57. REMAINING: `trantor swap`
command (crew.sh window-mgmt), dashboard rendering of errored/down (ui.html + mcp.mjs relay_peers),
Teams merge. Decisions locked: lazy selection · `trantor swap` its own command · prefix fixed.
Scope: public `trantor` (advisor + engine + crew launch + runner). Propagates to `trantor-teams` via
`git merge upstream/main`. Two related crew-robustness fixes: **(A)** the crew picks live models
(§3–§9), and **(B)** crew failures are surfaced to the orchestrator in real time (§11).

## 1. Problem

When the crew runs, agents execute on their **CLI default model** — the advisor never
enumerates a provider's live models or picks one per task. The brain *can* do this, but the
crew path bypasses it entirely.

Evidence (current code):
- `bin/advise.mjs:125` — crew cards get `model: \`${r.executor}-default\`` (literally `codex-default`, etc.).
- `bin/advise.mjs:33-40` (`scroogeModelFor`) — the only capability/cost pick, wired **only** to the
  easy/Scrooge-inline path, and it reads the **static** `~/.token-scrooge/registry.json`, which is
  **stale** (knows `glm-5`/`glm-4.7`, not `glm-5.1`).
- `engine/bin/scrooge` — DOES hit live `/models` per provider (lines 260, 1050), caches per-provider,
  self-heals stale ids ("route to a real live id", ~line 295), capability×cost routes via
  `route_task()` (line 201). But this only fires for `relay_scrooge` / `scrooge -t <task>`.
- No agent→provider mapping exists anywhere in `bin/`.

Real-world failure that surfaced this: codex ran out of credits; the operator asked the agent to
switch to GLM. Trantor had no flow to enumerate ZAI's live models and pick one, so the agent
freelanced and guessed `glm-4.6` (not real / stale) instead of the live newest `glm-5.1`.

## 2. Goal / Non-goals

**Goal:** the advisor assigns each crew agent a **deliberately chosen, live-verified model** for its
task/difficulty (from the agent's provider's live `/models`), pinned through the existing
`trantor up agent:model` → `CREW_MODEL` → runner path. Plus a first-class **mid-flight swap** so an
exhausted/rate-limited agent can be re-pinned to a live-selected model on another provider.

**Non-goals (this iteration):** changing how `relay_scrooge` routes (already correct); per-token live
re-routing mid-turn; new providers; touching `~/.agent-bus` state or the `relay_*` tool names.

## 3. Key insight — the only missing link is *selection*

The **application** path already works end-to-end:
`advise → agent:model → crew.sh:86-93 (CREW_MODEL) → crew-runner.mjs:49-65 (per-CLI mflag)`.
The runner pins arbitrary models today (`codex -m`, `gemini -m`, `kimi --model`, `opencode -m`,
auto-qualifying bare ids for opencode/deepseek). So we do **not** touch the runner's apply logic —
we only make the advisor supply a real model id instead of `<cli>-default`.

## 4. Design

### 4.1 New: `scrooge route` (engine) — selection as JSON, provider-constrained
Add a read-only subcommand that returns the chosen live model without making a call:
```
scrooge route --provider <p> --task <kind> --difficulty <easy|medium|hard> [--json]
# → {"provider":"zai","model":"glm-5.1","why":"top capability ≥ floor, live-verified, cheapest of ties","live":true,"candidates":[...]}
```
Implementation: reuse the existing live `/models` enumeration (`cmd_models`/`http_get(base+"/models")`)
+ `capabilities.json` scoring + difficulty floor (mirror `scroogeModelFor`'s floor: easy 0 / medium 35 /
hard 55), constrained to one provider. Falls back to the registry list if the endpoint is unreachable,
and flags `"live":false` so callers know. Cached via the existing per-provider models cache (TTL) so a
single `advise` run doesn't hammer endpoints.

### 4.2 Provider = an ACCESS PATH, not a vendor (resolves the plan-vs-API question)
Critical: a vendor like ZAI or Kimi is reached by **two distinct access paths** — a **coding plan**
(flat-rate, served via e.g. opencode's `zai-coding-plan` provider) and the **direct API** (metered,
`ZAI_API_KEY` → `api.z.ai/...`). They expose **different model sets, endpoints, and cost models**, and a
given user may have one, the other, or both. So we never key model selection on a vendor — we key it on
the **specific provider entry the agent is actually wired to**.

- Scrooge already represents providers as distinct registry entries, each `{base_url, key_env}`, resolved
  generically (`reg["providers"][p]["base_url"]`). We ADD coding-plan entries alongside the API ones:
  `zai-coding-plan`, `kimi-coding-plan`, … (base_url + key). API entries (`zai`, `kimi`) stay as-is.
- **agent→provider-entry** resolves from what the agent actually runs: the pinned model's provider prefix
  (`zai-coding-plan/glm-5.1` → `zai-coding-plan`), else the agent's CLI provider config
  (`~/.config/opencode/opencode.json`, codex/gemini/kimi configs), else a sane default; overridable in
  `profile.json`. For codex→openai/gemini→google/kimi→moonshot the default is the API entry unless the
  CLI config says otherwise.
- `scrooge route --provider <entry>` enumerates **that entry's** `/models`. If the entry isn't in
  Scrooge's registry, `route` falls back to reading the **agent's CLI provider config** for `{base_url,
  apiKey}` (exactly what a human does by `cat`-ing `opencode.json`). No vendor assumptions, no "which plan
  am I on" guessing — query the endpoint the agent uses.
- Cost/pool follows the entry too: coding-plan entries → sub/flat pool ($0 marginal in the advisor's
  accounting); API entries → metered. (`profile.json` tiers already express this per provider.)

### 4.3 LAZY resolution at spawn (decided) — not eager in advise
The advisor stays fast: it does **not** call `scrooge route` at kickoff. Instead it recommends
`executor` + `difficulty` + `kind` per package (as today) and **drops the `<cli>-default` string** — the
model is resolved at spawn time, picking the freshest live model:
- **`trantor up <agent> [--task <kind>] [--difficulty <d>]`** — when no explicit `:model` is pinned,
  the up-path resolves agent→provider and calls `scrooge route --provider … --task … --difficulty …
  --json` *right before spawning*, then passes the chosen id as `CREW_MODEL`. An explicit
  `trantor up agent:model` still wins (manual override).
- The crew skill passes each card's `--task/--difficulty` when it issues `trantor up` for that card.
- **Graceful fallback:** scrooge absent / no provider key / endpoint down → fall back to the CLI default
  (empty `CREW_MODEL`) and log the reason on the bus. Crew launch NEVER blocks on selection.
- `advise` output: `routing[].model`/`card_args[].model` become `"auto"` (resolved at spawn) instead of
  `<cli>-default`; `routing_table_md` shows `auto→(resolved live at spawn)` so the user sees the intent.

### 4.4 `trantor swap` — its own command (decided), mid-flight live re-pin
```
trantor swap <agent> [--provider <p>] [--task <kind>] [--difficulty <d>]   # re-enumerate + re-pin + relaunch
```
A first-class command (not folded into `up`): pick via `scrooge route` (provider defaults to the agent's
mapped provider; `--provider` moves providers, e.g. codex→zai), then `trantor up <agent>:<model>`
(existing verified relaunch) and re-send the in-flight card's contract. This is the exact codex→GLM
scenario, done by the brain — and it's the natural action the orchestrator takes when §11 reports an
agent exhausted/failed.

## 5. Interface contracts (the seams)
- `scrooge route … --json` → `{provider, model, why, live:boolean, floor:number, candidates:[{model,score,cost_in,cost_out}]}`; non-zero exit + `{error}` on hard failure.
- `advise` output unchanged in shape; `routing[].model` / `card_args[].model` now carry live ids (or `<cli>-default` on fallback). Back-compatible — consumers already read these fields.
- agent→provider map: `{[agent]: providerId}`; `profile.json.providers[agent].provider` overrides.

## 6. File-by-file changes
**Problem A — model selection (lazy):**
- `engine/bin/scrooge` — add `cmd_route()` + dispatch (~line 1212 block); reuse live `/models` + caps + floor; return runner-ready (provider-qualified) id. Resolve the provider's `{base_url, key}` from the registry entry, else fall back to the agent's CLI provider config (e.g. `opencode.json`) so coding-plan-only-in-CLI endpoints work.
- `engine/registry.template.json` — add coding-plan provider entries (`zai-coding-plan`, `kimi-coding-plan`, …) alongside the existing API entries (`zai`, `kimi`); each `{base_url, key_env}`. (Selection still queries live `/models`; these just give names/pool tags.)
- `bin/advise.mjs` — agent→provider map (exported, reused by up/swap); drop the `<cli>-default` at :125 → emit `"auto"`; annotate intent in `routing_table_md`.
- `bin/crew.sh` (`up`) — accept `--task/--difficulty`; when no explicit `:model`, resolve live via `scrooge route` right before spawn → `CREW_MODEL`; graceful fallback to default.
- `bin/crew-runner.mjs` — **prefix fix** (drop hardcoded `deepseek/`, qualify via provider map / trust route's qualified id).
- `bin/cli.mjs` — register `trantor swap`; thread `--task/--difficulty` into `up`.
- New `bin/swap.mjs` — swap flow (pick → `trantor up agent:model` → resend contract).

**Problem B — failure visibility:**
- `bin/crew-runner.mjs` — check `runTurn` exit; on non-zero, classify (capture stderr) + `relay_send` failure event + `/register` `status:"errored: <reason>"`; consecutive-failure escalation → `"down"`; loud kickoff-failure path.
- `hub.mjs` — accept/track an explicit `errored`/`down` presence status; expose in `/peers`.
- `ui.html` — render `errored`/`down` with a distinct colour (not green/stale/offline).

**Shared:** `docs/` (this TDD + README note); crew skill (`skills/crew/SKILL.md`) — document lazy live models, `trantor swap`, and that the orchestrator now gets real-time failure events.

## 7. Test plan (gate: `npm test` green + new drills)
**A — selection:**
- **route (engine):** mocked `/models` → picks top-capability ≥ floor; stale registry id NOT returned when absent from live list; endpoint-down → registry fallback `live:false`; no provider key → graceful error; returns provider-qualified id for opencode/zai.
- **up (lazy):** `trantor up opencode --task code --difficulty hard` with no `:model` resolves a live id via (mocked) `scrooge route` and sets `CREW_MODEL`; explicit `:model` overrides; scrooge-absent → empty `CREW_MODEL` (CLI default) + bus log; **prefix fix** — bare ZAI id qualifies to `zai-coding-plan/…`, not `deepseek/…`.
- **advise:** crew package model is `"auto"` (not `<cli>-default`); provider map + `profile.json` override honored.
- **swap:** `trantor swap codex --provider zai` picks a live ZAI model → `trantor up codex:<id>` (spawn mocked) → resends contract; missing key → clear error, no relaunch.

**B — failure visibility:**
- runner: non-zero turn exit → a `relay_send` failure event lands on the bus AND presence flips to `errored: <reason>` (mocked hub); classifier maps a credits/quota stderr → `"exhausted"`, a generic crash → `"crashed"`.
- escalation: 2 consecutive failures → `"down"` status + louder event.
- kickoff failure (first turn non-zero) is reported (the agent-never-reported-in case).
- hub/ui: `/peers` carries `errored`/`down`; a green agent whose CLI is failing now shows `errored`, not online (the exact blind-spot regression).

**Regression:** existing advisor/crew/team drills green; Scrooge’s own `route_task`/`relay_scrooge` path unchanged; happy-path turns still post no failure noise.

## 8. Rollout
1. Land on public `trantor`, version bump, `npm test` green, tag/release.
2. `trantor-teams`: `git fetch upstream && git merge upstream/main` (same flow just used for v0.17.2);
   expect conflicts only if Teams touched advise/crew — resolve preserving team-mode auth.
3. Refresh capabilities for any newly-surfaced models: `scrooge-capabilities` (so scoring knows glm-5.1 etc.).

## 9. Risks / edge cases
- **CLI can't pin arbitrary model** (plan/sub limits which ids are allowed) → `route` should intersect
  live `/models` with what the *plan* exposes; for sub-tier agents, prefer the plan's served list.
- **opencode/deepseek id qualification — FIX (decided).** The runner hardcodes a `deepseek/` prefix for
  bare ids (`crew-runner.mjs:52`) for BOTH `deepseek` and `opencode` agents — so an opencode agent on ZAI
  gets `deepseek/glm-5.1` instead of `zai-coding-plan/glm-5.1`. Fix: qualify using the **agent's mapped
  provider** (§4.2), not a hardcoded string — `opencode`→`<profile provider, e.g. zai-coding-plan>/`,
  `deepseek`→`deepseek/`. Better: `scrooge route` returns the **runner-ready, already-qualified** id so the
  runner only qualifies a *manually* passed bare id (using the provider map). Both: drop the literal
  `deepseek/` constant.
- **Rate limits / latency** on `/models` during `advise` → rely on the existing per-provider cache TTL;
  never block crew launch; fall back to registry then `<cli>-default`.
- **Capabilities gaps** for brand-new models → fall back to "newest in family ≥ floor" heuristic, flag it.

## 10. Decisions (resolved 2026-06-15)
1. **`trantor swap` is its own command** (§4.4) — not folded into `up`.
2. **Lazy selection** (§4.3) — advisor recommends; the `up`/`swap` path resolves the live model at spawn.
3. **Fix the prefix logic** (§9) — drop the hardcoded `deepseek/`; qualify via the agent→provider map /
   route-returned qualified id.
4. **Plan-vs-API — RESOLVED (§4.2).** Provider = an *access path*, not a vendor. Coding plan and direct
   API are separate provider entries (`zai-coding-plan` vs `zai`); `route` queries the `/models` of the
   entry the agent is actually wired to (registry entry, else the agent's CLI provider config). Works for
   coding-plan-only, API-only, or both — no per-user answer needed. (Dropped the earlier intersect-hack.)

## 11. Problem B — real-time crew failure visibility

### 11.1 Diagnosis (why the orchestrator was blind)
`crew-runner.mjs` runs each turn via `spawnSync` and captures the CLI exit code (`runTurn` returns
`r.status`, line 92–94) — but **the caller ignores it**: the kickoff (line 117) and the main loop
(line 137) discard the return. On failure the runner only: writes **local** telemetry (line 92), prints
to **its own window** (line 93), and **resumes long-polling** (line 138). That poll is the heartbeat, so
a CLI that fails every turn keeps the agent **🟢 online**. **Nothing is ever posted to the bus on
failure**, so the orchestrator gets no real-time signal — exactly what happened when codex ran out of
credits. (The §B heartbeat fix makes a failing-but-alive agent look *more* healthy, so this must ship
together.)

### 11.2 Design — the runner reports turn outcomes to the bus
The runner already speaks to the hub via `api()`; make it surface failures:
- **On non-zero exit:** POST a bus event the orchestrator sees — `relay_send` to `all`:
  `"⚠️ <agent> turn FAILED (exit <code>)<· classified reason>"`, AND set presence
  `status: "errored: <reason>"` via `/register` (distinct from a healthy status) so `relay_peers` /
  the board show it as failing, not green.
- **Classify the failure** (best-effort): capture stderr on non-zero exit (currently `stdio:inherit`
  except for sid-parsing — capture-and-echo on failure) and pattern-match
  `auth|credit|quota|rate|402|429|insufficient` → `"exhausted/credits"`, else `"crashed"`. Drives whether
  the orchestrator should `trantor swap` (exhausted) vs investigate (crash).
- **Escalate on repeat:** track consecutive failures; after N (default 2) post a louder
  `"🛑 <agent> DOWN — N consecutive failures, needs swap/attention"` and set presence `status:"down"`.
- **Hub presence state:** add an explicit `errored`/`down` presence so the dashboard renders a distinct
  colour (not the green/stale/offline trio). Small `hub.mjs` + `ui.html` change; back-comp default
  `online`.
- **Kickoff failure is loud too:** if the very first turn fails (agent never even reported in), the
  runner posts the failure immediately — covers "fired up, codex failed, nobody knew".

### 11.3 Ties to Problem A
A `"<agent> exhausted/credits"` event is the trigger for `trantor swap <agent> --provider <alt>` — the
orchestrator (or a future auto-policy) re-pins a live-selected model on another provider. A→B→swap is
the full, automated answer to the incident that surfaced all of this.
