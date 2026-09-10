# Contract: the desktop app front end (`desktop/src`)

The seams the React side holds. The design calibration is `docs/SYSTEM-CONTRACT.md` and the
memory's design-system note; `docs/CONTRACT-chat-streaming.md` and `docs/CONTRACT-ask.md` own the
chat's live seams in detail. This sheet is what the module comments used to restate. Incident
stories are on the cards named here.

## The client contract (`shared/api/client.ts`)

- Frozen the way `lib/identity.mjs` was: every view imports it and nothing else talks to a hub.
- The hub runs `RELAY_AUTH=enforce`, so every request carries the four signing headers.
  `EventSource` cannot set headers and macOS App Transport Security blocks cleartext HTTP from
  WKWebView, so signing, transport and the SSE stream (frame parsing, reconnect, backoff, `since`
  resume) all run in Rust; the webview only ever sees JSON.
- `inbox` reads with `peek=1`: the app is a viewer, and advancing the delivery ledger would hide
  mail from the receiving session's hooks. `delivered` is the explicit human ack for this
  endpoint, monotonic hub-side. `send` always carries `from` matching the signer.
- Economics keep notional (plan-covered) and real spend strictly separate. Balances are
  machine-local by nature; callers ask the local hub.
- `localSessions` is process truth plus every project whose orch pane herdr can still name an
  agent for (#6163). Transport failures are translated, never swallowed; an unknown one passes
  through verbatim.

## Shell and sidebar (`app/AppShell.tsx`, `app/projectActivity.ts`)

- The IA is scope: FLEET (Home, Inbox, Agents, Learning), PROJECT (Board, Feed, Chat), APP.
  Fleet telemetry lives on Home as cards; the balance strip is the one header exception (#5555).
- The project list comes from `known_projects` alone (pins plus checkouts) and REPLACES on each
  pull; bus traffic never adds rows. Fetched at mount and every 45s; a failed fetch never shrinks it.
- ACTIVE means "a terminal window is open and registered" (operator ruling). OPEN is process truth
  or a herdr-visible pane; BUSY is a hub heartbeat inside the 90s work window and blinks. The
  merge is pure in `projectActivity.ts`. Active rows sort mid-turn first and the group exists only
  when something is live. A BUSY row says what is true beneath its name (#5610); `blocked` is
  amber and never blinks (#6094).
- Wake (#6138, #6201): one call to `trantor open` through the frozen herdr bridge, idempotent;
  only the clicked row shows the in-flight state, then the outcome for a few seconds; wake-progress
  events keep rows current. The reboot-restore offer (#5401) runs at launch only, per the baton
  dial, and Resume is the same wake path.
- The unread badge counts direct messages minus locally seen ids (`shared/seen.ts`); the hub
  cursor is never advanced by a glance. The update check runs at launch and every 6h.

## Chat (`features/chat/*`)

- The chat renders the orchestrator's transcript and types into the pane the way a person would.
  Tool calls render as collapsed cards; a result fills its card in when it lands. The state
  machine is pure in `streaming.ts`: rows append only when a batch's `after` matches the cursor,
  a mismatch refetches via `orchestrator_chat`, whose `total` is authoritative.
- Status arbitration (#6146): the seed and the pushed stream race, so every update carries a
  `seq` assigned at dispatch (seed) or arrival (push), and the highest seq wins. The `orch-status`
  listener is registered and awaited BEFORE `chat_watch` is invoked; a bounded re-seed schedule
  fires only while the effective status is still closed. Every arrival traces itself.
- One `sync()` in flight at a time, globally; a request arriving mid-flight marks `pending`
  (#6094). A cursor mismatch on landing re-syncs from where the cursor now sits rather than merging
  overlapping reads. Cleanup awaits the instance's own `chat_watch` generation before unwatching,
  or a generation-less unwatch kills a later mount's watcher (#6113).
- Liveness is asked of the pane (`orchestrator_status`), never inferred from a pane row existing
  (#5477); `none`/`unknown` are the closed not-live set. Every composer input gates on it.
- Delivery receipts (#5504): a send is pending until a user turn CONTAINS it (trimmed; a `!`
  command is recorded without the bang; paths may survive as `[Image: source: <path>]` or a
  pathless placeholder, judged line-wise with a per-turn image budget; inline path spans get the
  same budget). Lost only after the window, then ONE mechanical retry at the turn boundary. A
  pending is judged and retried only against the project and pane it was sent to (#6250).
- Attachments (#6070) are chips below the text, never paths inside it; chips serialize at send
  into the shapes the receipts already know (one inline, several one per line, #5709). Drops are
  the composer's only when the topmost element is inside it and no modal sheet is open (#6147).
  Pasted images are written to a file by Rust and attached like a drop.
- AskUserQuestion (#6094): an open ask is the latest tool_use with no result, rendered only while
  status is `blocked`; an ask is never batched into a collapsed tool run; a click writes
  keystrokes into the pane through `ask_answer` (`pane.send_text`) and the card reflects what the
  transcript says happened. Keystrokes walk Down from row 0 then Enter; multi-select toggles with
  Space and is the weaker half of the contract until a live picker confirms it.
- Suggested-reply chips (#5929, #5993, #6702) are derived from the orchestrator's turns since the
  operator's last word, an open ask's options first, capped at three, never invented; a prose chip
  carries the sentence it came from. The chip gate traces the first failing input once.
- The handoff banner (#5509 W1) shows from the warning threshold and after "keep going" waits for
  another step of growth (an episode, not a timer). The offer, countdown and auto-fire need a live
  agent in the pane (#6668). The one action slot is stop while working, send otherwise (#5556).
- Stick-to-bottom follows new content only while already at the bottom (#6697). Reading size is
  a `--chat-scale` property with literal `calc()` classes. Preferences and pane widths read an
  injected store and decode bytes, never trust them.

## Code lens (`features/code/*`)

- A file opens editable, always; Changes is the open file wearing a HEAD-vs-editor diff on the same
  draft; save is a plain write (#5809, Orca's anatomy). Monaco is bundled locally, TS/JS language
  services muted, one theme (`monacoSetup.ts`); no language server (#6437).
- Tabs (#5813): identity is scope+path, a plain open is a preview the next open replaces, a pin is
  permanent, the dirty dot follows the draft. The document store (#5938) outlives the lens; a draft
  is stashed only after its document loaded and the view hydrated (`canStashDraft`). A draft with
  no base signature never produces a conflict verdict (`tabGuard.ts`).
- The mode pane (#5841) is one pane: Files | Git | Sessions | Chat, remembering its tab per
  project (#6499, config.json). A tab word never truncates: the strip measures twin buttons under
  the same cascade and steps to icons with hysteresis (#6036). Ghost text runs through the pure
  latest-wins gate (250ms debounce, in-flight cancel reaches Rust).
- The git panel (#5791) is VS Code's SCM shape against the selected seat's worktree; refusals land
  in the status line; there is no discard. Bulk actions send batched pathspecs.

## Workspace (`features/workspace/*`)

- The terminal pane is a client pty attached to herdr; the component reaches outside itself only
  through an injected `TerminalDeps` surface, and tests use `terminalDouble.ts`, never module mocks.
  WebGL is optional: hold the addon only if `loadAddon` accepted it and dispose it on a lost
  context. Multi-character input fragments buffer one beat and flush as one bracketed paste.
  Drops are ours only when the topmost element is inside the pane (#5949).
- A seat's activity (#5965): trust herdr when it actually looked (status present and screen
  detection not skipped), else the hub status the runner writes. The tab wears the state on the
  brand mark: pulse while working, amber and still when blocked, still when idle (#5890).
- Pane targets keep two identities apart: `agent` (the herdr pane name) and `brand` (what the
  mark reads). The record rail rests closed. Focus is the default pane view; grid is opt-in.
- Handoff and wake progress ride one invoke plus one event each, owned by Rust (#6081, #6201).
  Interrupted-session dismissals are durable and keyed on (project, session id) (#6476).
- `PaneBoundary` keeps a pane failure inside the pane with a retry that remounts only the pane.

## Fleet, Home, Inbox, Messages

- Balance chips and the usage roster are pure formatting over the `/balances` snapshot the strip
  already pulled; no second fetch. Semi-live: a snapshot older than 10 minutes triggers a real
  re-fetch through the CLI on the next tick. A gemini row is always a ghost and hidden. The six-way
  honesty ladder never shows a sign-in call to action, because this data plane cannot know
  credentials (#5570, Orca parity).
- Inbox holds only what needs an answer from the operator; agent-to-agent traffic lives in the
  project's Conversation. Staleness is computed from the work (referenced cards closed, or a newer
  message from the same sender), never from age or sender presence. Quick answers are blunt and few.
- Messages groups the event log client-side into DM threads per session pair and a broadcast
  thread per project; `hub:*` notices are not conversations and are rolled up, never rendered as
  chat. Any surface that renders a log rolls it up (`shared/rollup.ts`).
- Presence is defined once (`shared/presence.ts`): a fresh lastSeen means calling tools.
- Native notifications are narrow: a direct message to the operator, a verify gate opening, a
  crew seat failing, and the duty seat's healthy-to-dark edge once per episode. Proposals render in
  one module for Home, Overseer and the badge; an empty queue renders nothing.
- Drill Mode (#6800) walks the visual backlog on a disposable project; a DOM probe may pre-fill a
  verdict, the operator's press moves the card. The key, handoff and ask drills are inert unless
  their env var is set and are launched by the orchestrator, never the seat.
