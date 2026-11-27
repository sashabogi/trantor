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
