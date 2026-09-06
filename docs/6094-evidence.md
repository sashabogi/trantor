# #6094 evidence pack (2026-09-05, orchestrator)

Symptom: a real AskUserQuestion from the orchestrator (pane w2:p8, session 2e1e3b96, project trantor) does not render as a card in the desktop Chat panel. Ten real drills across 0.3.141 → 0.3.150 (diagnostic). Rendered once (0.3.147) only when Chat was opened AFTER the pane was already blocked; the click then failed (EIO on the read-only watch client; fixed).

Fixed and proven along the way (keep): chat_unwatch generation (4c3b0db), sync busy-guard (8cdb807), answer via herdr pane send_text (0738c31), orch-status payload decode (object, not JSON string; every live frame had failed to parse), ask gets its own ToolRun (5402b78), blocked-no-ask retry loop, four-outcome listener tracing, TRANTOR_ASK_DRILL.

Decisive trace, diagnostic build fc5de28, 22:29 (app-trace.log 1788661776336..1788661782828):
  chat blocked-no-ask retry N: sending after=9425 → result: after=9425 received total=9425 turns=0   (14 times over 8.2 s)
The operator's transcript at that moment had ≥9428 lines; the AskUserQuestion tool_use is line 9428, written at the block. The reader (read_chat_snapshot → orchestrator_transcript_path → fs::read_to_string → complete_lines → decode_chat_lines) reported a total of 9425 for the whole window: it never saw lines 9426-9428 although they were on disk.
Fixture: .agent-bus-out/6094-ask-open-fixture.jsonl (the live transcript truncated right after the tool_use, 9291 lines, no tool_result). The Rust test over it (decode_chat_lines_finds_the_open_ask_in_the_real_9291_line_transcript) PASSES with the fixture present: decode is sound on the real bytes. So decode is not it; something between Chat's retry and the bytes on disk is (a cached snapshot returned to every queued caller by the busy-guard? a stale read? complete_lines dropping the unterminated last line at the moment of the block, then never re-reading? the tail watcher's line_offset?).

Reference: Claude Code itself does not render its question from the transcript file; the CLI knows the question at the moment it asks. Its hooks fire for tool use (PreToolUse on AskUserQuestion carries the question payload). Trantor already runs a plugin with hooks inside every orchestrator session.

Question for reviewers: (1) name the mechanism that makes total stay 9425 across 14 reads while the file grows; (2) say whether the transcript-polling design should stand at all, or whether the question should be pushed to the app by a hook (or by herdr) at the moment it is asked; (3) propose the smallest build that is correct, with the drill that proves it on the real path.
