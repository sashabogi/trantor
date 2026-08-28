# Design: the handoff lives in the app (#5509)

The Terminal-era baton opens a NEW Terminal window and asks via a macOS dialog. Inside the app
there is one pane and one chat; the successor must arrive THERE. Almost all of the machinery
already exists — this design is mostly about wiring a UI onto it.

## What already exists (built 08-27/28, do not rebuild)
- The heartbeat arms the baton at `contextWarnFrac` (default 90%) and the Stop hook fires it at a
  turn boundary — never mid-flight. `bin/baton.mjs` / `relay_handoff` write the handoff, with
  `session_id` = the writer (orchWriterSid).
- An orch-origin handoff is HELD for the pane; `trantor open` sees the mapped thread handed off
  (`_orch_takeover_sid`), starts a FRESH id in the same pane, the SessionStart hook claims the
  baton, supersedes the twin, and re-records `orch-sessions.txt`.
- The chat watcher emits `chat-session-changed` when the map moves; the UI clears under a
  "session continued" divider. The muzzle lapses if a claimant dies (hub 066e80b).
- The context gauge (#5508) gives the operator the same number the baton uses — one source.

## The three flows

### 1. Ask (default)
At warnFrac the chat shows a banner (not a macOS dialog): "Context at 90% — hand off to a fresh
session?" with [Hand off now] [Keep going]. "Keep going" re-offers every +2% and stops nagging
(episode, not timer — the monitoring doctrine). The banner is the app-side face of the SAME
threshold the heartbeat uses; whichever fires first wins, the other notices the handoff exists
and stands down.

### 2. Hand off now (same-pane replacement)
The button — also available any time from the chat header menu:
1. `trantor handoff --write-only` (baton.mjs gains the flag: write + announce, NO Terminal spawn,
   no baton-close). Auto-summary path; the model-authored rich handoff stays the /trantor:handoff
   skill's job.
2. End the pane's claude gracefully (herdr process signal, not keystrokes).
3. `trantor open` — the existing takeover path does everything else (fresh id, claim, map).
4. The chat follows via `chat-session-changed`; the composer's liveness gate covers the gap.
One Tauri command (`handoff_now(project)`) shelling those three steps, so the CLI and the app
cannot drift.

### 3. Overlap (the "in-flight" case the operator asked for)
When the predecessor is mid-turn and the operator wants the successor booting NOW:
- The successor boots in a temporary SPLIT pane (same workspace) via `trantor open --overlap`:
  mints the fresh id, claims the baton there, map moves to the successor.
- The predecessor is superseded (informational — it can finish its in-flight work; the muzzle
  never hard-blocks) and keeps its pane until it goes idle; then its pane closes and the
  successor's pane is re-recorded as THE orch pane (replace-never-stack doctrine).
- The chat follows the MAP, so the operator is talking to the successor while the predecessor
  drains; the predecessor's tail remains visible in the Workspace lens.
This is the two-Terminal-windows pattern translated into panes.

## The dial
`trantor autonomy` gains a third local dial, `baton`: `ask` (banner, default) · `auto` (fire at
the turn boundary after warnFrac, banner only informs) — surfaced in the app's Settings next to
harness/acts. The heartbeat consults it; the app renders it.

## Spawn-suppression rule (the one change inside existing code)
`maybeSpawn`/`spawnFresh` must not open a Terminal window when the project has a live orch pane:
the pane IS the successor surface. One check at the spawn decision point; the Terminal path stays
for terminal-first projects.

## Build cut (next wave)
- W1: baton.mjs `--write-only` + spawn-suppression-when-pane + Tauri `handoff_now` + chat banner
  wired to the gauge + [Hand off now]. (Same-pane replacement end to end.)
- W2: the `baton` dial (autonomy.mjs + Settings UI + heartbeat consult).
- W3: `trantor open --overlap` + pane-drain choreography.
