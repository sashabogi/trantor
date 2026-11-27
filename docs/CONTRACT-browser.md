# Contract: the in-app browser (card #14489)

The design is artboard 21 on the 2.0 canvas, mirrored at `docs/design/v2/Browser.dc.html`. This
contract fixes the seams so the Rust core, the Browser tab and the agent tools can be built apart.

## Shape

- One browser per project. It is a child webview of the main window (Tauri `unstable` feature,
  `Window::add_child`), or, when popped out, its own `WebviewWindow` labelled `browser-<project>`.
- One page per project in the first build. Multiple pages (the page strip, section D of the
  artboard) come later and must not change the commands below: they gain an optional `page` id.
- macOS uses WKWebView (spike 2, card #14489 notes). Windows uses WebView2 the week of 2026-11-30
  (docs/PLAN-windows.md); every command here must be implementable on both, so no WebKit-only
  shapes leak into the API.
- Cookies and sign-ins persist per project across launches (a persistent data store keyed by
  project, under the app data dir). User agent: a current Safari string on macOS.

## Tauri commands (Rust, `desktop/src-tauri/src/browser/`)

All take `project: String`. Rects are logical pixels relative to the main window's content.

| Command | Args | Returns |
|---|---|---|
| `browser_open` | `url: Option<String>`, `rect: Rect` | `BrowserState` |
| `browser_set_rect` | `rect: Rect` | `()` |
| `browser_set_visible` | `visible: bool` | `()` |
| `browser_navigate` | `url: String` | `()` |
| `browser_back` / `browser_forward` / `browser_reload` | | `()` |
| `browser_pop_out` | | `()` (opens or focuses `browser-<project>`, remembers its frame per project) |
| `browser_put_back` | `rect: Rect` | `()` |
| `browser_close` | | `()` |
| `browser_state` | | `BrowserState` |
| `browser_take_over` / `browser_give_back` | | `()` |

`Rect { x: f64, y: f64, w: f64, h: f64 }`.

`BrowserState { project, url, title, loading: bool, can_back: bool, can_forward: bool,
popped_out: bool, driver: Option<Driver>, held_by_user: bool }`.

`Driver { session: String, label: String, action: String, since: u64 }`: `label` is what the
driving line names ("orchestrator", "codex-8"); `action` is the current step in words
("clicking \"Show descendants\"").

Event `browser://state` carries a `BrowserState` on every change (navigation, load start/finish,
title, driver change, take over, pop out/put back). The tab renders from events, never polls.

Event `browser://ask` carries `{ project, id, session, label, host }` when an agent wants a host it
has not been allowed; answered with `browser_answer { id, choice: "once" | "site" | "deny" }`.
Localhost, 127.0.0.1 and the project's own preview ports never ask. Allowed hosts persist per
project.

## The agent socket

The app listens on a Unix socket `<bus>/browser.sock` (`<bus>` = `AGENT_BUS_DIR` or
`~/.agent-bus`), mode 0600, created at startup, removed at quit. One JSON object per line each way:

Request: `{ "id": "<uuid>", "session": "<relay session id>", "label": "<display name>",
"project": "<project>", "op": "<op>", ...args }`.
Response: `{ "id": "<same>", "ok": true, ...result }` or `{ "id", "ok": false, "error": "<code>",
"message": "<words>" }`.

| op | args | result |
|---|---|---|
| `open` | `url` | `{ url, title }` (opens the Browser tab if hidden) |
| `read` | `max_chars?` | `{ url, title, text, outline: [{ ref, role, name }] }` |
| `click` | `ref` or `selector` or `{x,y}` | `{}` |
| `type` | `ref` or `selector`, `text`, `submit?` | `{}` |
| `scroll` | `dy` | `{}` |
| `screenshot` | `element?` (`ref`) | `{ path }` (PNG under `<bus>/browser-shots/`) |
| `state` | | `BrowserState` |

Error codes: `no_app` (socket absent, raised by the client), `held_by_user` (the operator took
over: the agent waits and retries on `browser://state` change, never forces), `denied` (host not
allowed), `waiting_for_approval` (an ask is open), `not_found` (ref or selector), `timeout`.

Every op sets `driver` for its duration plus a short linger (2 s) so the driving line does not
flicker between steps, and appends to the Steps list. While `held_by_user` is true every op except
`state` returns `held_by_user`.

`outline` refs are stable for one page load: the core injects a script that tags interactive
elements (`data-trantor-ref`) and returns role and accessible name. A navigation invalidates refs.

## Agent tools (relay plugin, later card)

The relay MCP server exposes `browser_open`, `browser_read`, `browser_click`, `browser_type`,
`browser_scroll`, `browser_screenshot` by speaking the socket protocol. Sessions on another machine
(netcup seats) get `no_app` until the hub route lands (later card).

## Out of scope for the first build

Multiple pages, downloads, file uploads, DevTools, extensions, the hub route for remote seats,
visual baselines.

## Wave 2 (B3, B4, B5), added 2026-11-26

Everything above stays valid. Additions are backward compatible: every command and socket op gains
an optional `page` (absent = the active page).

### Departures from wave 1 the build settled

- `once` lasts for the visit to that host (until the page leaves the host or closes); `deny`
  answers only the next op. `browser_steps(project) -> Step[]` and the event
  `browser://reveal { project }` exist. Error codes add `bad_request` and `unsupported`. A click
  point is `{ "x", "y" }` at the top level. A blank page is hidden and reports `url: ""`.
- Rects are DOM coordinates; the macOS backend adds the window's title-bar inset itself.

### Pages

`BrowserState` gains `pages: [{ id, url, title, loading, driver }]` and `active_page: String`
(`""` when none). The top-level `url`, `title`, `loading`, `driver`, `can_back`, `can_forward`
describe the active page, so wave 1 readers keep working.

| Command | Args | Returns |
|---|---|---|
| `browser_new_page` | `url: Option<String>` | page id (becomes active) |
| `browser_close_page` | `page: String` | `()`; closing the last page = Nothing open |
| `browser_select_page` | `page: String` | `()` |

Only the active page is shown; the others stay alive, hidden. Pop out moves the whole page set.
A page an agent opens with `new_page` is named in the page strip by its driver. A site's
`window.open` / `target=_blank` opens a new page (sign-in popups included) instead of replacing the
current one; the popup page closes itself when the site calls `window.close()`.

### B5 commands

| Command | Args | Returns |
|---|---|---|
| `browser_zoom` | `level: Option<f64>` (`None` = reset to 1.0), clamped 0.3 to 3.0 | `()` |
| `browser_find` | `text: String`, `backwards: bool` | `{ found: bool }` |
| `browser_find_clear` | | `()` |
| `browser_inspect` | | `()` (opens Web Inspector for the active page) |
| `browser_set_user_agent` | `preset: Option<String>` (`None` = default Safari) | `()` reloads |
| `browser_emulate` | `device: Option<Device>` | `()` |
| `browser_history` | | `[{ url, title, at }]`, newest first, 500 kept per project |
| `browser_favorites` | | `[{ url, title }]` |
| `browser_favorite_toggle` | `url`, `title` | `bool` (now a favorite) |
| `browser_permissions` | | `[{ host, rule: "site" }]` |
| `browser_permission_revoke` | `host` | `()` |
| `browser_clear_storage` | | `()` (cookies, storage, cache of this project's data store; pages reload) |

`Device { name, w, h, mobile: bool }`. Presets (name, w, h, mobile): `iPhone 15` 393x852 true,
`iPhone SE` 375x667 true, `Pixel 8` 412x915 true, `iPad` 820x1180 true, `Laptop` 1280x800 false,
`Desktop` 1920x1080 false; custom sizes are allowed. Emulation places the page at the device size
centred in the tab's rect (a letterbox); a device larger than the rect is scaled down with the page
zoom so it fits, and the letterbox ignores clicks. A mobile device also switches the user agent to
that device's (iPhone and iPad: Mobile Safari; Pixel: Chrome Android) until emulation ends.
WebKit cannot fake touch or device pixel ratio: the device bar says so.

`BrowserState` gains `zoom: f64`, `user_agent: String` (preset name or `"Safari"`),
`emulation: Option<Device>`. Zoom, user agent, emulation, history, favorites persist per project.

### Socket ops added

`pages`, `new_page { url? }`, `close_page { page }`, `select_page { page }`,
`resize { device? | w, h | none }` (the agent's `browser_resize`), `back`, `forward`, `reload`,
`evaluate { script }` (always asks the operator once per host, like a new host; returns
`{ value }` as JSON).

### Agent tools (B3, in mcp.mjs)

`browser_open { url, new_page? }`, `browser_read { max_chars? }`, `browser_click { ref | selector |
x, y }`, `browser_type { ref | selector, text, submit? }`, `browser_scroll { dy }`,
`browser_screenshot { ref? }` (returns the PNG as an MCP image plus its path),
`browser_resize { device? | w, h }`, `browser_pages`, `browser_back`, `browser_forward`. Each
connects to `<bus>/browser.sock` with the calling session's id and display label. On
`held_by_user` or `waiting_for_approval` the tool waits, re-checking `state` every second up to 120
s, and says what it is waiting for; on `no_app` it says Trantor's desktop app is not open on this
machine.

### Settled by the B5 build

- User agent presets are `Safari`, `Chrome`, `Firefox`, `iPhone`, `iPad`, `Android`
  (case-insensitive; anything else is `bad_request`; `None` = Safari).
- `browser://ask` carries an optional `kind: "evaluate"` when an agent asks to run a script; an
  evaluate grant covers that visit only and is never persisted.
- `browser_new_page` and the socket `open` / `new_page` results include the `page` id.
- A blank `browser_open` creates no page; the first `browser_navigate` or `browser_new_page` does.
- `evaluate` runs synchronously (promises are not awaited); a script error is `bad_request`.
- Socket `resize` takes a preset name string or a `Device`, or top-level `w`, `h`, or nothing.
- Zoom, user agent, emulation, rect and pop-out are per project (no `page`).
- Release builds answer `browser_inspect` with `unsupported` and a message pointing at
  right-click > Inspect Element; the page is inspectable either way.
- Load completion and in-page URL changes are tracked by sampling each webview every 300 ms.
- Not yet: emulation inside a pop-out window, a `window` handle for popups (`postMessage` to the
  opener does not reach it), clearing find highlights.
