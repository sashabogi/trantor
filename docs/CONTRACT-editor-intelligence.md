# Contract: editor intelligence (cards #5857 language servers, #5858 ghost text)

Operator ruling, 2026-09-01: the Code lens editor must be "a real proper code editor, the way
modern editors are". Monaco (0.3.86+) is already the VS Code editor. What it lacks is the
language server behind it and predictive completion. Two cards, two seats, one Monaco.

## Ownership (this row joins SYSTEM-CONTRACT.md §4)

| Concern | Single owner | Writers | Consumers | Never |
|---|---|---|---|---|
| Language intelligence (servers, their lifecycle, JSON-RPC framing) | Rust `lsp` module in src-tauri | Rust only | Monaco through monaco-languageclient over Tauri invoke/listen | TS spawning servers; a server outliving the lens; a fake "ready" when no server is installed |
| Predictive completion (ghost text) | one Monaco inline-completions provider module + Rust `ghost_complete` | the provider only | CodeView | a second completion path; spend that does not reach the ledger |

## Card #5857 — language servers (deepseek)

Rust side, `src-tauri/src/lsp.rs`:

- `lsp_start(project, scope, language) -> id`. Root is the scope's checkout: `project_dir(project)`
  or the seat worktree `~/.agent-bus/worktrees/<project>/<seat>`. One server per (root, language).
- `lsp_send(id, message)` writes one JSON-RPC message with `Content-Length` framing.
  Server output is framed back and emitted as Tauri event `lsp-message:<id>` (payload: the JSON
  text). Framing has unit tests (split reads, two messages in one chunk, CRLF headers).
- `lsp_stop(id)`; all servers for a project stop when the lens unmounts (the TS side calls it in
  the effect cleanup) and on app exit.
- Servers, by language id: `rust` -> `rust-analyzer`; `typescript`/`typescriptreact`/
  `javascript` -> `typescript-language-server --stdio`; `python` -> `pyright-langserver --stdio`.
  Detection is `which` on the terminal PATH (`terminal_path()`); a missing binary returns
  `Err("not installed: <name>")` and the editor shows it in the status line as text. Never a
  spinner that never ends, never a pretend "ready".
- Servers are lazy: started on the first open file of that language, not at lens open.

TS side:

- `features/code/lspClient.ts`: a `MessageTransports` adapter (reader = listen to
  `lsp-message:<id>`, writer = invoke `lsp_send`) wired into `monaco-languageclient`
  (`npm view` today: monaco-languageclient 10.7.0, vscode-languageclient 10.1.1; pin what the
  lockfile resolves, read the version from the package, never from memory).
- One client per (root, language), started from CodeView when a file of that language mounts,
  shared across tabs, stopped in the cleanup that unmounts Files.
- `monacoSetup.ts`: the TS-diagnostics mute STAYS as the fallback. When a client is live for a
  model's language, `quickSuggestions` turns on for that editor instance and the muted built-in TS
  service is not consulted (the server owns diagnostics). No client -> exactly today's behaviour.
- Bundling: local only, like the workers. Nothing from a CDN.

Proof on the card: a screenshot of hover + completion + a real diagnostic in
`desktop/src-tauri/src/lib.rs` (rust-analyzer is installed on the operator's machine), and the
honest status line for a `.tsx` file while `typescript-language-server` is not installed.

## Card #5858 — ghost text (openrouter)

- `features/code/ghostText.ts`: `monaco.languages.registerInlineCompletionsProvider("*", ...)`.
  Debounce 300ms, cancelled by the next keystroke (honour the CancellationToken). Context is the
  60 lines before the cursor, the 20 after, and the file path. Tab accepts, Esc dismisses (Monaco
  defaults). Off switch in the editor toolbar, remembered per viewer in localStorage under
  `code.ghostText`.
- Rust `ghost_complete(prefix, suffix, path) -> String` shells the scrooge CLI:
  `scrooge -t code --difficulty easy --json` with the prompt on stdin, asking for at most 64
  tokens of continuation. That is the routing AND the ledger: every call shows in
  `scrooge ledger`, which is the cost record this card names. Do not call a provider directly and
  do not type a model id; scrooge's easy tier picks it.
- Latency is measured, not assumed: log p50/p95 over 20 completions on the card. If p50 is over
  800ms the card notes it and stops there; the fix (a resident scrooge process) is a separate
  card, not a workaround inside this one.
- Must not touch `monacoSetup.ts` (owned by #5857 this wave). CodeView gets one option and one
  toolbar switch.

Proof on the card: ghost text visible in a `.rs` and a `.ts` file, the ledger lines for those
calls, and the latency numbers.

## Gates (both cards, on merged main, not the worktree)

`cargo test` in src-tauri, `npx tsc --noEmit -p desktop`, `npx vitest run`, a real
`npm run tauri build`. A green worktree run is not a gate (no node_modules there). Move the card to
testing with the commands and counts in the note; the orchestrator runs them again before done.
