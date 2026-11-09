# Contract: live `AskUserQuestion` sidecar (#6533)

Claude Code does not reliably flush an in-flight assistant `tool_use` to its transcript. The
transcript is therefore history, not a live source for an open question. The only producer of an
open ask is the hook sidecar below; the only UI source is its `orch-ask` event.

The complete implementation surface is `hooks/hooks.json`, `hooks/ask-sidecar.mjs`,
`test-ask-sidecar.mjs`, `desktop/src-tauri/src/asks.rs`, the two registration lines in
`desktop/src-tauri/src/lib.rs`, `desktop/src/features/chat/Chat.tsx`,
`desktop/src/features/chat/Chat.test.tsx`, and `desktop/src/features/chat/askDrill.ts`.

## Producer: plugin hook

`hooks/ask-sidecar.mjs` is registered in `hooks/hooks.json` for `AskUserQuestion` on its tool
lifecycle and for every session's `Stop`:

- `PreToolUse` and `PermissionRequest` write
  `~/.agent-bus/asks/<session_id>.json` atomically.
- `PostToolUse` and `PostToolUseFailure` delete that file when ids are equal or the stored id is
  null (a session can have only one live ask). `PermissionRequest` may omit `tool_use_id`, so the
  sidecar field is nullable.
- `Stop` deletes any sidecar for that `session_id`: the turn ended, so no question can remain
  open even when Claude omitted its closing tool hook.

The JSON shape is exact:

```json
{
  "session_id": "<Claude session id>",
  "project": "<project resolved from cwd>",
  "cwd": "<hook payload cwd>",
  "tool_use_id": "<AskUserQuestion tool-use id, or null>",
  "kind": "AskUserQuestion",
  "ask": { "question": "Ship it?", "options": [{ "label": "Yes", "description": "Proceed" }], "multi": false },
  "questions": [{
    "question": "Ship it?", "header": "Ship", "multiSelect": false,
    "options": [{ "label": "Yes", "description": "Proceed" }]
  }],
  "event": "PreToolUse",
  "visible_ts": null,
  "ts": 0
}
```

`ask` is the declaration the Chat chips render from (#7776): the first question, every option as
offered (`description` omitted when the tool gave none), and `multi` mirroring `multiSelect`. The
chips never invent an option that is not in this list; the prose extractor runs only when no
sidecar is open.

A `relay_ask` tool call (#7756) is the other declaration: `PreToolUse` on `mcp__.*relay_ask`
writes `kind: "relay_ask"`, `ask: { question, options: [], multi: false }`, a one-entry
`questions` mirror with header `ask`, and `visible_ts` set at once. It survives `Stop`, since the
turn ended by asking, and `UserPromptSubmit` deletes it: the next prompt is the answer or
supersedes the question. It offers no options, so the card shows the question and no chips.

`ts` is the first hook's Unix epoch milliseconds. `PermissionRequest` changes `event` and sets
`visible_ts` without changing the ask's identity; a repeated identical event does not rewrite the
file. The hook reuses `file-claim.mjs`'s bounded stdin reader and
`sessionContext(input.cwd)` project resolution. Missing/malformed input or filesystem failure is
fail-open. Every path returns `{}` with exit 0: this hook never emits `permissionDecision`,
`additionalContext`, or any other decision and never answers the question.
`AGENT_BUS_DIR` may replace `~/.agent-bus` only as the existing test isolation seam.

## Consumer: desktop Rust

All implementation lives in new module `desktop/src-tauri/src/asks.rs`; `lib.rs` changes are
limited to `mod asks;` and registering the module's Tauri command. `ask_watch` is process-wide and
idempotent. The frontend subscribes before invoking it; every invocation scans the directory and
re-emits current open files, so both an already-open Chat and a Chat tab opened cold observe an ask.
The running watcher reacts to atomic creates/replacements and deletes under
`~/.agent-bus/asks/`.

For each valid file, Rust resolves the project by finding the project whose existing
`orch_session_id(project)` equals `session_id`; if no mapping matches, it derives the project from
the recorded `cwd` using the existing cwd/project rules. The payload's `project` is retained for
diagnostics, not trusted over session identity. Unresolved or malformed files are ignored and
traced, never guessed.

Rust caches the last valid payload by session so deletion can emit a close with the same identity
and questions. Create/replay emits on the app window:

```text
orch-ask { project, session_id, tool_use_id, open: true, visible, questions }
```

Deletion emits the same payload with `open: false`. Duplicate observations of the same state are
idempotent. Unit tests use a temporary bus directory and cover initial replay, create, replacement,
delete/close, malformed input, and session-map-first plus cwd-fallback routing.

## Chat and answer semantics

Chat keeps live ask state keyed by `(project, session_id, tool_use_id)` from `orch-ask` alone.
`open: true` renders the existing question card immediately, independent of herdr status and
transcript timing. Its answers enable when `visible` arrives from `PermissionRequest`, with a
1500 ms fallback after the initial open event. `open: false` closes its pending affordance. A matching transcript
`tool_result` also closes a still-open event card when a closing hook was omitted, then remains the
history authority: the rendered historical card flips to answered and shows the recorded answer.

The answer path remains `0738c31`: option/free-text selection calls `ask_answer`, which uses herdr
`send_text`. Its target is resolved by `session_id`: the pane whose herdr `reported_session`
matches the sidecar session, never the project's orchestrator pane. When no pane hosts that
session, the card is read-only and says “answer it in its terminal.” Once enabled, sending is
immediate; pane screen scraping is not a valid signal for Claude's TUI. The hook never participates
in answering. Remove the blocked-with-no-ask retry loop and its trace spam. Remove transcript
`openQuestion(...)` as the source of a pending card; transcript parsing remains only for
history/result correlation. A focused Vitest must fail on main and prove that `orch-ask` alone
opens, closes, and later marks the card answered.

## Real-path gate

`TRANTOR_ASK_DRILL` is rewritten to start a fresh interactive `claude --model haiku` session with
a narrow prompt that calls `AskUserQuestion` once, in a herdr pane whose cwd is the trantor
checkout. (`claude -p` cannot expose `AskUserQuestion`.) Its transient trantor bus registration is
expected. After the updated plugin is installed, that session genuinely calls `AskUserQuestion`.
For both Chat already open and a cold Chat tab, the drill asserts: the sidecar
exists; app trace records `ask received`; the DOM card appears within one second of the hook and
before the transcript grows when Chat is open; cold replay mounts within 1500 ms of the Chat tab
click after `ask_watch` is dispatched ahead of transcript backfill; answering uses the real
session-routed `ask_answer`/`send_text` path;
the pane advances; the matching `tool_result` lands; the sidecar disappears; and the pending card
closes and settles answered. Setup, probe transitions, cold-tab selection, replay, and every
post-mount step are traced. Each open/cold scenario has its own hard deadline of `ASK_TIMEOUT +
SETTLE_TIMEOUT + 30 seconds`, which logs the current step directly on expiry.

The seat writes tests and drill code but never builds or installs the app. The orchestrator builds
and runs this gate, then performs the operator-visible real-path check.

## Phone answers, any number of questions (#12912)

Measured live on Claude Code 2.1.304, each answer sent as ONE `send_text` write. These keys are
the contract; a CC upgrade that changes them is a card with a re-measure, never a guess.

Screen per question: options are rows `0..n-1`, row `n` is "Type something" (an inline text
field: typing goes straight in), and a multi-select question adds row `n+1`, "Next" (or
"Submit" on the last). The cursor starts on row 0. `D` is `ESC [ B`.

| answer | keys |
|---|---|
| single-select, pick `i` | `D*i`, Enter (CC advances by itself) |
| single-select, Other text | `D*n`, text, Enter |
| multi-select | per pick ascending: `D*(i - at)`, Space; if Other: `D*(n - at)`, text; then `D` to row `n+1`, Enter |
| after the LAST question, when the ask has 2+ questions OR its lone question is multi-select | Enter (Review tab, "Submit answers" is preselected) |

Traps, each seen live: Enter on the empty "Type something" row DECLINES the whole ask, so text
never follows an Enter. Typing into a multi-select Other row ticks it, and Enter there unticks
it. Enter on a multi-select option toggles it; it does not submit. A lone single-select
question submits on its own Enter, with no Review. Spaces inside Other text type as text.
Other text is sent with control characters and newlines stripped; blank text is no Other.

Payload, phone to hub to desktop (`POST /session/answer`):

```json
{ "project": "p", "session": "<cc session>", "toolId": "<tool_use_id>",
  "answers": [ { "picks": [1] }, { "picks": [0, 2], "other": "Kiwi" }, { "picks": [], "other": "Oslo" } ] }
```

`answers` has one entry per question in the ask's order, at most 4 (CC's limit). Each entry
needs a pick or non-blank `other`; a single-select entry has exactly one of them. The hub still
accepts the old `{ picks, other }` body as `answers: [{ picks, other }]`. The queue view always
carries the normalized `answers`, and for one-entry answers also the old top-level `picks` and
`other`, so a desktop that predates this keeps working. The desktop types only when
`answers.len()` equals the live sidecar's `questions.len()` and `toolId` still matches;
anything else acks "stale" and types nothing. A partial answer is never typed.
