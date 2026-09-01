# The System Contract — what Trantor is, who owns what, and the reassembly plan

Written 2026-08-30, after the 08-27→08-28 one-surface sprint (93 commits, 9 CLI + 14 app releases
in ~36 hours) left the surface feature-rich but seam-broken. This document is the constitution the
sprint never had: the WHY distilled, the ownership table every change must name a row of, the
handoff state machine, and the phased plan back to something that does not continuously break.

Nothing ships against this repo's desktop/app/handoff/chat code until the phase it belongs to,
and no phase ships until the end-to-end drill (§7) is green.

---

## 1. WHY — the thesis, distilled (do not re-litigate per feature)

- **The moat is the coordination layer, not the surface.** Verified empirically 08-27 across all
  ten ADE players (Orca 54.8k★, cmux, opcode, Superset, Claude Squad, Emdash, Vibe Kanban †,
  Nimbalyst, kild, Conductor): zero agent↔agent messaging, zero cross-project durable record,
  zero overseer/collision awareness, zero multi-provider cost economics. Trantor's core is what
  the category lacks. The bus, the board, the hooks, the costs — that layer is untouchable and
  was in fact untouched by the sprint (hooks: +68/−10 lines; wiring byte-identical).
- **One surface, integrated around the AGENT** (conversation/terminal center, record docked),
  not around the file. Terminal + cmux + app collapse into the app; the fourth surface
  (overseer/duty) dissolves into a view.
- **Vibe Kanban's corpse is the business lesson:** a free local orchestrator UI is a feature,
  not a product. Teams pay for the RECORD. The surface exists to make the record usable and
  showable — the audience is "legacy developers burning tokens raw in terminals."
- **Adopt what the category settled** instead of reinventing: worktree-per-agent isolation,
  diff-first review. Both already adopted.

## 2. What we had before the pivot, and why it was stable

Through 0.18.7 / app 0.3.21: three surfaces, and the plugin's twelve hooks did all automation —
SessionStart (register + roster + overseer warning + handoff delivery), UserPromptSubmit (focus
card), PreToolUse (sub-agent cards, file claims), PostToolUse (heartbeat, mid-turn inbox
delivery, todo sync), PreCompact (handoff write), Stop (refuse idle over unread DIRECTs),
SubagentStart/Stop (enrichment, cost cards), Notification (background agents).

It was stable because it had **one seam** (hooks ↔ hub) and **one identity anchor**: the session
IS the Terminal window you opened. Handoffs worked because the successor was naturally the next
session you started. The app was a pure reader of the event stream and structurally could not
break a session.

## 3. What the pivot added — and what Orca/herdr genuinely do more cleverly

The one-surface build made the app an ACTOR: it hosts the orchestrator in a herdr pane
(`trantor open`), renders the conversation by tailing the CC transcript, sends operator messages,
and fires handoffs/takeovers. All correct ambitions. The failure was in HOW: we hand-built
identity, transport, lifecycle, and delivery out of side files, keystroke injection, and polling
loops — while the terminal backend under our feet ships all four natively, hardened at
32k-star scale. Verified against the live herdr v0.8.2 socket schema (196 methods) on 08-30:

| We hand-built (and it broke) | herdr provides natively |
|---|---|
| `pane_send` keystrokes; bracketed-paste fix (0.18.15); esc-esc-esc input clear that interrupted live turns (reverted 0.3.53) | `agent prompt` — honors the pane's live bracketed-paste mode, encoded Enter, **refuses to type into a blocked agent** (`agent_blocked`), detects stalls (`agent_prompt_stalled`) |
| Delivery receipts reconstructed from transcript diffing | `agent prompt --wait` — returns on a settled `idle`/`done`/`blocked`, an observed lifecycle change, not a hope |
| Idle guessing ("herdr says working but the runner is wedged"), seat-why forensics | Defined lifecycle: `idle` / `working` / `blocked` (recognized approval-or-question UI) / `done` / `unknown`, plus `agent wait --until <state>` |
| `orch-sessions.txt` + `crew-windows.txt` positional identity, hand-rewritten on every handoff/adopt | `pane.report_agent_session` / `pane.report_agent` / `pane.release_agent` — the pane KNOWS its agent and session; named agents follow the occupant and clear on exit |
| 300ms chat poll, 1500ms xterm poll, 2s sync poll, 3s status poll | `events.subscribe`, `pane.wait_for_output`, `agent.wait` — push, not poll |
| baton write + SIGTERM + reopen choreography | `server.live_handoff` as a first-class primitive (semantics to confirm — phase 0) |
| worktree refresh scripts at runner boot | `worktree.create/list/open/remove` |

Orca's cleverness (MIT — the 08-27 instruction "read their code before building our pane view"
was never executed; it is now phase 0): inline diff annotations that flow BACK into an agent
prompt; the usage footer with real windows per provider (the #5570 binding spec); SSH remote
agents; mobile as another client of the same state.

**The regression, stated honestly:** the plugin was never disassembled — its AUTHORITY was.
The app duplicated state the hooks own (session identity, delivery truth, context %) and
rebuilt worse versions of what herdr owns (transport, lifecycle, identity), so four
representations of "the conversation" had to agree at all times with no owner for any of them.
Every bug of the sprint — newline-as-Enter, /compact fusion, the esc interrupt, the silent
handoff, the 7%-at-88% gauge, the stale balances, the unrecapped successor — is one of these
ownership gaps. Whack-a-mole was the symptom; missing ownership was the disease.

## 4. THE OWNERSHIP TABLE (the contract — every change names its row)

| Concern | Single owner | Writers | Consumers | Never |
|---|---|---|---|---|
| Terminals, panes, ptys | herdr | herdr only | app (render), CLI | app/CLI spawn raw ptys |
| Agent lifecycle state (idle/working/blocked/done) | herdr `agent.*` | herdr detection | composer gate, seat states, takeover idle-gate | our own "looks idle" heuristics |
| Prompt delivery to the orchestrator | herdr `agent prompt --wait` | app composer, CLI, duty — all through the same call | receipts UI | raw keystrokes at an agent pane (`pane send_text/send_keys` is for HUMAN terminal input and explicit key UI actions only) |
| Runtime session identity (which sid owns the pane) | herdr `pane.report_agent_session` | SessionStart hook (self-report), `trantor open`/`adopt`/`takeover` | app watcher, chat, inventory | anything resolving identity by "newest transcript" when a report exists |
| Durable session map (cold start, non-pane sessions) | `orch-sessions.txt` | SessionStart claim, adopt, takeover — exactly three; each write logged to the bus | herdr re-registration at boot, cold-start resolution | app writing it; ad-hoc rewrites |
| Conversation rendering | CC transcript JSONL, ONE Rust decoder | Claude Code | chat watcher (tail), backfill | second decoders; rendering herdr terminal text as conversation |
| Context % (the number the baton AND gauge read) | one function, `contextUsage`, with a monotonic guard (#5572) | transcript usage rows | gauge, handoff banner, heartbeat baton arming | two implementations; last-row reads without the guard |
| Delivery truth (operator-visible) | transcript receipt (a user turn CONTAINS the send) | watcher | chat "queued/seen/lost" states | declaring delivered on send success alone |
| The record: board, cards, costs, messages, gates | hub + hooks (unchanged — the moat) | hooks, CLI, seats via bus | app (reader), duty, overseer | app writing board state directly |
| Handoff lifecycle | the state machine in §5 | its named steps only | everything | any step silently skipped |
| Provider balances | `lib/balances.mjs` → LOCAL hub snapshot (dual-push stays) | CLI + balance-check hook | header strip | app calling providers directly |
| Crew-seat health (headless runners) | bus ledger + heartbeats (`seat-why` evidence) | crew-runner, hooks | board, app seat states | re-keying runner truth to herdr agent detection (§8) |
| Fleet roster + routing | derived roster (`discoverSeats`) + scrooge capabilities | profile, opencode.json, `scrooge-capabilities` | advisor, `trantor up`, `trantor models` | hardcoded rosters; hard-tier routed to flash-class models |
| Language intelligence in the editor (servers, lifecycle, framing) | Rust `lsp` module (docs/CONTRACT-editor-intelligence.md) | Rust only | Monaco via monaco-languageclient over Tauri events | TS spawning servers; servers outliving the lens; a fake "ready" |

Two standing rules the table implies:
- **If you are typing keystrokes at an agent, you are wrong.** The only keystroke paths are the
  human typing in the terminal view and explicit `agent send-keys` UI actions (esc, ctrl+c) the
  operator chose.
- **A new state file requires a row in this table before it exists** — owner, writers, consumers.

## 5. The handoff state machine (no silent transitions, ever)

```
ARMED      context ≥ warnFrac, from the ONE gauge function (#5572 is a precondition)
  → OFFERED    banner in chat + bus event; operator picks Hand off / Keep going (episode re-offer +2%)
  → WRITTEN    baton written (write-only; session_id = writer). VISIBLE: chat divider "handoff written"
  → ENDED      predecessor ends gracefully via herdr (process signal; never keystrokes)
  → OPENED     successor starts in the SAME pane (trantor open takeover path)
  → CLAIMED    successor claims baton; orch-sessions.txt rewritten (logged); pane.report_agent_session updated
  → REBOUND    watcher follows (chat-session-changed → "session continued" divider); composer gate reopens on herdr's word
  → RECAPPED   successor's FIRST message is the ≤3-sentence recap (task, state, next step).
               The SessionStart hook injects the handoff with this instruction pinned;
               a handoff is CONSUMED only when the recap turn exists in the successor transcript —
               otherwise the handoff is re-presented and the app shows "successor has not recapped".
```

Every transition emits a bus event and a visible chat artifact. The 08-28 failure — a handoff
written, fired, and a successor that answered a stale composer message instead of recapping —
becomes structurally impossible: RECAPPED is a gate, not a hope. Auto mode (`baton` dial =
`auto`) skips OFFERED's wait but not its visibility.

## 6. The reassembly plan (phases; each lands alone; drill-gated)

**Phase 0 — research spikes, no code ships (½ session)**
0a. `server.live_handoff` semantics — read herdr docs/source; decide whether §5 ENDED→OPENED
    rides it or stays on our signal+open chain.
0b. Live drill: `herdr agent start --kind claude` + `agent prompt --wait` against a scratch
    project — verify the claude manifest detects CC, prompt lands, lifecycle states are truthful,
    `blocked` catches permission dialogs. This validates the whole Phase 1 bet cheaply.
0c. Orca code-read (MIT): conversation binding, diff annotations→prompt, usage footer. One
    session, notes into docs/RESEARCH-orca.md. Feeds #5570 and the future review lens.

**Phase 1 — transport (the chat becomes trustworthy)**
Replace the composer's `pane_send` keystroke path with `agent prompt --wait` end to end
(app → Tauri → herdr). Delete the hand-rolled bracketed-paste wrapper and every input-clearing
branch. Delivery = prompt result (fast) + transcript receipt (truth). Composer gate reads
herdr lifecycle, not our guesses. `agent_blocked` renders as exactly that, with the pane one
click away.

**Phase 2 — identity (one authority, one cache)**
SessionStart hook reports the session to its pane (`HERDR_ENV`/`HERDR_PANE_ID` present →
`pane.report_agent_session`); open/adopt/takeover do the same at their step. Runtime resolution
order everywhere (app + CLI): herdr report first, `orch-sessions.txt` as cold-start fallback,
"newest transcript" only in the adopt PICKER (shown, never guessed). The three writers of the
map file log every rewrite to the bus.

**Phase 3 — events (the app stops polling herdr)**
`events.subscribe` replaces the pane/agent/status polls (chat transcript tail remains a file
tail — that part is correct). Fewer loops, fewer races, and seat states change when herdr says
so, not up to 3s later.

**Phase 4 — handoff (§5 built as written)**
Precondition: #5572 (monotonic context guard) — the machine's trigger must not lie. Then the
state machine, including the RECAPPED gate and its hook-side enforcement, plus 0a's decision.
`takeover` V2/V3 and the `baton` dial ride the same machine afterwards.

**Phase 5 — the drill becomes the ship gate (§7), then features resume**
Only after the drill is green does feature work reopen — #5570 (Orca-standard balance bar, now
informed by 0c), #5525 color pass, W3 persistence (#5401 — largely free once herdr owns
sessions), overseer lens (#5397).

Rollback stance: none of this is a rewrite. Each phase replaces one seam's implementation behind
the same UI; the record layer is untouched throughout; any phase can ship alone and the app
remains usable between phases.

## 7. The drill (the only definition of "the surface works")

Scripted, run before every release that touches desktop/chat/handoff/crew code — a seam test,
because unit suites passing while seams fail is this project's most-repeated lesson:

1. Cold start: app open, `trantor open` hosts a session; chat renders it; composer live.
2. Send a multiline dictated-style message with an image path from chat → it arrives as ONE
   message, receipt confirms, reply streams back into chat.
3. Force a handoff (low test threshold) → every §5 state visibly traversed → successor RECAPS
   in chat → composer live again. No operator action required, nothing silent.
4. Kill and relaunch the app → chat rebinds to the live session without help (watcher + herdr
   report agree).
5. `trantor takeover` from a real Terminal session → conversation continues in the pane.
6. Version-skew check: hooks vs CLI vs app versions logged at drill start; mismatch = the drill
   says so (running sessions pin old hooks until restart — the skew must be visible, not
   discovered).

## 8. The fleet layer — what the salvage must NOT regress (added 2026-08-30)

The multi-LLM fleet is the moat's muscle and predates the one-surface pivot by months. The
salvage touches the ORCHESTRATOR's seams; the fleet layer below is working design, frozen
except where a phase names it. Verified live 2026-08-30 (`trantor provider list`):

**The roster and why each seat exists:**
- **claude** — the orchestrator harness itself (Sasha's Max plan) + the duty seat
  (`claude:trantor-duty`, pinned sonnet). Never a crew seat; it conducts, integrates, verifies.
- **codex** (OpenAI subscription) · **kimi** (Moonshot coding plan) — native-CLI seats,
  capped-subscription tier: marginal-cost-≈0 workers.
- **deepseek** (API) — the workhorse API seat; v4-pro for real work, flash only where the
  router's floor allows (#5482: hard NEVER routes flash/turbo/lite-class).
- **glm** (`glm:zai-coding-plan`, via opencode) — coding-plan seat, own bus label.
- **openrouter** (356 models, one key) — the BYOM on-ramp; sits LAST in every preference tier.
- **inception** (brought, diffusion LLM) — currently DOWN (#5481 max_tokens/null-output trap).
- **gemini** — RETIRED 2026-06-18 (Google killed the CLI). Not special-cased anymore: simply
  absent from the profile. `agy`/Antigravity remains an unbuilt optional seat.

**The architecture underneath (the WHY, in one breath):** heterogeneous models are the point —
lateral cross-review only works when reviewers fail differently. opencode is the universal
adapter (any provider-qualified model id = a seat with zero code change); the roster is DERIVED
(`discoverSeats(profile, opencode.json)` — T3, 0.17.47), never hardcoded; the advisor + scrooge
capability scores route by difficulty with cost-weights (hard 0.1 → strong-value picks); every
seat gets its own signed bus identity via per-spawn `RELAY_AGENT`/`RELAY_PROJECT`; seats work in
worktree-per-seat isolation (branch `seat/<agent>`) under difficulty-tagged contracts with a
testing gate and the bounce protocol for false-dones.

**The line the salvage must respect:** herdr's lifecycle authority (ownership table row 2)
applies to the INTERACTIVE orchestrator pane. Crew seats are HEADLESS RUNNER LOOPS
(`crew-runner.mjs` invoking `claude -p` / `opencode run` per contract) — for them, the bus
ledger + heartbeats + `seat-why` remain the health authority. Do not re-key seat truth to
herdr's agent detection; a runner loop is not an interactive agent, and herdr's view of those
panes is transient by nature. (P0a's integration install improves the interactive cases; it
does not replace the runner ledger.)

## 9. Claude Code native-overlap register (living — re-audit each CC release)

Trantor is 8 months old; CC has been absorbing capabilities we built externally. Rule: when CC
ships a native version of something Trantor does, we DELEGATE to native for Claude seats and
keep our layer where it covers the non-Claude fleet or the durable record — that is the moat
line, deliberately.

Known overlaps as of CC 2.1.228 (audited; see trantor-cc-2.1.215-compat memory):
- **Cross-session SendMessage/ListAgents (2.1.224)** — overlaps the wake-idle ladder for
  Claude↔Claude only; the duty seat already rides it (T3). Non-Claude seats, board state, and
  the overseer remain ours. Caveat: a bypassPermissions receiver holds messages unless the
  sender also bypasses (`crossSessionInbound: accept`).
- **Native SubagentStart/Stop with agent_id (2.1.215+)** — adopted 0.17.49; our cards enrich
  from native events. Open: subagent spawn cap REMOVED in .224 (board-flood guard wanted);
  `subagent-cost` may price the requested not the actual model.
- **Native handoff/compaction machinery** — CC compacts on its own (the silent-compaction
  incident); PreCompact hook is our only window. §5's machine must treat CC-initiated
  compaction as a first-class trigger, not only our own baton.
- **CC memory, plugins cache, sandbox, workflow scripts** — periodic compat audits are the
  discipline (two audits, two Trantor bugs found by reading CC changelogs against our source;
  the second was a permission bypass in our own hook).
- **Unhandled new events** — `DirectoryAdded`, `TaskCreated`/`TaskCompleted`/`TeammateIdle`:
  tracked, unadopted.
The register gets a line whenever a CC release lands something we half-own. Salvage phases must
check this register before building — never rebuild what CC now provides for Claude seats.

## 10. Keeping it on track

- Every PR/commit touching these areas names its ownership row ("row: transport") — a one-line
  discipline that forces the question "who owns this?" before code exists.
- No new side files, no new polls, no new keystroke paths without a table amendment first.
- Feature requests during phases 1–4 go to the board, not the tree. The sprint's lesson is that
  velocity against unowned seams is negative velocity.
- The record layer (hub, hooks, bus, board) is not part of this salvage and stays frozen except
  for the two hook touches phases 2 and 4 name.
