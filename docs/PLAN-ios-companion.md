# Trantor companion for iPhone and iPad: plan

Card #12079. Researched 2026-10-21 from the repo (hub routes, auth, desktop app), the Claude mobile docs and this Mac's toolchain.

## What it is, and why not Claude's Code tab

An operator console over the Trantor hub: decide what's blocking the fleet, see the board and feed, read and send bus messages, check seats and cost. The Claude app's Code tab mirrors one Claude Code session (cloud, or Remote Control of one session on a running computer). It has no fleet across projects, no non-Claude seats, no board, no level-3 file holds, no proposals or verify gates, no cross-seat messaging and no cross-provider cost. The first thing only Trantor can offer on a phone is decisions.

## Network

The hub is tailnet-only at `http://100.79.242.104:4477`. The device runs the Tailscale app; WireGuard encrypts the plain HTTP. Info.plist carries an ATS exception scoped to that host, not a blanket `NSAllowsArbitraryLoads`. No public relay: it would put the control plane for holds and permissions on the open internet.

## Auth

Every request is signed like `lib/identity.mjs` (lines ~293-320, verify ~389-402):

1. `ts` = Unix ms; `nonce` = 16 random bytes as 32 lowercase hex chars.
2. `path` = URL `pathname + search`, signed exactly as sent.
3. `hash` = lowercase hex SHA-256 of the exact body bytes; empty string for GET or an empty body.
4. Message = `trantor-v1\nMETHOD\npath\nhash\nts\nnonce` (UTF-8, no trailing newline).
5. Ed25519 signature of the message, no prehash (CryptoKit `Curve25519.Signing`).
6. Headers: `x-trantor-pubkey` (64 hex, raw public key), `x-trantor-sig` (padded base64), `x-trantor-ts`, `x-trantor-nonce`.
7. The hub rejects skew over 120s and repeated nonces: compute a clock offset from `/health`'s `Date` header.

Key storage: the Secure Enclave only does P-256, so the Ed25519 key's raw bytes live in the Keychain as a generic password, `WhenUnlockedThisDeviceOnly` (no iCloud sync), optionally Face ID gated for decisions.

Enrollment: the Mac's owner key calls `POST /invite` (`{"scopes":[{"project":"*","role":…}],"ttlSec":600,"kind":"human"}`) and shows the hub URL and token as a QR or `trantor://enroll?hub=…&token=…`; the phone generates its key and calls `POST /enroll` (`{"token","name":"ios-<device>","kind":"human"}`) signed with the new key. Remote TOFU is refused, so the invite is the only path. The identity name is the phone's mailbox for `/inbox`, `/poll` and `/send`.

## Hub API the app uses

Read: `/health`, `/projects`, `/catchup?project=`, `/tasks?project=&fields=slim`, `/card?id=`, `/events?project=&since=`, `/stream?session=&events=1` (SSE), `/inbox`, `/poll`, `/recent`, `/contracts`, `/peers`, `/holds`, `/verify-gates`, `/proposals?status=pending`, `/grants`, `/overseer/status`, `/claims`, `/balances?machine=`, `/economics`, `/handoffs`, `/_op?id=`.

Write: `/task/update` (move, note; done needs a drill line), `/task/checklist-toggle`, `/send` (reply to a relay ask with `re`), `/delivered`, `/verify-gate` (resolve), `/hold/decide` and `/proposal/decide` (owner today). Every POST carries an `_op` id so a retry after a dropped connection is safe, reconciled through `GET /_op`.

Local to the Mac (not on the hub): AskUserQuestion prompts (sidecar files answered by typing into the herdr pane), the handoff phase files, the Claude transcript, crew up/down, terminals, git and files. These need a Mac-side relay before a phone can see or act on them.

## Hub work this needs

- **Scope the event stream.** Done in #12112: each `/stream` entry carries the signer's read checks (`inboxReadable` for messages, `canRead` for events), so a narrow key sees only its projects live (`test/hub/test-stream-scope.mjs`).
- **An `approver` role** between write and owner, accepted by `/hold/decide` and `/proposal/decide`, so a phone never holds owner (which can delete projects and mint invites). Interim: `*:owner` with Face ID gating.
- **Push.** A device registry (`devices(pubkey, apns_token, env, bundle_id, name, created, last_ok, muted_projects)`), `POST /device/register|unregister`, and `hub/notifier.mjs` on `appendEvent` sending APNs (HTTP/2 + ES256 JWT, no new dependency) for `hold.opened`, `verify.gate.opened`, `proposal.filed`, messages to the operator, crew `presence.offline` and later `ask.opened`; a silent push on the matching `*.decided`/`resolved` clears the phone's notification (`collapse-id` = the item id). One push per transition, never a repeating warning. Needs a `.p8` key from the Developer account in the hub's env. Actionable buttons (Go/No-go, Approve/Deny) sign and POST from the app.
- **Pairing on the Mac:** the desktop app shows the invite as a QR.
- **Mac relay (v1.5):** publish `ask.opened`/`ask.answered` and handoff phases to the hub, and execute a phone's answer through herdr.

## v1

1. Pairing: scan the QR, generate the key, enroll, show health and scope.
2. Decisions (home): holds (Go/No-go), proposals (Approve/Deny + note), verify gates (Verified/Failed/Waived), relay asks (reply). Badge count.
3. Projects, with phase line and counts.
4. Board per project: lanes, card detail with log and messages; move, note, tick.
5. Feed: live over SSE, catch-up with `/events?since=`, filter chips.
6. Inbox: read and reply, message a seat.
7. Fleet: seats, presence, model, collisions.
8. Cost: provider balances, low-balance warning.
9. Settings: hub, identity, notification toggles and per-project mutes, re-pair, revoke.

Decisions are never optimistic: a tap shows pending until the hub answers (it returns 409 if the Mac decided first).


## Session chat from the phone (v1.1, cards #12130-#12133)

The operator asked to see the orchestrator's full chat and drive the project from the phone, like the Code tab in Claude's app. The conversation lives on the Mac (the Claude Code transcript), and only the desktop app may deliver a prompt into a session (`herdr::prompt`, the composer's path). So the desktop app is the relay; the hub is the meeting point; the phone never talks to the Mac directly.

**Hub (routes; scope = the project; the desktop signs as the operator's owner key):**

- `POST /session/chat` (write) `{project, session, total, turns:[{idx, role, blocks:[{kind, text, tool}], queued?}], meta:{working, model, context}}`: the desktop publishes turns decoded by `chat.rs` (never a second decoder), as a delta from the hub's `have`. The answer is `{ok, have}`. The hub keeps the last 400 turns per project in memory. A hub restart answers `have: 0` and the desktop resends its window. Not written to the event log.
- `GET /session/chat?project=&after=<idx>` (read): `{session, total, turns (idx > after, at most 200), meta, updatedAt, host}`, with an empty `turns` when nothing is newer.
- Stream: `chat.updated {project, total, working}` goes to `/stream?events=1` readers who can read the project. It is pushed live, never appended to the log (it would flood the FEED).
- `POST /session/prompt` (write) `{project, text (<= 8000 chars), _op}` answers `{id, status: "queued"}`, appends `chat.prompt.queued` (by the phone's identity, text truncated to 500) and pushes `chat.prompt {id, project}` live.
- `POST /session/prompt/claim` (owner) `{id, host}`: the first claim wins (200), later ones get 409.
- `POST /session/prompt/ack` (owner) `{id, outcome: delivered|blocked|not_ready|stalled|no_agent, error}` appends `chat.prompt.delivered` or `chat.prompt.failed`.
- `GET /session/prompt?id=` (read): `{id, status: queued|claimed|delivered|failed|expired, outcome, error}`. A prompt still queued after 120 s expires with "No Mac is relaying this project. Is the Trantor app open?".

**Desktop relay (`desktop/src-tauri/src/remote.rs`, runs while the app is open):**

- For every project whose orchestrator pane the app hosts (herdr seat kind `orch`), it finds the session with `orch_session_id`, tails the transcript with `TranscriptTail`, decodes new lines with the existing decoder, and publishes the delta. It checks the transcript's size every 1.5 s and does nothing when it is unchanged.
- It holds one `/stream?events=1` subscription. On `chat.prompt` for a hosted project, and once at startup for anything still queued, it claims the prompt, delivers it with the same function `pane_send` uses, then acks with the outcome.
- Delivery truth stays the transcript: the phone shows a sent message as delivered on the ack, and as seen when a user turn containing it arrives in the chat.

**Phone:** a project opens on Chat (with Board beside it). The history shows user and assistant turns, tool calls as one-line chips, a working indicator and context use. The composer sends via `/session/prompt` and shows queued, delivered and seen; a failure shows its reason. An AskUserQuestion in the session shows read-only with "answer it on the Mac" (answering from the phone is v2). Live updates come over `chat.updated`, with `after=` catch-up.

## Onboarding (v1.1, card #12129)

Pairing is a paged flow with the action pinned at the bottom of every page: Welcome, then Tailscale (a reachability check of the hub's `/health` that says "Turn on Tailscale" when it fails), then Scan (a custom AVFoundation scanner: continuous autofocus with near range, exposure bias down for screens, auto zoom from `minimumFocusDistance`, a torch toggle, and a hint line while it hunts; paste and Universal Clipboard as the fallback), then Name this device, then Done (the hub, the scope, and "Open Decisions"). The desktop's QR is shown large, with a full-screen option.

## v2

AskUserQuestion round-trip, a Live Activity for a handoff or turn in progress, a read-only chat transcript via the Mac relay, widgets, App Intents/Siri, card creation and reassignment, crew controls via the relay, an offline outbox, a Watch complication.

## Architecture

```
ios/
  project.yml            XcodeGen (commit this, not the .xcodeproj)
  App/                   entry point, notifications, deep links, Info.plist, entitlements
  Packages/
    TrantorCore/         Codable models, tolerant decoding (hub JSON is loose)
    HubClient/           Signer, HubAPI (one async method per route, _op ids), EventStream (SSE)
    TrantorStore/        @Observable stores fed by snapshot + SSE, cached last state
    Features/            Pairing, Decisions, Projects, Board, Feed, Inbox, Fleet, Settings
```

iPad: `NavigationSplitView` (sidebar Decisions/Projects/Feed/Inbox/Fleet, list, detail). iPhone: `TabView` with Decisions first. Minimum iOS 17. Bundle id `ai.trantor.companion` (not registered yet). Team `68KA9HJDSF`. Distribution through TestFlight.

The first test is a signature vector checked both ways: Swift signs fixed inputs and `lib/identity.mjs`'s `verifyRequest` accepts it, so signing drift fails a test instead of returning 401 at runtime.

## Decisions (made 2026-10-21, operator said build it all without asking)

1. Phone scope: the `approver` role (#12113). A phone key holds `*:approver`: it decides holds, proposals and gates, moves and notes cards, and can never delete projects, mint invites or import.
2. Push in v1 over APNs (#12114, #12123). Off until a `.p8` exists in the hub env (`APNS_KEY_PATH` or `APNS_PRIVATE_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`); no ntfy stopgap.
3. AskUserQuestion from the phone stays v2 (it needs the Mac relay).
4. Just the operator for now: Tailscale, bundle `ai.trantor.companion`, this repo.
5. iOS 17 minimum, iPhone and iPad.
6. Bundle id `ai.trantor.companion` (registered 2026-10-21 with Push and App Groups, plus `ai.trantor.companion.widget`).

## Look

The ibkr "stage" design (ibkr `ui/src/theme/tokens.css`, the Trading Dock Refit): `ios/Packages/TrantorDesign` holds the tokens, Geist and JetBrains Mono (bundled, OFL) and the components. Every screen is cards on the lit navy stage, mono for every number, mint for what needs a look.

## Build

Scaffold lives in `ios/` (card #12079). The `.xcodeproj` is generated and not committed.

```
cd ios && xcodegen generate
xcodebuild -project TrantorCompanion.xcodeproj -scheme TrantorCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build
# same with name='iPad Pro 13-inch (M5)'; replace `build` with `test` for the app tests
for p in TrantorCore HubClient TrantorStore; do (cd Packages/$p && swift test); done
node Packages/HubClient/Tests/verify-vector.mjs   # the hub's real verifier accepts the Swift signature
TRANTOR_WRITE_VECTOR=1 swift test                  # in Packages/HubClient: regenerate the fixture
```

Simulator drills (Debug builds):

- Sign ad hoc or the Keychain refuses the key: `CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=` on the xcodebuild line (unsigned builds get errSecMissingEntitlement).
- `-demo` runs on canned fleet data with no hub.
- `-enroll '<trantor://enroll link>' -name <device>` pairs without the system "Open in Trantor?" prompt. `trantor pair --json` mints the link (approver, ten minutes, single use).
- `-tab <decisions|projects|feed|inbox|fleet>` opens on a screen.

TestFlight (App Store app 6825307788, internal group "Operator", which gets every build): archive with Xcode's signed-in account, then upload. Bump CURRENT_PROJECT_VERSION for each upload.

```
xcodebuild -project TrantorCompanion.xcodeproj -scheme TrantorCompanion -configuration Release -destination generic/platform=iOS \
  -archivePath build/Trantor.xcarchive -allowProvisioningUpdates MARKETING_VERSION=0.1.0 CURRENT_PROJECT_VERSION=<n> archive
xcodebuild -exportArchive -archivePath build/Trantor.xcarchive -exportOptionsPlist <app-store-connect, team 68KA9HJDSF, automatic> \
  -exportPath build/export -allowProvisioningUpdates
asc builds upload --app 6825307788 --ipa build/export/Trantor.ipa --wait
```

Shipped: design system, all screens, the widget, QR pairing, Face ID before decisions, push registration and silent clears. Build 0.1.0 (1) is on TestFlight as of 2026-10-21. Still owed: the APNs `.p8` key on the hub, and a drill on a physical phone (camera, Face ID, push).
