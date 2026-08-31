# Orca usage/rate-limit tracking — end-to-end mechanism (code read)

Read + written by a sub-agent; independently cross-checked against a second read (statusline,
OAuth endpoint, Fable scoping, reset-credit flow all confirmed twice).

Source: `/Users/sashabogojevic/development/trantor/.scratch/orca` (Electron/TypeScript). All
paths below are relative to that repo root unless given absolute. Read-only pass, no edits made.

## 1. Data sources per agent

### 1.1 Claude — three sources, ranked, one of them free

Claude usage has **three independent capture paths** feeding the same `ProviderRateLimits`
shape, tried in priority order by `fetchActiveClaudeRateLimits` (`src/main/rate-limits/claude-active-usage-fetch.ts:31-248`):

1. **Live statusline push (free, zero API calls).** Claude Code >= 2.1.80 pipes a `rate_limits`
   JSON blob into whatever command is configured as the terminal's `statusLine`, on every turn,
   piggybacked on the Messages API response. Orca installs a managed statusline script
   (`src/main/claude/statusline-script.ts:17-178`, sh and cmd.exe variants) that:
   - reads the piped JSON from stdin,
   - **skips the POST entirely if the payload lacks `"rate_limits"`** (`statusline-script.ts:103-106`, `:52-53` on Windows) — no wasted work most ticks,
   - throttles to one POST per pane per `CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS` = 15s (`src/shared/claude-statusline-rate-limits.ts:10`), tracked via a per-pane stamp file,
   - POSTs form-encoded `paneKey`, `configDir` (=`CLAUDE_CONFIG_DIR`, empty for system-default), `env`, `version`, and the raw `payload` to `http://127.0.0.1:$ORCA_AGENT_HOOK_PORT/statusline/claude` with header `X-Orca-Agent-Hook-Token`.
   - The exact JSON shape read out is `payload.rate_limits.{five_hour,seven_day}`, each `{ used_percentage?: number, utilization?: number, resets_at?: number|string }` — parsed by `parseClaudeStatusLineBody` (`src/shared/claude-statusline-rate-limits.ts:60-88`), which tolerates either `used_percentage` or the OAuth-shaped `utilization` field and either epoch-seconds or ISO-string `resets_at`, so a CLI schema drift degrades instead of going dark (comment at `:37`, `:42`).

2. **OAuth usage endpoint (the primary "at rest" poller).** `fetchClaudeOAuthUsage`
   (`src/main/rate-limits/claude-oauth-usage-request.ts:55-103`) calls
   `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>`,
   `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/2.1.0`, 10s timeout. Response
   shape:
   ```
   { five_hour?: {utilization|used_percentage, resets_at}, seven_day?: {...},
     fable_weekly?/fable_seven_day?/seven_day_fable?: {...},
     limits?: [{ kind, percent, resets_at, is_active, scope?: { model?: { display_name } } }] }
   ```
   The **Fable-scoped weekly window** is resolved by scanning `limits[]` for
   `kind === 'weekly_scoped'` with `scope.model.display_name.toLowerCase() === 'fable'` first,
   falling back through three legacy field-name variants (`mapFableWeeklyWindow`,
   `claude-oauth-usage-request.ts:35-53`) — evidence the backend field name changed at least once
   and Orca kept the old fallbacks rather than break on drift. (Dedicated coverage exists for
   this specifically: `src/main/rate-limits/claude-fetcher-fable-usage.test.ts` — worth mirroring
   as a targeted regression test in a transplant, since a scoped-limit-array miss silently drops
   the third bar rather than erroring.)

3. **CLI/PTY fallback (`/status` scrape).** When OAuth fails in a way that suggests a CLI-only
   session (`classifyClaudeOAuthUsageError`), or credentials are missing/stale, Orca spawns a
   hidden `node-pty` Claude CLI session and parses its `/usage` (or `/status`) TUI output with
   regexes: `SESSION_RE = /current\s*session/i`, `WEEKLY_RE`, `FABLE_LABEL_RE`, and
   `PERCENT_RE = /(\d{1,3})...%\s*(used|consumed|left|remaining|available)/i`
   (`src/main/rate-limits/claude-pty-usage-parser.ts:7-127`). It scans up to 12 lines after a
   section label for the percent, normalizes "left/remaining" into "used" (`100 - pct`), and also
   scrapes ANSI-stripped reset metadata. This is the only path that can be sync-called for the
   Fable weekly bucket if OAuth omits it (`fetchViaPty`, referenced by `claude-cli-usage-fetch.ts:42-46`).

The refresh plan itself (`resolveClaudeUsageRefreshPlan`,
`src/main/rate-limits/claude-usage-refresh-plan.ts:19-40`) always tries `oauth` first and appends
`cli` only if `allowCliFallback` and the runtime is plausibly available (host, or WSL with a
resolved Linux config dir). A **web** source is defined in the type union
(`UsageRateLimitSource`, `src/shared/rate-limit-types.ts:18`) but is explicitly `webDeferred: true`
today (`claude-usage-refresh-plan.ts:38`) — reserved, not implemented.

**Inactive/managed accounts** (accounts the user isn't currently signed in as, but has connected)
reuse OAuth-only, no PTY: `fetchInactiveClaudeAccountUsage`
(`src/main/rate-limits/claude-managed-account-usage.ts:34-104`) reads that account's
`credentials.json` off disk, refreshes the token if `isOauthTokenExpiring`, calls the same
`fetchClaudeOAuthUsage`, and optionally supplements from a "managed usage panel" fetch
(`fetchClaudeManagedUsagePanelSupplement`, not read in depth — same OAuth-usage shape).

### 1.2 Codex — three sources: RPC, PTY, ChatGPT backend

Same "live free channel first" instinct doesn't apply to Codex — no statusline equivalent — so it
relies on:

1. **`codex app-server` JSON-RPC over stdio** (preferred). `readCodexRateLimitsViaRpc`
   (`src/main/rate-limits/codex-rpc-rate-limit-probe.ts:73-278`) spawns the Codex CLI's app-server
   subprocess, sends `initialize` → `initialized` notification → `account/rateLimits/read`, and
   parses the JSON-RPC response's `result.rateLimits: { primary, secondary }` plus
   `result.rateLimitResetCredits`. Each window snapshot is `{ usedPercent, windowDurationMins, resetsAt }` (epoch **seconds**, converted `* 1000` in `mapCodexRateLimitWindow`, `codex-rate-limit-window-mapper.ts:16`).

2. **PTY `/status` scrape** (`codex-pty-rate-limit-probe.ts:26-236`): spawns the Codex CLI
   interactively, waits for a prompt (`/[>›]\s*$/`), sends `/status`, waits ~2.5s
   (`PTY_STATUS_NUDGE_MS`) then 500ms settle after the pattern is seen
   (`hasCodexPtyRateLimit`), parses with `parseCodexPtyStatus`. This is the CLI-availability
   fallback when the app-server RPC path errors or the binary can't run headless.

3. **ChatGPT backend usage API** (`codex-backend-usage-client.ts:59-102`): `GET
   https://chatgpt.com/backend-api/wham/usage` with ChatGPT session auth headers
   (`getCodexBackendAuthHeaders`). Response: `{ plan_type, rate_limit: { primary_window, secondary_window: { used_percent, limit_window_seconds, reset_at } }, rate_limit_reset_credits }`. Windows are classified session-vs-weekly by **duration**, not position: `classifyCodexRateLimitWindows` (`codex-rate-limit-window-classification.ts:27-75`) matches `windowDurationMins` against `CODEX_SESSION_WINDOW_MINUTES=300` / `CODEX_WEEKLY_WINDOW_MINUTES=10080` within a **1-minute tolerance**, falling back to legacy primary=session/secondary=weekly only if duration is absent — this defends against an app-server build reporting windows in the "wrong" primary/secondary order.
   This same backend endpoint is also used to **supplement a session window RPC/PTY missed**
   (`supplementCodexSessionWindow`, `codex-backend-usage-client.ts:104-134`, only fires if
   `!limits.session && limits.weekly`) and to fetch/consume rate-limit reset credits (§1.2.1).

Codex additionally reports `planType` (e.g. `"plus"`) straight from the backend payload — Claude
has no equivalent field.

#### 1.2.1 "Reset now" — exactly what it does

The Codex UI's "1 rate-limit reset available / Expires in 20d 9h / Reset now" flow:

- **Fetch available credits:** `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
  → `{ available_count, total_earned_count, credits: [{status, expires_at, granted_at}] }`,
  mapped by `mapBackendRateLimitResetCredits` (`codex-reset-credit-client.ts:100-126`). Also
  arrives inline on the RPC/usage responses (`rateLimitResetCredits` field) — three shapes
  (`RpcRateLimitResetCredits`, `BackendRateLimitResetCreditsResponse`) normalized into one
  `RateLimitResetCredits` type. This is a **purchasable/earnable inventory with expiry**, not a
  stateless button — the UI ("1 reset available · Expires in 20d 9h") renders an account asset,
  not a derived flag.
- **Consume ("Reset now" click):** `POST
  https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume` with body
  `{ redeem_request_id: <idempotencyKey> }` (`consumeCodexRateLimitResetCreditFromBackend`,
  `codex-reset-credit-client.ts:194-224`; 30s timeout, `REDEEM_BACKEND_TIMEOUT_MS`). Response
  `{ code }` maps to one of `reset|nothingToReset|noCredit|alreadyRedeemed`
  (`mapBackendConsumeOutcome`, `:178-192`) — this literally spends a limited resource on the
  backend, so:
  - **Idempotency ledger:** `CodexResetCreditCoordinator` (`src/main/codex-accounts/codex-reset-credit-coordinator.ts:52-248`) persists attempts via `CodexResetCreditLedger` keyed by a `randomUUID()` idempotency key, so a crash mid-request can be safely retried without double-spending — `consume()` checks `existing.state === 'settled'` and replays the cached outcome rather than re-calling the backend (`:69-88`).
  - **Scope validation before mutating:** `validateCodexResetCreditScope` re-checks the expected
    account/target still matches the *current* selection before the network call fires
    (`codex-reset-credit-coordinator.ts:242-247`), rejecting stale offers if the user switched
    accounts mid-flow.
  - **UI confirmation gate:** a `Dialog` ("Reset Codex limits?" / "This uses one Codex rate-limit
    reset credit for the active account and resets any eligible usage windows immediately.") with
    a "Don't ask again" checkbox precedes the mutation (`src/renderer/src/components/status-bar/StatusBar.tsx:1685-1723`).

### 1.3 Kimi — strictly read-only, never refreshes the token

`fetchKimiRateLimits` (`src/main/rate-limits/kimi-fetcher.ts:305-355`):

- Reads `<kimi home>/credentials/kimi-code.json` (WSL-aware path join at `:27-32`) directly off
  disk — **never touches the Kimi CLI's token refresh/rotation**. The doc comment is explicit
  about why (`:290-303`): "Orca must NEVER refresh or rewrite that file — a rotated refresh token
  would log out a live `kimi` session."
- **Two distinct failure states, two distinct UI outcomes — don't conflate them:**
  - Credentials file genuinely absent (`readCredentials` returns `{status:'missing'}`) →
    `fetchKimiRateLimits` returns `status:'unavailable'`, `error:'Not signed in to Kimi Code'`,
    **no** `usageMetadata.failureKind` (`kimi-fetcher.ts:317-319`). This routes to the roster's
    generic "not signed in" / Sign-in-CTA row state (`isConfirmedSignedOut`, §4.2).
  - Credentials file **exists** but `access_token` is present and `expires_at - now <= 5s`
    (`isAccessTokenFresh`, `:120-129` — Orca does **not** attempt a refresh here) → returns
    `status:'error'`, `error:'Kimi session expired — run kimi ..., then retry usage.'`
    (`expiredSessionMessage`, `:266-272`), and critically
    `usageMetadata: { failureKind: 'delegated-refresh-required', source: 'oauth' }`
    (`:331-335`). **Only this second case** is what produces "Run Kimi to refresh" — see below.
- If the token is fresh, it calls `GET ${KIMI_CODE_BASE_URL}/usages` (default
  `https://api.kimi.com/coding/v1`, overridable via `KIMI_CODE_BASE_URL` env, matching the CLI's
  own override var) with `Authorization: Bearer <token>` — **identical to the CLI's own usage
  call**, no extra headers (`:337-343`).
- Response shape: `{ usage?: {limit,remaining,used,resetTime|resetAt}, limits?: [{window:{duration,timeUnit}, detail:{...}}] }`. The top-level `usage` is treated as the **weekly** quota; per-entry `limits[]` carry `windowToMinutes()`-converted durations (seconds/minutes/hours/days), and the one closest to 300 minutes is chosen as the **session** window (`mapUsageResponse`, `:231-259`).

**"Run Kimi to refresh"** is a hardcoded UI string, not backend-driven, and fires on exactly one
condition: the renderer checks `usageMetadata.failureKind === 'delegated-refresh-required'`
**and** `provider === 'kimi'` (Grok shares the same failure kind and gets its own "Run Grok to
refresh" string) in `getDelegatedCliRefreshProvider`
(`src/renderer/src/components/status-bar/usage-error-copy.ts:67-76`), then renders
`translate(..., 'Run Kimi to refresh')` (`:84`) with tooltip body `"Run kimi in a terminal on the
computer running Orca and wait for it to start, then retry usage."` (`:135-139`). A truly missing
credentials file does **not** trigger this string — it triggers the ordinary sign-in prompt
instead. Grok is the only other provider using this same "delegated CLI refresh" pattern (its
token also lives in a CLI-owned file Orca won't touch).

### 1.4 Other providers (brief)

- **Gemini**: `src/main/rate-limits/gemini-usage-fetcher.ts`, endpoint
  `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` — Google Code Assist shared
  quota, OAuth token pulled from the Gemini CLI's own credential store
  (`gemini-cli-oauth-extractor.ts`). Reports `buckets[]` (named per-model, e.g. Flash/Pro) instead
  of a flat session/weekly pair.
- **Antigravity is not a real fetch** — it's a **relabel of a successful Gemini read**.
  `deriveAntigravityRateLimits(gemini)` (`src/main/rate-limits/antigravity-usage-mirror.ts:13-25`):
  if `gemini.status === 'ok'`, spreads the Gemini result with `provider: 'antigravity'`; on
  failure it synthesizes an Antigravity-specific error message rather than surfacing Gemini's raw
  error, because "Antigravity" and "Gemini CLI" share Google's backend quota but Orca never
  actually queries an Antigravity-specific endpoint (comment, `:3-6`).
- **OpenCode Go**: `src/main/rate-limits/opencode-go-usage-fetcher.ts`, endpoint
  `https://opencode.ai/_server` — cookie/session auth (`opencode-go-request-session.ts`), reports
  a `monthly` window (unified billing) rather than session/weekly.
- **MiniMax**: `src/main/rate-limits/minimax-fetcher.ts` +
  `minimax-request-context.ts:3-4`, `GET
  https://platform.minimax.io/v1/api/openplatform/coding_plan/remains`, cookie-jar auth via a
  dedicated Electron session partition `orca-minimax-rate-limit-fetch`
  (`minimax-request-context.ts:8`) with an explicit sensitive-cookie denylist for logging
  (`:9-16`). No CLI at all — pure cookie capture from the user pasting a session cookie in
  settings.
- **Grok**: `src/main/rate-limits/grok-fetcher.ts`, endpoint
  `https://cli-chat-proxy.grok.com/v1`; shares the `delegated-refresh-required` /
  "Run Grok to refresh" pattern with Kimi (§1.3).

## 2. Capture + storage

### 2.1 Hook server — one localhost HTTP server per Orca instance

`src/main/agent-hooks/server.ts` runs a single loopback HTTP server (implied by
`this.token`/`this.endpointDir` bootstrap around `:2600-2619`) shared by **all** agent hook
traffic (Claude/Codex/Kimi turn/prompt events) plus the statusline channel. Auth is a random
per-launch `X-Orca-Agent-Hook-Token` bearer header checked on every request (`:2627-2631`), with a
slowloris guard (`req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, ...)`, `:2636-2639`). Routing:

```
POST /statusline/claude  → parseClaudeStatusLineBody(body) → this.onClaudeStatusLine?.(event)  [server.ts:2644-2652]
POST <other pathnames>   → resolveHookSource(pathname) → normal agent-hook event pipeline
```

The statusline path returns `204` unconditionally (even on unparseable payloads) so the shell
script never sees a failure worth retrying (`:2649-2651`).

On startup the server **hydrates** any hook state persisted to disk
(`this.hydrateLastStatusFromDisk()`, `:2607-2609`) and **drains a spool** of hook events written
while Orca was closed (`drainAgentHookSpool`, `:2612-2619`) *before* binding the live listener, so
replay can't race a fresh POST.

### 2.2 `onClaudeStatusLine` → `RateLimitService.ingestLiveClaudeRateLimits`

`src/main/rate-limits/service.ts:1496-1553`. This is the load-bearing method:

1. **Attribution gate.** Requires a previously-captured `lastClaudeAuthSnapshot` (populated during
   a normal OAuth/CLI fetch cycle, `rememberClaudeAuthSnapshot`, `:1477-1493`) — a live post
   arriving before any fetch cycle has run is **dropped** with a `console.debug` breadcrumb
   (`:1499-1504`), not silently ignored, "so a silently dark live feed diagnosable."
2. **Cross-account guard.** If the posted `configDir` doesn't match the currently-selected
   account's snapshot `configDir`, the event is dropped (`:1507-1513`) — a background terminal
   signed into a *different* Claude account must not leak its quota into the active account's bar.
3. **Partial-update semantics.** A statusline payload can carry only `five_hour` or only
   `seven_day`; the missing one falls back to the previous value rather than being cleared
   (`:1520-1522`) — "absent means no update, not cleared."
4. **Dedupe window.** If the previous state is already `source: 'live-session'`, less than
   `LIVE_CLAUDE_INGEST_DEDUPE_MS` = 30s old, and both windows are byte-identical
   (`isSameUsageWindow`), the update is dropped entirely — no state write, no renderer push
   (`:1523-1531`). This is what keeps a 3-tick/second streaming statusline from spamming the
   renderer.
5. **fableWeekly is frozen** on live-session updates — the statusline payload has no Fable-scoped
   field, so the last OAuth-provided value is carried forward untouched (`:1541`, with an explicit
   documented tradeoff that it can go stale "until the session idles past the freshness window").
6. Writes `usageMetadata.source = 'live-session'`, resets the failure streak
   (`activeFailureStreakByProvider.claude = 0`, `:1532`), and calls `this.updateState(...)`
   (`:1533-1552`), which synchronously calls `pushToRenderer()`.

### 2.3 The poller that the live channel exists to avoid burning

Constants (`service.ts:76-100`):

| constant | value | purpose |
|---|---|---|
| `DEFAULT_POLL_MS` | 15 min | background poll cadence — "Claude's usage endpoint has a tight budget... prefer a recent snapshot over polling into 429s" |
| `MIN_POLL_MS` | 30 s | floor a renderer-set interval can't go below |
| `MIN_REFETCH_MS` | 5 min | debounce for resume/manual-refresh bursts |
| `ACTIVE_FAILURE_REFETCH_MS` | 30 s | retry cadence right after a failure |
| `MAX_ACTIVE_FAILURE_REFETCH_MS` | 15 min | backoff ceiling for repeated failures |
| `MAX_ACTIVE_FAILURE_STREAK` | 8 | cap on the backoff multiplier |
| `STALE_THRESHOLD_MS` | 30 min | generic "drop stale snapshot" threshold |
| `RATE_LIMITED_STALE_THRESHOLD_MS` | 24 h | Claude 429 windows can outlast the generic threshold — "quota is informational, a stale snapshot beats a bare Limited" |
| `LIVE_CLAUDE_INGEST_DEDUPE_MS` | 30 s | §2.2 step 4 |
| `INACTIVE_FETCH_DEBOUNCE_MS` | 60 s | debounce fetch-on-open for the inactive-account switcher |
| `INACTIVE_CODEX_PROBE_STAGGER_MS` | 2 s | each inactive Codex probe spawns a **real** codex process; staggered so opening the switcher doesn't burst-spawn every connected account at once |

`isLiveClaudeUsageFresh` (`service.ts:1452-1458`) is the actual gate: if the current state is
`status: 'ok'`, `source: 'live-session'`, and younger than `MIN_REFETCH_MS`, the automated poller
**skips the Claude fetch entirely** (`shouldSkipAutomatedClaudeFetch`, `:1460-1462`) — i.e. an
active streaming Claude session suppresses the OAuth poll outright, and a poll that fails while a
recent live post is fresher must not roll the bar back
(`resolveClaudeFetchApply`, `:1464-1475`).

`startTimer`/`setInterval` loop (`:822-830`): every `pollInterval` ms, if
`shouldBackgroundPoll()`, call `fetchAll()`. `setPollingInterval(ms)` clamps into
`[MIN_POLL_MS, MAX_POLL_MS]` (`normalizePollingInterval`, `:117-122`) and restarts the timer
(`:810-816`); it's invoked from the renderer via IPC.

The whole file is deliberately one 2,182-line module — its own top-of-file comment explains why a
lint `max-lines` exemption was taken: "centralizes polling, stale-data handling, account-switch
fetch semantics, and renderer push coordination in one place" (`service.ts:1`) — i.e. those four
concerns interlock tightly enough (a poll must know about live-freshness to skip itself; an
account switch must invalidate in-flight fetches; every mutation must reach the renderer) that
Orca's authors judged splitting it not worth the seam risk.

### 2.4 Persistence

Provider state lives **in-memory** in `RateLimitService` (`InternalRateLimitState`,
`service.ts:104-113`) — no on-disk cache of the usage numbers themselves was found in this pass;
what *is* durable is the reset-credit ledger (`CodexResetCreditLedger`, backed by `Store` /
`src/main/persistence`) and the agent-hooks spool/last-status file
(`this.lastStatusFilePath`, `service.ts:2601`, used for hook-event replay, not usage numbers).
Usage state is rebuilt each app launch by the normal fetch cycle; a fresh statusline post updates
it live thereafter.

Separately, a **historical usage/cost analytics subsystem** exists behind the same "Usage" naming
but is not part of this live rate-limit feed at all: `src/preload/usage-provider-api.ts:8-28`
exposes `{getScanState, setEnabled, refresh, getSnapshot, getSummary, getDaily, getBreakdown,
getRecentSessions}` factories shared by three IPC prefixes — `claudeUsage`, `codexUsage`,
`openCodeUsage` — each taking `{scope, range}` args. This is a local scan store over session
transcripts (spend/session history), wired to the `stats` Settings pane (§4.4), and is out of
scope for a rate-limit-tracking transplant (§6.7).

## 3. IPC + state

### 3.1 Main-process IPC surface (`src/main/ipc/rate-limits.ts:6-33`)

```
rateLimits:get                        → rateLimits.getState()
rateLimits:refresh                    → rateLimits.refresh()
rateLimits:refreshCodexForTarget      → rateLimits.refreshCodexForTarget(target)
rateLimits:consumeCodexResetCredit    → codexAccounts.consumeCurrentRateLimitResetCredit()
rateLimits:refreshClaudeForTarget     → rateLimits.refreshClaudeForTarget(target)
rateLimits:setPollingInterval         → rateLimits.setPollingInterval(ms)
rateLimits:fetchInactiveClaudeAccounts→ rateLimits.fetchInactiveClaudeAccountsOnOpen()
rateLimits:fetchInactiveCodexAccounts → rateLimits.fetchInactiveCodexAccountsOnOpen()
rateLimits:refreshMiniMax             → rateLimits.refresh()   [no dedicated MiniMax refresh — full refresh]
rateLimits:refreshGrok                → rateLimits.refreshGrok()
```

### 3.2 Push channel (main → renderer, unsolicited)

`pushToRenderer()` (`service.ts:2168-2181`) is called by every state mutation
(`updateState`, all the individually-named `*RateLimits` setters). It (a) calls any in-process
listeners registered via `this.stateListeners` and (b) `this.mainWindow.webContents.send('rateLimits:update', state)`. Preload exposes this as `window.api.rateLimits.onUpdate(callback)`
(`src/preload/index.ts:4790-4834`, listener registered/removed on `ipcRenderer.on/removeListener('rateLimits:update', ...)`).

### 3.3 Renderer wiring

`registerRateLimitIpcBridge` (`src/renderer/src/hooks/ipc-events/rate-limit-ipc-bridge.ts:4-30`)
subscribes to `onUpdate` immediately, **and separately** calls `window.api.rateLimits.get()` once
at startup as a fallback — with an explicit race guard: `receivedPushBeforeInitialSnapshot` — "a
push before resolution permanently wins" (`:15`), so a push that lands mid-flight never gets
clobbered by the stale startup snapshot resolving after it.

Zustand slice `createRateLimitSlice` (`src/renderer/src/store/slices/rate-limits.ts:18-152`)
holds the whole `RateLimitState` as one object, with optimistic `status: 'fetching'` writes on
`refreshClaudeRateLimitsForTarget`/`refreshCodexRateLimitsForTarget` before the IPC round-trip
resolves (`:63-91`, `:93-121`) — so a manual refresh shows a pulsing bar immediately, then the
final IPC response overwrites the whole state object again.

### 3.4 Shared wire type (`src/shared/rate-limit-types.ts:48-141`)

```ts
type ProviderRateLimits = {
  provider: 'claude'|'codex'|'gemini'|'opencode-go'|'kimi'|'minimax'|'grok'|'antigravity'
  session: RateLimitWindow | null       // 5h
  weekly: RateLimitWindow | null        // 7d
  fableWeekly?: RateLimitWindow | null  // 7d, Claude-only, model-scoped
  monthly?: RateLimitWindow | null      // 30d (OpenCode Go, Grok)
  buckets?: RateLimitBucket[]           // Gemini per-model
  rateLimitResetCredits?: {...} | null  // Codex only
  planType?: string | null              // Codex only
  updatedAt: number; error: string|null
  status: 'idle'|'fetching'|'ok'|'error'|'unavailable'
  usageMetadata?: { source, attemptedSources, failureKind, credentialSource,
                     authProvenance, deferredByLiveClaudeSession,
                     lastSuccessfulSource, retryAtMs }
}
type RateLimitWindow = { usedPercent: number; windowMinutes: number;
                          resetsAt: number|null; resetDescription: string|null }
type RateLimitState = {
  claude, codex, gemini, opencodeGo, kimi, antigravity, minimax, grok: ProviderRateLimits|null
  minimaxCookieConfigured: boolean; grokAuthConfigured: boolean
  claudeTarget, codexTarget: RateLimitRuntimeTarget   // {runtime:'host'|'wsl', wslDistro}
  inactiveClaudeAccounts, inactiveCodexAccounts: InactiveAccountUsage[]
}
```

This one flat object is the entire cross-provider contract — every UI surface (footer, popover,
per-agent panel, settings stats page) reads off this same shape, just filtered/sorted
differently. `usageMetadata.failureKind` (`missing-credentials`/`stale-token`/
`delegated-refresh-required`/`network`/`rate-limited`/etc, `rate-limit-types.ts:20-34`) is the
entire vocabulary every error string in the UI dispatches on (§4, §6.2) — worth keeping this
enum verbatim in a transplant rather than inventing a parallel one.

## 4. UI structure

### 4.1 Footer bar (`src/renderer/src/components/status-bar/StatusBar.tsx`)

`ProviderSegment` (`:1251-1331`) renders one provider's compact footer chip: icon
(`ProviderIcon`) + either a `VerboseProviderUsage` block (`:1175-1249`, default "verbose" mode —
this is what produces the operator's observed **"1% used 4h 49m · 40% used 2d 10h · 57% used
Fable"**, one `WindowLabel` per non-null window joined by `·`) or, in "compact" mode, just the
single **tightest** window (`getTightestUsageSection`,
`src/renderer/src/components/status-bar/UsageRosterPanel.tsx:57-70` — the section with the
*highest* `usedPercent`, so the footer always leads with whichever bucket is closest to a limit
even when the user displays "% left"). A stale-alert `AlertTriangle` renders when
`p.status === 'error'` but old data is still shown (`:1308`, `:1328`).

Window labels prefer a **live remaining-time countdown** over the fixed window name once
`resetsAt` is known: `formatRateLimitWindowChipLabel` (`src/renderer/src/lib/window-label-formatter.ts:43-51`) returns `formatResetDuration(resetsAt - now)` when available, else falls
back to the fixed `formatWindowLabel` (`wk`/`5h`/`1h`/etc, `:9-32`). A dedicated
`useResetCountdownClock` hook re-ticks this on a shared boundary-scheduled timer rather than a
per-row `setInterval` (`StatusBar.tsx:998`, `UsageRosterPanel.tsx:221-225`) — "one boundary-
scheduled clock keeps every open row current without per-provider timers."

Color thresholds are shared everywhere via `barColor`
(`src/renderer/src/components/status-bar/tooltip.tsx:191-199`) and the matching text-color
function (`usageTextColorClass`, `src/renderer/src/components/status-bar/usage-roster-formatting.ts:24-32`): **< 60% neutral, 60–80% yellow, ≥ 80% red** — identical breakpoints for the bar
fill and the percentage text so they never disagree.

Provider **visibility** in the footer is gated by three independent conditions per provider
(`StatusBar.tsx:2131-2160`): a per-provider user setting (`getVisibleUsageProvider`), the user's
status-bar item list (`statusBarItems.includes(...)`), and **CLI detection on PATH**
(`isStatusBarItemAvailable`) — except MiniMax and OpenCode Go, which are cookie/web-auth (no CLI
to detect) and skip the detection gate (`:2151-2152`, `:2157-2159`). Order rendered is fixed:
Claude, Codex, Gemini, Antigravity, OpenCode Go, Kimi, MiniMax, Grok
(`rosterProviders`, `:2202-2211`).

### 4.2 "Usage" popover (`UsageRosterPanel`, `src/renderer/src/components/status-bar/UsageRosterPanel.tsx:190-347`)

Opened from the roster trigger. Structure top to bottom:

1. Header: "Usage" title + "all agents" caption + a spinning `RefreshCw` refresh button
   (`:233-254`).
2. **Detailed/Compact segmented control** (`SettingsSegmentedControl<StatusBarUsageMode>`,
   `:258-287`) — "Detailed" = `verbose` (full bars + all window labels), "Compact" = `compact`
   (only the tightest window, no bar). This choice is a controlled prop
   (`statusBarUsageMode`/`onStatusBarUsageModeChange`) — persisted at the call-site as a normal
   settings value (`src/shared/status-bar-usage-mode.ts`), not local component state, so it
   survives popover close/reopen and app restart.
3. **One row per provider, worst-first**: `sorted = [...providers].sort((a,b) =>
   providerMaxUsed(b) - providerMaxUsed(a))` (`:227-229`) — the agent nearest a limit sits on top
   regardless of alphabetical/fixed provider order.
4. Each `UsageRow` (`:113-183`) shows icon, provider name + plan (Codex only,
   `formatPlanLabel`), and — in verbose mode — one `UsageMetric` chip per window (label + 28px
   mini progress bar + percent, `:83-111`) wrapped to a second line; in compact mode, just the
   tightest metric with no bar, right-aligned on the name row.
5. **A no-usage row is not a single generic state — it's a six-way ladder.**
   `getUsageRosterRowState` (`src/renderer/src/components/status-bar/usage-roster-row-state.ts:33-77`) returns one of `kind: 'usage'|'loading'|'sign-in'|'unavailable'|'error'|'empty'`, each with
   its own label ("Loading usage…", "not signed in", "Usage unavailable", "No usage data", or the
   real error's `getProviderUsageStatusLabel`). The sign-in CTA is deliberately conservative —
   `isConfirmedSignedOut` (`:20-31`) only fires on `failureKind === 'missing-credentials'` or an
   error string matching an explicit signed-out pattern list (`not signed in`, `logged out`,
   `authentication required`, etc, `:10-18`); **any other `failureKind` short-circuits to `false`**
   (`:26-28`) with the comment "credential refresh and network failures can mention auth while
   live sessions remain valid" — i.e. a transient token-refresh error must never be
   mis-presented as "click here to sign in again."
6. Footer: **"Usage details & history"** (routes to Settings pane `'stats'` —
   `handleUsageDetails`, `StatusBar.tsx:2218-2222`) and **"Manage Accounts…"** (routes to Settings
   pane `'accounts'` — `handleManageAccounts`, `:2213-2217`), each a full-width row with a
   trailing chevron.

### 4.3 Per-agent panel (`ProviderPanel`, `src/renderer/src/components/status-bar/tooltip.tsx:243-365`)

This is the drill-in shown from `ProviderDetailsMenu` (`StatusBar.tsx:1881-1907+`, rendered as
either a dropdown-menu submenu when embedded in the roster, or a standalone popover). Layout:

1. Header: icon + provider name, then **"Updated {formatTimeAgo(updatedAt)}"**
   (`tooltip.tsx:306`) — `formatTimeAgo` (`:35-46`) returns `"just now"` under 60s, `"{n}m ago"`
   under 60min, else `"{n}h ago"`. This is the literal source of the operator's observed "Updated
   just now."
2. **Codex-only reset-credit line**: "1 rate-limit reset available" / "{n} rate-limit resets
   available" (`:326-337`), plus **"Expires in {duration}"** / "Next expires in {duration}" via
   `formatResetCreditExpiry` (`:52-72`, wraps `formatResetDuration`).
3. Divider, then one `ProviderRateLimitWindowSection` per window from `getWindowSections(p)`
   (`:142-178` — returns `Session`/`Weekly`[/`Fable`][/`Monthly`], or Gemini's named buckets +
   `Weekly`): each is a labeled 6px progress bar plus a bottom row of
   `{percent}% used|left` (left) and **"Resets in {duration}"** (right, via
   `formatResetCountdown(resetsAt - now)`, only shown when `resetsAt` is known) — this is exactly
   the "Session/Weekly/Fable progress bars, Resets in …" the operator described.
4. If `p.error` is set, an `ErrorMessage` block renders below the windows, softened to "Refresh
   failed — showing cached data" when stale data is still visible (`ErrorMessage`, `:103-136`,
   `:356-362`).
5. The **account section / "Codex Account"** picker with per-account usage previews and a
   "Reset now" action sits *outside* `ProviderPanel` itself, as sibling `children` passed into
   `ProviderDetailsMenu` (`CodexSwitcherMenu`, `StatusBar.tsx:1333+`, confirm dialog at
   `:1685-1723`) — i.e. the panel component is provider-agnostic; the account-switch UI is
   provider-specific and composed on top.

### 4.4 "Usage details & history" and "Manage Accounts" destinations

Both route through `openSettingsTarget` + `openSettingsPage()` to the app's Settings surface, not
a separate window (`StatusBar.tsx:2213-2222`). "Usage details & history" opens Settings pane
`'stats'`, backed by `src/renderer/src/components/stats/{UsageOverviewPane,ClaudeUsageDetails,ClaudeUsageDailyChart,CodexUsageDetails,CodexUsageDailyChart,...}.tsx` plus the
`{claudeUsage,codexUsage,openCodeUsage}:*` IPC prefixes documented in §2.4 — a **separate**
historical-cost/session-log analytics system (a local scan store over transcripts, not the live
`RateLimitState`) confirmed out of scope for a rate-limit-tracking transplant. "Manage Accounts…"
opens Settings pane `'accounts'`, which hosts `UsageAccountsCard.tsx`
(`src/renderer/src/components/feature-wall/agents-orchestration/UsageAccountsCard.tsx:91-261`) —
a per-provider row (icon, name, connection pill, "Sign in" button) driving
`window.api.claudeAccounts.add()` / `window.api.codexAccounts.add()`.

Note: `src/renderer/src/components/feature-wall/agents-orchestration/UsagePage.tsx` looked like a
candidate for the real details page but is actually a **marketing storyboard animation** (onboarding
"feature wall" carousel) that fakes a Codex usage popover with hardcoded numbers and a timed
phase state machine (`Phase = 'reset'|'expanded'|'targeted'|'swapped'`, `:8-71`) — not live-wired.
Its layout is nonetheless a faithful mock of the real per-agent panel and confirms the visual
target (session bar red→green after account swap, weekly bar unaffected, "Codex Account" expand
arrow, "Switch to" account list with mini bars) if useful as a design reference.

## 5. Multi-account mapping ("Claude Account / System default")

`buildClaudeStatusSwitchGroups` (`StatusBar.tsx:447-512`) builds the switcher menu structure:

- One **group per runtime target** — always a `{runtime:'host', wslDistro:null}` group first
  (`:478`), then one group per **distinct WSL distro** that either has an active-account mapping,
  hosts a managed account, or was explicitly requested (`:480-497`), sorted with the default WSL
  target (`'__default__'`) pinned first (`:499-507`).
- Within each group, the **first entry is always `{ id: null, label: 'System default' }`**
  (`:462-467`), `active: activeId === null` — i.e. "use whatever `claude` on PATH is signed into,
  don't force a specific managed account." Every subsequent entry is a managed account labeled by
  `account.email`.
- Active-id resolution prefers the **runtime-scoped** setting over the legacy flat one:
  `settings.activeClaudeManagedAccountIdsByRuntime?.host ?? settings.activeClaudeManagedAccountId ?? null` (`:535-538`, and again at `:540-544` building the full per-runtime map) — a
  two-tier fallback for users who set up accounts before the WSL-scoped setting existed.
- `resolveClaudeStatusAccountState` (`:560+`) has an explicit remote-server override: "with a
  Remote Orca Server, local GlobalSettings describe this desktop, not the owner — the server
  snapshot wins" (comment at `:549`) — i.e. account state is **not** assumed to be local-only; a
  paired remote host's live `runtimeState` overrides local settings when
  `settings.activeRuntimeEnvironmentId` is set.
- Codex has the parallel `resolveCodexStatusAccountState` (`:550-558`) with the same remote-vs-
  local precedence rule.

Selecting a different account (or "System default") triggers `refreshClaudeRateLimitsForTarget`
(renderer slice, `rate-limits.ts:63-91`) which optimistically flips that provider's `status` to
`'fetching'` before the IPC round-trip, then calls
`rateLimits:refreshClaudeForTarget` → `RateLimitService.refreshClaudeForTarget` (main), which
re-resolves auth for the new target and re-runs the full §1.1 fetch cascade.

## 6. Transplant notes — minimal mechanism set for a Tauri/Rust + React app

Assumption per the brief: the target app already shells `claude`/`codex`/`kimi`, already reads
Claude's OAuth usage windows, the ChatGPT backend usage endpoint, and Kimi's quota API. So the
gap to close is specifically Orca's **plumbing**, not its data sources. In priority order:

1. **The statusline live channel is the single highest-leverage piece to copy.** It converts
   Claude usage from "poll a rate-limited endpoint" into "free, always-fresh, zero API calls,"
   and every other design choice in Orca (dedupe window, stale-freshness gating, "don't refresh
   the poller while live data is fresh") exists to protect and extend that free channel. Orca
   stopped treating the OAuth endpoint as the primary source specifically because it 429s under
   its own polling — that lesson is worth taking as given rather than re-learning. Minimum
   viable version for a Rust backend:
   - A managed `statusLine` command (shell script or a tiny Rust/Node one-liner) that reads stdin,
     bails if `"rate_limits"` isn't present, throttles with a per-pane last-post timestamp file,
     and POSTs (or, simpler in a Tauri app, writes to a local Unix socket / named pipe your Rust
     backend already owns) the raw JSON.
   - A local auth token check equivalent to `X-Orca-Agent-Hook-Token` if the channel is HTTP
     rather than a socket your process already trusts.
   - Parse exactly `payload.rate_limits.{five_hour,seven_day}` → `{used_percentage|utilization,
     resets_at}`, tolerant of either field name and either epoch-seconds/ISO string for
     `resets_at` (copy `parseClaudeUsageResetTimestamp`'s `>1e10` seconds-vs-ms disambiguation
     trick, `claude-usage-window.ts:11-16` — it's a neat one-liner worth lifting verbatim).
   - Gate ingestion on **account attribution**: don't apply a live post unless you know which
     account/config-dir it belongs to, and drop it if it doesn't match the active selection.
     This single check is what prevents cross-account quota bleed and is easy to skip by accident.

2. **State shape**: copy `ProviderRateLimits`/`RateLimitWindow` near-verbatim
   (§3.4) — it's already provider-agnostic and covers every window shape you'll need
   (session/weekly/fableWeekly/monthly/buckets), plus the `usageMetadata.source` field that lets
   the UI distinguish "fresh from a live push" vs "fresh from a poll" vs "stale but shown anyway."
   The `failureKind` enum (`missing-credentials`/`stale-token`/`delegated-refresh-required`/etc,
   `rate-limit-types.ts:20-34`) is what drives every UI error string — worth keeping that
   vocabulary rather than inventing a new one, since it maps directly to `usage-error-copy.ts`'s
   dispatch table. Pair it with the **row-state ladder** from §4.2
   (`usage|loading|sign-in|unavailable|error|empty`) — a flat "has data / doesn't" boolean loses
   the distinction that made Orca's empty states legible (e.g. never showing a sign-in CTA for a
   merely-transient network error).

3. **Poll-suppression logic is small and worth porting exactly**: `isLiveClaudeUsageFresh` +
   `shouldSkipAutomatedClaudeFetch` (§2.3) is ~15 lines and is the entire mechanism that stops the
   OAuth poller from fighting the live channel. Skipping this means you'll either burn your OAuth
   usage-endpoint budget redundantly or have the poller occasionally stomp a fresher live value.

4. **Reset-now for Codex needs the idempotency ledger, not just the two HTTP calls.** The GET/POST
   pair (§1.2.1) is trivial; the durability wrapper (persisted idempotency key, scope
   revalidation, "don't ask again" confirm gate) is what makes it safe to click twice or click
   while switching accounts. If the Rust backend already has a small KV store, a
   `(account_id, idempotency_key) -> outcome` table plus a pre-mutation scope check covers the
   same ground as `CodexResetCreditLedger`.

5. **Kimi/Grok "never refresh, tell the user to run the CLI" pattern is a policy choice, not a
   technical limitation** — worth deciding deliberately for the new app rather than defaulting
   into it. If the Rust app is willing to own Kimi's token refresh (rotating the file itself),
   it could do better than Orca here; if not, copy the exact behavior, including the **two-state
   split** (§1.3): genuinely-missing credentials get a plain sign-in prompt, an existing-but-
   expired token (5s freshness margin) gets the "run kimi to refresh" CTA — collapsing those into
   one generic empty state loses information the operator explicitly cares about.

6. **UI-wise**, the three-tier structure (compact footer chip → roster popover with
   Detailed/Compact density toggle → per-agent drill-in panel) is a clean, reusable hierarchy
   independent of Electron/React specifics and translates directly to a Tauri+React app: reuse
   `getTightestUsageSection` (worst-window-first summarization) and the shared 60/80% color
   breakpoints (`barColor`/`usageTextColorClass`) so the compact and detailed views can never
   visually disagree about urgency.

7. **Skip**: two subsystems are adjacent but out of scope for a rate-limit-tracking transplant —
   (a) the WSL-target multiplexing (`RateLimitRuntimeTarget`, per-distro account groups) and the
   remote-Orca-server precedence override (§5), which are specific to Orca's
   Windows/WSL/SSH-execution-boundary architecture (see `docs/reference/ssh-execution-boundary.md`
   in the Orca repo) and only matter if the new app also runs agents inside WSL distros or remote
   hosts with independently-synced settings; and (b) the historical usage/cost **analytics**
   subsystem (§2.4/§4.4 — the `{claudeUsage,codexUsage,openCodeUsage}` scan-store IPC family
   behind "Usage details & history") — a separate, larger local-transcript-scanning feature that
   answers "what did I spend this week," not "what's my current limit," and should be scoped as
   its own project if wanted at all.
