# KIMI DIALECT BRIDGE — de-fork contract (2026-08-20) — FROZEN

Why: kimi/hooks/* is a 1,473-line fork of the canonical hooks, frozen at ~0.17.61. It runs
UNSIGNED raw fetch (cannot pass an enforce hub — why kimi-orch is local-by-necessity, the last
live split-brain vector) and pre-pin hub resolution. Every canonical fix since (signing, per-
project pins, cc field, instance keys, the cwd fixes) never reached it.

Design (dsh's hook-protocol pattern, taken to its end): kimi hooks become a THIN DIALECT BRIDGE
that executes the CANONICAL hooks as child processes. Logic lives in exactly one place; kimi
inherits every current and future fix automatically.

## P1 — kimi/bridge.mjs (the whole dialect, one file)
`node kimi/bridge.mjs <event> <canonical-hook-path>`:
1. Read kimi's stdin payload (JSON, CC-shaped: hook_event_name, session_id, cwd, tool_input…).
2. INPUT translation: normalize the few kimi aliases to the CC field names (extractPrompt logic
   from the old common.mjs — prompt/user_prompt/text; keep the defensive alias reads; keep
   TRANTOR_DEBUG_HOOKS=1 raw-payload dump to ~/.agent-bus/kimi-hook-debug.jsonl).
3. Spawn `node <canonical-hook-path>` with the translated payload on stdin, cwd = payload.cwd
   (fall back CLAUDE_PROJECT_DIR; NEVER process.cwd — plugin cache phantom), env passthrough
   (RELAY_AGENT comes from kimi.plugin.json as today).
4. OUTPUT translation (CC JSON envelope → kimi semantics):
   - `hookSpecificOutput.additionalContext` → for SessionStart: STASH to
     ~/.agent-bus/kimi-stash-<safe-session>.txt (observation-only event); for UserPromptSubmit/
     PostToolUse: print as PLAIN STDOUT (kimi appends stdout to context) — and on
     UserPromptSubmit FIRST flush any pending stash (prepend, then clear).
   - `decision: "block"` / continue:false → exit 2 with reason on stderr (kimi mirrors CC exit
     semantics; if a live probe disproves this, log + degrade to exit 0, never break the turn).
   - anything else → exit 0, stdout suppressed.
5. Fail-open contract: any bridge error → exit 0, one stderr line. Timeout the child at 25s.
File ownership: kimi/bridge.mjs + test-kimi-bridge.mjs ONLY.

## P2 — the shrink (depends on P1)
- Rewrite each kimi/hooks/<x>.mjs to a 2-4 line shim: `import+exec bridge with the matching
  canonical hook` — or better, point kimi.plugin.json commands STRAIGHT at the bridge
  (`node ./kimi/bridge.mjs SessionStart ./hooks/sessionstart.mjs`) and DELETE kimi/hooks/*.mjs.
  Prefer deletion; keep kimi/hooks/lib/ only if the bridge imports something from it (goal: rm).
- kimi/bin/* (write-handoff, baton-close, open-session, handoff-prompt): port to call the
  canonical bin/ equivalents where they exist; keep only genuinely kimi-specific glue.
- Update kimi.plugin.json: bridge commands, version → current, keep RELAY_AGENT=kimi-orch.
File ownership: kimi/hooks/**, kimi/bin/**, kimi.plugin.json.

## P3 — proof (the 4 unproven events + enforce-hub signing)
test-kimi-events.mjs, hermetic: real hub (spawned) with RELAY_AUTH=enforce + the REAL bridge +
canonical hooks. For EVERY event in kimi.plugin.json: feed a realistic kimi payload, assert the
hub effect (register/focus/card/heartbeat/claim...) lands SIGNED (enforce hub rejects unsigned —
that IS the assertion), assert output translation (stash created on SessionStart; stash flushed
+ cleared on first UserPromptSubmit; plain stdout, never CC JSON envelopes, never JSON garbage
into kimi's context). File ownership: test-kimi-events.mjs ONLY.

## Hard rules
- NOBODY edits hooks/** (canonical) or hooks/lib/** — the bridge ADAPTS, it never forks again.
  If a canonical hook genuinely blocks the bridge, report it; the orchestrator changes it.
- NOBODY edits package.json — orchestrator wires tests at integration.
- Card flow todo → doing → testing → done, notes on testing/done moves (the log is live now).
