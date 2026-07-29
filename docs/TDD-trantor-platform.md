# TDD — Trantor platform: identity, delivery, overseer, clients

*Technical design, 2026-07-29. Product: `PRD-trantor-platform.md`.*
*Phase 0 (§7–§9) is specified to implementable detail. Later phases are design-level.*

## 1. Problem

Three gaps, in dependency order:

1. **No authentication.** `/send` validates only that `from` and `text` are non-empty — `from` is
   self-asserted. Any local process can speak as any identity. Identity is also a *string* derived
   from CLI brand + project (`RELAY_AGENT` → `<agent>:<project>`), so a kimi orchestrator and a kimi
   crew seat are literally the same peer, and seats are already broadcasting under crossed labels.
2. **No delivery to an idle agent.** `hooks/inbox-deliver.mjs` (PostToolUse) reaches a *running*
   session; `hooks/stop-inbox.mjs` (Stop) reaches one *about to stop*. A session idle at its prompt
   fires no hooks and hears nothing. A human becomes the message bus.
3. **Nobody holds the landscape.** Two sessions in one checkout, or two repos with a real dependency,
   collide silently.

## 2. Goals / non-goals

**Goals.** Every request provably attributable to a keypair · agents as first-class identities with
their own keys · delivery to an idle agent through a channel its harness controls · a supervisor that
detects collisions mechanically · a remote hub and desktop/mobile clients.

**Non-goals.** Nostr protocol compatibility (see §7.1) · multi-tenant SaaS (one hub = one org) ·
replacing cmux · any mechanism that drives a process we do not own.

## 3. Key insight

**The hub may DECIDE; only a process we own may EXECUTE.**

This came from a concrete failure: the hub runs under launchd, and macOS TCC blocks a launchd job
from driving another app — `osascript … tell application "Terminal"` from that context hangs with no
output, while the same call from a session-spawned process returns instantly. We routed around it
with a detached child that kept the permission, shipped it, and removed it a day later because the
whole approach was unauthenticated RCE.

Generalised, that constraint is the architecture: **anything that must act inside an agent's session
runs inside that agent's own harness.** Today that is hooks. Tomorrow it is an ACP host that owns the
process. It is never something reaching across a boundary.

## 4. Architecture

```
┌─ hub (Node, always-on: launchd locally / systemd on the VPS) ────────┐
│   relay · event log · board state · identity + authz · overseer      │
└───────┬─────────────────────────┬────────────────────────┬───────────┘
        │ signed HTTP + SSE       │                        │
   ┌────▼─────┐            ┌──────▼──────┐          ┌──────▼──────┐
   │ hooks    │            │  acp-host   │          │  clients    │
   │ (in each │            │ (owns head- │          │ desktop     │
   │ session) │            │ less agent  │          │ mobile      │
   └──────────┘            │ processes)  │          │ ui.html     │
                           └─────────────┘          └─────────────┘
```

- **hub** stays the single source of truth. Clients are clients; nothing moves into the app.
- **acp-host** is `bin/crew-runner.mjs` grown up: it already holds a seat's process and runs a turn on
  a bus message. Replacing the bespoke protocol with ACP makes any ACP-speaking CLI a seat.
  It must **not** live in the desktop app — closing a window must not kill a running crew.
  It needs no TCC (subprocesses + stdio JSON-RPC), so launchd/systemd is fine.
- **hooks** remain the delivery path for *interactive* sessions, which are by definition not owned.

## 5. Delivery ladder (final)

| tier | when | mechanism | state |
|---|---|---|---|
| T1 | mid-turn | `inbox-deliver.mjs` PostToolUse → `additionalContext` | shipped |
| T2 | turn ending | `stop-inbox.mjs` Stop → `{"decision":"block","reason":…}` | shipped `cb97aea` |
| T3 | idle, harness-owned | acp-host `session/prompt` | **phase 3** |
| — | idle, interactive | *no mechanism. Accepted gap.* | by design |

All tiers share one delivery ledger (`deliveredUpTo`, `/inbox?peek=1`) so nothing is surfaced twice
and nothing is marked delivered that was never seen.

## 6. Data model additions

```
state.identities[pubkey] = {
  pubkey, name, kind: "human"|"agent", createdAt, lastSeen,
  enrolledBy,                  // pubkey of enroller, or "tofu"
  scopes: { "<project>": "owner"|"write"|"read" } | { "*": "owner" },
  revokedAt?                   // set, never deleted — audit
}
state.peers[session].pubkey    // binds a live session to an identity
state.orgPolicy = {
  autonomy: { "<project>": 1|2|3|4, "*": 1 },
  links: [ { projects: [...], reason, declaredBy } ]   // codependent repos (§10)
}
```

`state.peers` keeps its display name. **Identity is the pubkey; the label is cosmetic.** That alone
resolves the seat/orchestrator collision.

## 6b. Tenancy — `org_id` from day one (decided 2026-07-29)

Every scoped row carries an **`org_id`**, and there is a minimal `orgs` table, from the first
migration. Not because multi-tenant SaaS is a near-term goal — it is still a non-goal (§2) — but
because adding a tenant discriminator to an EMPTY schema is free, and adding it after 1,542 cards
and six Crebral projects have migrated is surgery on live data. Buzz reached the same conclusion
the expensive way: their multi-tenant spec exists precisely to collapse a relay-per-community
boundary into a row-level one after the fact.

```
orgs(id, name, created_at, owner_pubkey)
org_members(org_id, pubkey, role)              -- role: owner|admin|member
<every scoped table>.org_id                    -- events, tasks, messages, peers, gates, …
```

Identity scoping becomes two levels: **org** (who you are with) and **project** (what you may
touch). Phase 0 shipped project scopes; this adds the level above.

## 6c. Cross-machine collision detection is a DIFFERENT implementation

The overseer's cheapest, most certain local signal — *same git root, two live sessions* — is
**local-only and does not transfer to teams.** Agents run on each developer's own machine against
their own clone; there is no shared filesystem to compare. The hub carries messages, cards,
presence and events — never code, never a working tree.

Cross-machine signals, in priority order for the same-repo case (two people, one repo — the
Sasha/Julian pilot):

1. **Declared file intent — build this first.** Hooks already parse tool input (`todo-sync` does it
   for TodoWrite), so a PostToolUse hook can publish *"session X is editing `<path>`"* as an event.
   A peer's session is then warned that someone touched that file seconds ago. Mechanical,
   cross-machine, and needs no GitHub. **This is the teams feature.**
2. **Git remote state** — branches, pushes, open PRs on the shared remote. Good for "already
   pushed", useless for "editing right now".
3. **Card claims** — coarse; exists today; weakest.

Privacy note: a file *path* is far less sensitive than file *content*, but it is still codebase
structure — it must obey the same org/project scoping as everything else.

## 6d. Team authentication — GitHub device flow (design)

For teams, humans authenticate with **GitHub's device flow** (the `gh auth login` pattern: CLI
prints a code, user pastes it in a browser), **not web OAuth** — web OAuth needs a public callback
URL, which would force the hub onto the public internet and discard the tailnet posture.

GitHub login authenticates the **human**; the Ed25519 keypair still authenticates the **session**.
It replaces the invite *token* as the proof, not the enrollment mechanism: "prove you are @julian"
binds that machine's pubkey to that identity. Agents keep their own keys regardless.

`resolveProject()` already keys off the git repo root, so `github.com/org/repo → project` is a
natural join and repo collaborators make a sensible **default** roster — but only a default: a
project may span repos (crebral-cortex + crebral-health are one program, two repos) and a
collaborator may not need board access.

*Not built for the pilot.* One friend needs `trantor invite` + `trantor enroll`, which shipped in
Phase 0. Device flow is a scale feature.

## 7. Phase 0 — identity and authentication

### 7.1 Scheme: Ed25519, native, zero dependencies

`crypto.generateKeyPairSync("ed25519")` and `crypto.sign/verify` are in Node core. Buzz uses
secp256k1 Schnorr because Nostr requires it; we chose not to build on Nostr (see PRD §7), so we take
the simpler primitive and add no crypto dependency to a project whose whole character is one Node
process and a JSON file.

**Tradeoff, stated so it is a decision and not an accident:** this forecloses drop-in Nostr interop.
Mitigated by keeping every primitive behind `lib/identity.mjs`, which can gain a second scheme
without touching call sites.

### 7.2 Key storage

`~/.agent-bus/keys/<safe-name>.json`, mode **0600**, `{ pubkey, privkey, name, kind, createdAt }`.
Directory created 0700. Never logged, never sent, never placed in a card or event.
*Future:* macOS Keychain via the desktop app. Humans must never handle raw key material — the Buzz
onboarding (paste your nsec, device-bound, sign-out destroys it) is an explicit anti-pattern here.

### 7.3 Request signing

Canonical string, newline-joined, signed with the private key:

```
trantor-v1
<METHOD>
<PATH+QUERY>
<sha256(body) hex, or "" for no body>
<unix-ms timestamp>
<nonce: 16 random hex>
```

Headers: `x-trantor-pubkey` (hex), `x-trantor-sig` (base64), `x-trantor-ts`, `x-trantor-nonce`.

Hub verification, in order: signature valid → `|now - ts| ≤ 120s` → nonce unseen (LRU, 10k entries,
evict past the skew window) → identity known and not revoked → scope permits this endpoint+project.

### 7.4 Enrollment

- **Local / trust-on-first-use.** First run generates a keypair and `POST /enroll` with a name. The
  hub accepts unknown pubkeys **only** when bound to loopback *and* `RELAY_ENROLL=tofu` (default
  locally). Records `enrolledBy: "tofu"`.
- **Remote / invite.** `trantor invite --name … --scope <project>:<role>` mints a single-use token
  (32 bytes, 24h TTL). `POST /enroll` with `{token, pubkey, name}` binds it. TOFU is **refused** on a
  non-loopback bind — a remote hub never auto-trusts.
- **Agents.** `bin/crew-runner.mjs` mints a keypair per *seat instance* at spawn and enrolls it with
  `kind:"agent"`, scoped to that project only. Two kimi seats in one project are now two identities.

### 7.5 Rollout modes — `RELAY_AUTH`

| mode | behaviour |
|---|---|
| `off` | no verification (escape hatch only) |
| `warn` | verify if present; unsigned accepted, logged, and flagged on the peer record — **default for one release** |
| `enforce` | unsigned or invalid → `401` |

A non-loopback bind **refuses to start** in `off` or `warn`. Local default is `warn`, so existing
long-lived sessions keep working across the upgrade; remote is `enforce` by construction.

### 7.6 Endpoint policy

| endpoints | requirement |
|---|---|
| `/send` `/task` `/task/update` `/focus` `/status` `/register` `/handoff` `/lesson` `/verify-gate` | valid signature; `write` on the target project |
| `/project/delete` `/sweep` `/reconcile` | `owner` on the target project |
| `/peers` `/tasks` `/events` `/inbox` `/peer` `/card` `/stream` | signature required in `enforce`; results **scope-filtered** to projects the identity can read |
| `/enroll` `/` (ui) `/health` | unauthenticated by necessity |

`/send` additionally requires that `from` **matches the signing identity**. That single check is what
closes the hole found on 2026-07-28.

## 8. Phase 0 — file-by-file

| file | change |
|---|---|
| `lib/identity.mjs` | **NEW.** `generate()`, `load(name)`, `loadOrCreate(name,kind)`, `canonicalString()`, `sign(req)`, `verify(headers,method,path,body)`, `pubkeyOf()`. No I/O beyond the key file. |
| `lib/signed-fetch.mjs` | **NEW.** `sfetch(url, opts, identity)` — drop-in `fetch` that signs. One call site shape for every client. |
| `hub.mjs` | identity store + `authenticate(req,body)` + `authorize(identity, endpoint, project)`; `RELAY_AUTH` modes; `POST /enroll`; refuse non-loopback bind unless `enforce`; scope-filter reads; `/send` binds `from` to the signer. |
| `mcp.mjs` | `api()` routes through `sfetch` with the session identity. |
| `hooks/lib/api.mjs` | **NEW.** shared signed-POST helper; `heartbeat`, `inbox-deliver`, `stop-inbox`, `prompt-focus`, `todo-sync`, `precompact`, `subagent-*`, `agent-notify`, `handoff-now` all move onto it. Fail-open on hub-down is preserved. |
| `bin/crew-runner.mjs` | per-seat keypair at spawn; enroll `kind:"agent"`; drop `RELAY_AGENT`-derived identity for the *identity* (keep it as display label). |
| `bin/cli.mjs` | `trantor identity [show|rotate]`, `trantor invite`, `trantor enroll <token>`. |
| `test-identity.mjs` | **NEW.** see §9. |
| `test-inbox-delivery.mjs` | extend: signed requests accepted, unsigned rejected under `enforce`. |

## 9. Phase 0 — acceptance

Deterministic, and every one of these must be an executed test with real output:

1. valid signature accepted; tampered body, tampered path, wrong key, expired ts (>120s), replayed
   nonce → each **rejected**.
2. `enforce`: unsigned request → `401`. `warn`: unsigned accepted **and** flagged on the peer.
3. `/send` with `from` ≠ signer → **rejected**. *(The 2026-07-28 hole, as a regression test.)*
4. non-loopback bind + `RELAY_AUTH=warn` → **process refuses to start**.
5. TOFU enroll works on loopback; **refused** on a non-loopback bind.
6. invite token: single-use, expires, binds the declared scopes.
7. two seats of the same brand in one project → **two distinct identities**. *(The crossed-label bug.)*
8. read scope-filtering: an identity with `read` on `A` only sees `A` in `/tasks`, `/events`, `/peers`.
9. key file is **0600**; private key never appears in any response, event, card or log.
10. hub down → hooks still exit clean and never block a tool call (existing contract preserved).
11. full suite `EXIT 0`.

## 10. Phase 1+ — design level

**Remote hub.** Postgres replaces `bus.json` (the teams SQLite `store.mjs` already loses
verifyGates/balances/handoffLog/aliases/phaseMeta/focus on restart — unacceptable for always-on).
Caddy for TLS on NetCup. The event log is the natural table; board state is a projection.

**Desktop client.** Tauri 2 + React. Sidebar Inbox / Agents / Projects(sections) / Settings; channel
body = BOARD + FEED. Subscribes to `/stream?events=1`. Native notifications from typed events
(`message`, `handoff.written`, `verify.gate.opened`, crew failure). Steal Buzz's **harness detection**
screen — the engine already exists (`discoverSeats`/`buildRoster`, `trantor provider`, `trantor models`,
`trantor doctor`); only the UI is missing. `ui.html` keeps being served until the app is better; no
flag day.

**acp-host.** Spawn N agent subprocesses; ACP `initialize` → `session/new` → on queued events for a
project, drain into one batched `session/prompt`; one prompt in flight per project; respawn on crash;
reconnect with `since`. Adapters exist today: `@agentclientprotocol/claude-agent-acp`,
`@zed-industries/claude-code-acp`.

**Overseer.** Subscribes to the event log. **Detection is mechanical and free:** same git root + two
live sessions (certainty); same files in flight (cards + git status); declared `orgPolicy.links`;
inferred dependency via Demerzel `get_deps`/`find_importers`. **The LLM only narrates** — why they
collide and what to do — on a cheap model via Scrooge, citing paths and SHAs. Warnings ride the
existing `SessionStart` context injection. Enforcement follows the autonomy ladder; at level 3 a
collision opens a **`relay_verify_gate`**, which already emits `verify.gate.opened`/`.resolved` and
already renders on the board — the go/no-go UI is an existing primitive, not a new one.

## 11. Rollout

| phase | ships | gate |
|---|---|---|
| **0** | identity + auth (`warn`) | §9 all green |
| 0.1 | flip local to `enforce` | one release of `warn` with no unsigned traffic in logs |
| 1 | Postgres + remote hub on NetCup, `enforce` | restart-survival of all state fields |
| 2 | desktop client to parity, native notifications | side-by-side with `ui.html` |
| 3 | acp-host; crew seats migrate; T3 delivery | a seat completes work driven only by ACP |
| 4 | overseer at levels 1→2; then 3 with mobile | zero false-positive collisions over a week |

## 12. Decisions (settled 2026-07-29) + remaining question

### 12.1 DECIDED — multi-hub client, single-hub project
The client connects to **several hubs**, shown as sidebar sections. But **a project lives on exactly
one hub, and codependent projects MUST share one.** There is **no merged view.**

*Why:* collision detection and lateral review only work over work on the same hub. Split the hub and
the overseer goes blind precisely at the boundary between two teams — which is where collisions
happen. A merged view is worse than separate ones because it implies cross-hub detection that cannot
exist.

*Consequence, and the reason to decide before Phase 1:* **`RELAY_URL` becomes per-project config, not
one global value.** Cheap now, miserable to retrofit.

*Migration:* the **Crebral umbrella moves to the remote hub as a unit** — `crebral-health`,
`crebral-cortex`, `crebral-legal`, `crebral`, `crebral-scribe`, `crebral-health-ios` (85% of the
board, and the interdependent cluster). Projects with no cross-dependencies may stay local.

### 12.2 DECIDED — protect at the access layer, do not redact content
Audited the live board 2026-07-29 (1,542 cards / 109 message events):

| surface | finding |
|---|---|
| prompt-derived card titles (102, 6.6%) | **zero** emails, digit-runs, key-like tokens, home paths, URLs, person-names |
| message text | **zero** real credential-shaped strings; the "key-ish" hits were the *words* key/token |
| 18 "PHI-term" messages | domain **vocabulary** (`patientId` as a variable), not patient data |

So titles are benign and need no gate. The genuine sensitivity is different: messages carry
**unpatched vulnerability disclosures for a live healthcare product** (e.g. a service-role insert
accepting a caller-supplied `patientId`) — an attack map for crebral.health.

**Therefore: do NOT redact or summarise.** The overseer and lateral review need exactly that detail;
a summary of a vulnerability finding is worthless. Redaction optimises the wrong variable and breaks
the product.

**Protect at the access layer instead — the machinery Phase 0 already shipped:** scope-filtered reads
(a member sees only projects they are scoped to), plus TLS in transit, encryption at rest on the VPS,
and a **time-based** retention policy for a shared hub (the log is currently capped by count, 20k).

**One hard rule, enforced in code:** a credential-shaped string must never reach the bus. Today there
are zero; one `sk-…` pasted into `/send` would be replicated to a server and live in an append-only
log forever. Client-side scrubber on send — cheap, and the one unrecoverable failure.

*Threat model, stated:* the remote hub is the user's **own VPS**, not a third party. The adversary is
server compromise and, later, an over-scoped teammate — not a vendor.

### 12.3 STILL OPEN
Do interactive sessions ever migrate into the app (owned, hence T3-capable), or stay in Terminal
forever? The accepted delivery gap in §5 is only acceptable while the answer is "stay".
