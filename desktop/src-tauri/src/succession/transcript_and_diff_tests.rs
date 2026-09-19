#[allow(unused_imports)]
use super::*;
use super::herdr_tests::{git, temp_dir};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[test]
fn write_only_flag_mentions_are_hard_errors() {
    assert!(write_only_flag_rejected(
        "error: unknown option '--write-only'"
    ));
    assert!(!write_only_flag_rejected("handoff saved"));
}

#[test]
fn harness_injections_never_wear_the_operator_role() {
    // Every one of these arrives as an ordinary user turn. Rendering them as the person
    // speaking is what put a 6,849-character hook dump in the chat under "YOU".
    assert!(is_harness_injection(
        "Stop hook feedback:\nYou have 29 unread DIRECT message(s)"
    ));
    assert!(is_harness_injection("[Request interrupted by user]"));
    assert!(is_harness_injection(
        "<system-reminder>read this</system-reminder>"
    ));
    assert!(is_harness_injection(
        "PostToolUse:Bash hook additional context: <trantor-inbox>"
    ));
    assert!(is_harness_injection(
        "This session is being continued from a previous conversation"
    ));
    assert!(is_harness_injection(
        "You just joined (your arrival was already announced on the bus). 1) relay_inbox"
    ));
    assert!(is_harness_injection(
        "NEW BUS MESSAGE for you:\n[foreman]: contract"
    ));
}

#[test]
fn assistant_usage_sets_context_tokens_and_fraction() {
    let rows = [
        serde_json::json!({
            "type": "assistant",
            "message": {
                "model": "claude-opus",
                "usage": {
                    "input_tokens": 400,
                    "cache_read_input_tokens": 50,
                    "cache_creation_input_tokens": 25
                },
                "content": [{"type": "text", "text": "done"}]
            }
        })
        .to_string(),
        serde_json::json!({
            "type": "assistant",
            "message": {
                "model": "claude-opus",
                "usage": {
                    "input_tokens": 800,
                    "cache_read_input_tokens": 100,
                    "cache_creation_input_tokens": 100
                },
                "content": [{"type": "text", "text": "again"}]
            }
        })
        .to_string(),
    ];
    let snap = decode_chat_lines_with_context_window(rows.iter(), rows.len(), 2_000);
    assert_eq!(snap.meta.context.tokens, Some(1_000));
    assert_eq!(snap.meta.context.window, 2_000);
    assert_eq!(snap.meta.context.frac, Some(0.5));
}

#[test]
fn context_tokens_stay_null_until_assistant_usage_exists() {
    let rows = [serde_json::json!({
        "type": "assistant",
        "message": {
            "model": "claude-opus",
            "content": [{"type": "text", "text": "no usage yet"}]
        }
    })
    .to_string()];
    let snap = decode_chat_lines_with_context_window(rows.iter(), rows.len(), 200_000);
    assert_eq!(snap.meta.context.tokens, None);
    assert_eq!(snap.meta.context.window, 200_000);
    assert_eq!(snap.meta.context.frac, None);
}

#[test]
fn slash_command_record_renders_as_system_divider() {
    let row = serde_json::json!({
        "type": "user",
        "message": { "content": "/compact fused words stay here" }
    })
    .to_string();
    let snap = decode_chat_lines_with_context_window([row], 1, 0);
    assert_eq!(snap.turns.len(), 1);
    assert_eq!(snap.turns[0].role, "system");
    assert_eq!(snap.turns[0].blocks[0].kind, "divider");
    assert_eq!(
        snap.turns[0].blocks[0].text,
        "/compact fused words stay here"
    );
}

#[test]
fn local_command_blocks_render_as_system_dividers() {
    for text in [
        "<local-command-caveat>do not show this as user speech</local-command-caveat>",
        "<local-command-stdout>cargo test output</local-command-stdout>",
    ] {
        let row = serde_json::json!({
            "type": "user",
            "message": { "content": text }
        })
        .to_string();
        let snap = decode_chat_lines_with_context_window([row], 1, 0);
        assert_eq!(snap.turns.len(), 1);
        assert_eq!(snap.turns[0].role, "system");
        assert_eq!(snap.turns[0].blocks[0].kind, "divider");
        assert_eq!(snap.turns[0].blocks[0].text, text);
    }
}

#[test]
fn is_meta_user_entry_renders_as_system_divider() {
    let row = serde_json::json!({
        "type": "user",
        "isMeta": true,
        "message": { "content": [{ "type": "text", "text": "bookkeeping note" }] }
    })
    .to_string();
    let snap = decode_chat_lines_with_context_window([row], 1, 0);
    assert_eq!(snap.turns.len(), 1);
    assert_eq!(snap.turns[0].role, "system");
    assert_eq!(snap.turns[0].blocks[0].kind, "divider");
    assert_eq!(snap.turns[0].blocks[0].text, "bookkeeping note");
}

#[test]
fn a_message_starting_with_an_absolute_path_stays_user_speech() {
    // The first live file-drop regression: "/Users/…" matched a bare starts_with('/'),
    // rendered as bookkeeping, and the delivery receipt declared a delivered message lost.
    let row = serde_json::json!({
        "type": "user",
        "message": { "content": "/Users/sasha/Desktop/CleanShot 2026-08-28 at 12.14.58.jpg  here is the screen shot" }
    })
    .to_string();
    let snap = decode_chat_lines_with_context_window([row], 1, 0);
    assert_eq!(snap.turns[0].role, "user");
    assert_eq!(snap.turns[0].blocks[0].kind, "text");
}

#[test]
fn a_queued_mid_turn_message_renders_as_the_operator_speaking() {
    let rows = [
        serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"sent while busy"}).to_string(),
        serde_json::json!({"type":"queue-operation","operation":"remove","content":"sent while busy"}).to_string(),
    ];
    let snap = decode_chat_lines_with_context_window(rows, 2, 0);
    // the enqueue speaks (flagged queued); the remove becomes a dequeue marker the front-end
    // reducer consumes to clear that flag — three states (sent, queued, seen) stay distinct.
    assert_eq!(snap.turns.len(), 2);
    assert_eq!(snap.turns[0].role, "user");
    assert_eq!(snap.turns[0].blocks[0].kind, "text");
    assert_eq!(snap.turns[0].blocks[0].text, "sent while busy");
    assert_eq!(snap.turns[0].queued, Some(true));
    assert_eq!(snap.turns[1].role, "system");
    assert_eq!(snap.turns[1].blocks[0].kind, "dequeue");
    assert_eq!(snap.turns[1].blocks[0].text, "sent while busy");
}

#[test]
fn a_queued_harness_notification_never_wears_the_operators_face() {
    let rows = [
        serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>x</task-id>\n</task-notification>"}).to_string(),
        serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"[SYSTEM NOTIFICATION - NOT USER INPUT]\nsomething automated"}).to_string(),
        serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"real words from a person"}).to_string(),
    ];
    let snap = decode_chat_lines_with_context_window(rows, 3, 0);
    assert_eq!(snap.turns.len(), 1);
    assert_eq!(snap.turns[0].blocks[0].text, "real words from a person");
}

#[test]
fn turn_ended_flags_only_on_turn_boundary_system_rows() {
    // The two boundary subtypes are the belt (#5993): the pushed status stream can freeze
    // on `working`, so the batch that SAYS the turn ended must carry the flag to the
    // frontend. The row itself stays invisible — bookkeeping, not a bubble.
    for subtype in ["turn_duration", "stop_hook_summary"] {
        let rows = [serde_json::json!({
            "type": "system",
            "subtype": subtype,
        })
        .to_string()];
        let snap = decode_chat_lines_with_context_window(rows, 1, 0);
        assert!(snap.turn_ended, "system/{subtype} must flag turn_ended");
        assert!(snap.turns.is_empty(), "the boundary row must not render");
    }

    // Any other system row is NOT a boundary.
    let rows = [serde_json::json!({
        "type": "system",
        "subtype": "compact_boundary",
    })
    .to_string()];
    let snap = decode_chat_lines_with_context_window(rows, 1, 0);
    assert!(!snap.turn_ended);

    // An ordinary batch without a system row does not flag either.
    let rows = [serde_json::json!({
        "type": "assistant",
        "message": { "content": [{ "type": "text", "text": "still mid-turn" }] }
    })
    .to_string()];
    let snap = decode_chat_lines_with_context_window(rows, 1, 0);
    assert!(!snap.turn_ended);
}

#[test]
fn slash_command_gate_takes_commands_and_refuses_paths() {
    assert!(is_slash_command("/compact"));
    assert!(is_slash_command("/compact with trailing words"));
    assert!(is_slash_command("/model opus"));
    assert!(is_slash_command("/trantor:handoff"));
    assert!(!is_slash_command("/Users/sasha/x.jpg here"));
    assert!(!is_slash_command("/tmp/scratch.txt"));
    assert!(!is_slash_command("plain words"));
    assert!(!is_slash_command("/"));
}

#[test]
fn plain_user_message_stays_user_speech() {
    let row = serde_json::json!({
        "type": "user",
        "message": { "content": "please /compact later, not now" }
    })
    .to_string();
    let snap = decode_chat_lines_with_context_window([row], 1, 0);
    assert_eq!(snap.turns.len(), 1);
    assert_eq!(snap.turns[0].role, "user");
    assert_eq!(snap.turns[0].blocks[0].kind, "text");
    assert_eq!(
        snap.turns[0].blocks[0].text,
        "please /compact later, not now"
    );
}

#[test]
fn chat_meta_merge_keeps_last_known_context_across_batches() {
    let mut meta = decode_chat_lines_with_context_window(
        [serde_json::json!({
            "type": "assistant",
            "message": {
                "usage": { "input_tokens": 80, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 10 },
                "content": [{"type": "text", "text": "first"}]
            }
        })
        .to_string()],
        1,
        1_000,
    )
    .meta;
    let next = decode_chat_lines_with_context_window(
        [serde_json::json!({
            "type": "user",
            "message": { "content": "next" }
        })
        .to_string()],
        2,
        1_000,
    )
    .meta;
    merge_chat_meta(&mut meta, next);
    assert_eq!(meta.context.tokens, Some(100));
    assert_eq!(meta.context.frac, Some(0.1));
}

#[test]
fn a_real_message_is_never_mistaken_for_machinery() {
    assert!(!is_harness_injection("hi"));
    assert!(!is_harness_injection("say only: PERSIST_OK"));
    // Length is not the signal. A long message from a person is still from a person.
    assert!(!is_harness_injection(
        &"read docs/PRD.md and plan the build. ".repeat(300)
    ));
    // The word appearing mid-sentence in a discussion ABOUT hooks is the trap a naive
    // "contains" check falls into, so markers must anchor at the start.
    assert!(!is_harness_injection(
        "can you look at why the Stop hook feedback fires twice?"
    ));
}

#[test]
fn tool_summary_shows_the_field_a_person_would_recognise() {
    let bash = serde_json::json!({ "command": "npm test", "description": "run the suite" });
    assert_eq!(tool_summary("Bash", &bash), "npm test");
    let read = serde_json::json!({ "file_path": "bin/crew.sh", "limit": 40 });
    assert_eq!(tool_summary("Read", &read), "bin/crew.sh");
    let grep = serde_json::json!({ "pattern": "orch", "path": "bin" });
    assert_eq!(tool_summary("Grep", &grep), "orch  in bin");
}

#[test]
fn tool_summary_falls_back_rather_than_guessing_a_key() {
    // An unknown tool takes its first string field. Guessing at "the important key" would be
    // confidently wrong on every tool nobody thought of.
    let unknown = serde_json::json!({ "target": "w2:p1", "n": 3 });
    assert_eq!(tool_summary("herdr_thing", &unknown), "w2:p1");
    assert_eq!(tool_summary("empty", &serde_json::json!({})), "");
}

#[test]
fn tool_summary_stays_one_line_and_bounded() {
    let long = serde_json::json!({ "command": "x\ny".to_string() + &"z".repeat(400) });
    let out = tool_summary("Bash", &long);
    assert!(
        !out.contains('\n'),
        "newlines would break the one-line card"
    );
    assert!(out.chars().count() <= 161, "{}", out.chars().count());
    assert!(out.ends_with('…'));
}

#[test]
fn tool_summary_reads_askuserquestion_past_its_array_field() {
    // input's only field is `questions`, an ARRAY — the generic first-string-field fallback
    // finds nothing in it, so without the dedicated arm this rendered as "" (#6094's first
    // symptom: a collapsed tool row with no summary at all).
    let input = serde_json::json!({ "questions": [{ "question": "Stripe or Clover?", "header": "Rails", "multiSelect": false, "options": [] }] });
    assert_eq!(tool_summary("AskUserQuestion", &input), "Stripe or Clover?");
}

#[test]
fn parse_ask_questions_reads_the_real_transcript_shape() {
    // Exact shape confirmed against a real tool_use row in a session transcript, not invented.
    let input = serde_json::json!({
        "questions": [{
            "question": "Go with the hybrid plan?",
            "header": "Crew plan",
            "multiSelect": false,
            "options": [
                { "label": "Go (Recommended)", "description": "Fire up all 5 seats." },
                { "label": "Hold", "description": "Discuss first." }
            ]
        }]
    });
    let qs = parse_ask_questions(&input).expect("valid shape parses");
    assert_eq!(qs.len(), 1);
    assert_eq!(qs[0].header, "Crew plan");
    assert_eq!(qs[0].question, "Go with the hybrid plan?");
    assert!(!qs[0].multi_select);
    assert_eq!(qs[0].options.len(), 2);
    assert_eq!(qs[0].options[0].label, "Go (Recommended)");
    assert_eq!(qs[0].options[1].description, "Discuss first.");
}

#[test]
fn parse_ask_questions_falls_back_to_none_on_a_shape_mismatch() {
    // A card built from a guess would show the wrong choices — a malformed input must yield
    // no card, not a broken one.
    assert!(parse_ask_questions(&serde_json::json!({})).is_none());
    assert!(parse_ask_questions(&serde_json::json!({ "questions": "not an array" })).is_none());
    assert!(parse_ask_questions(&serde_json::json!({ "questions": [{ "header": "no question field" }] })).is_none());
}

#[test]
fn decode_chat_lines_keeps_the_ask_field_only_on_askuserquestion() {
    let row = serde_json::json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": [{
            "type": "tool_use", "id": "toolu_1", "name": "AskUserQuestion",
            "input": { "questions": [{ "question": "Ship it?", "header": "Ship", "multiSelect": false, "options": [{ "label": "Yes", "description": "" }] }] }
        }] }
    });
    let snap = decode_chat_lines(vec![row.to_string()], 1);
    let block = &snap.turns[0].blocks[0];
    assert_eq!(block.tool.as_deref(), Some("AskUserQuestion"));
    let ask = block.ask.as_ref().expect("ask data present for AskUserQuestion");
    assert_eq!(ask[0].question, "Ship it?");

    let bash_row = serde_json::json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": [{
            "type": "tool_use", "id": "toolu_2", "name": "Bash", "input": { "command": "ls" }
        }] }
    });
    let snap2 = decode_chat_lines(vec![bash_row.to_string()], 1);
    assert!(snap2.turns[0].blocks[0].ask.is_none(), "a non-question tool never carries ask data");
}

#[test]
fn decode_chat_lines_returns_a_trailing_open_ask_with_no_closing_user_line() {
    // #6094 real-path shape: the CLI writes one JSONL row PER content block, so an in-progress
    // assistant turn is several rows with no `user` row after it until the operator answers.
    // Mirrors read_chat_snapshot: raw multi-line text through complete_lines, then decode_chat_lines.
    let filler = "{\"type\":\"attachment\"}\n".repeat(5);
    let block = concat!(
        "{\"type\":\"attachment\"}\n",
        "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"t1\"}]}}\n",
        "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"t2\"}]}}\n",
        "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_ask\",\"name\":\"AskUserQuestion\",\"input\":{\"questions\":[{\"question\":\"Ship it?\",\"header\":\"Ship\",\"multiSelect\":false,\"options\":[{\"label\":\"Yes\",\"description\":\"\"}]}]}}]}}\n",
        "{\"type\":\"attachment\"}\n",
        "{\"type\":\"attachment\"}\n",
    );
    let raw = format!("{filler}{block}");
    let lines = complete_lines(&raw);
    let total = lines.len();
    let after = 5; // everything before the block was already "seen"
    let snap = decode_chat_lines(lines.into_iter().skip(after), total);
    let ask_turn = snap.turns.iter().find(|t| t.blocks.iter().any(|b| b.ask.is_some()));
    assert!(
        ask_turn.is_some(),
        "the trailing AskUserQuestion turn must be returned even with no closing user line, snap.turns={snap:?}",
    );
}

#[test]
fn decode_chat_lines_finds_the_open_ask_in_the_real_9291_line_transcript() {
    // #6094: the operator's own 9291-line session file, the only shape that reproduced the
    // blocked-no-ask retry loop after every synthetic fixture passed. It is gitignored (16.7MB),
    // so a clean checkout skips rather than fails.
    let fixture = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../.agent-bus-out/6094-ask-open-fixture.jsonl"
    );
    let Ok(raw) = std::fs::read_to_string(fixture) else {
        eprintln!("skipped: fixture {fixture} is not on this checkout (gitignored)");
        return;
    };
    let lines = complete_lines(&raw);
    let total = lines.len();
    assert_eq!(
        total, 9291,
        "the fixture's own line count — a mismatch means a different file was copied in"
    );

    fn has_open_ask(snap: &ChatSnapshot) -> bool {
        snap.turns.iter().any(|t| {
            t.role == "assistant"
                && t.blocks.iter().any(|b| {
                    b.tool.as_deref() == Some("AskUserQuestion")
                        && b.ask.is_some()
                        && b.tool_id.as_deref().is_some_and(|id| {
                            !snap.results.iter().any(|r| r.tool_id == id)
                        })
                })
        })
    }

    // (1) The full read from scratch — after=0, exactly what Chat's mount-time backfill sends.
    let full = decode_chat_lines(lines.iter().copied(), total);
    assert!(has_open_ask(&full), "after=0 must surface the open ask from the real file");

    // (2) A delta read starting right at the trailing block — after=9288 (0-indexed skip),
    // the shape a re-sync takes once everything before the ask was already seen, which is
    // exactly the blocked-no-ask retry loop's own path.
    let after = 9288;
    let delta = decode_chat_lines(lines.iter().copied().skip(after), total);
    assert!(
        has_open_ask(&delta),
        "after=9288 (the trailing block alone) must also surface the open ask"
    );
}

#[test]
fn tool_result_preview_handles_both_shapes_git_actually_writes() {
    assert_eq!(preview_of(&serde_json::json!("done")), "done");
    let blocks = serde_json::json!([{ "type": "text", "text": "line one" }, { "type": "text", "text": "line two" }]);
    assert_eq!(preview_of(&blocks), "line one\nline two");
    assert_eq!(preview_of(&serde_json::Value::Null), "");
}

#[test]
fn transcript_tail_buffers_partial_line_until_newline() {
    let mut tail = TranscriptTail::default();
    let (after, lines, total) = tail.push_chunk(r#"{"type":"assistant""#);
    assert_eq!(after, 0);
    assert!(lines.is_empty());
    assert_eq!(total, 0);

    let (after, lines, total) = tail.push_chunk(r#","message":{"content":[]}}"#);
    assert_eq!(after, 0);
    assert!(lines.is_empty());
    assert_eq!(total, 0);

    let (after, lines, total) = tail.push_chunk("\n");
    assert_eq!(after, 0);
    assert_eq!(
        lines,
        vec![r#"{"type":"assistant","message":{"content":[]}}"#.to_string()]
    );
    assert_eq!(total, 1);
}

#[test]
fn transcript_tail_reports_cursor_continuity_by_complete_line() {
    let mut tail = TranscriptTail::default();
    let (after, lines, total) = tail.push_chunk("one\n");
    assert_eq!(after, 0);
    assert_eq!(lines, vec!["one".to_string()]);
    assert_eq!(total, 1);

    let (after, lines, total) = tail.push_chunk("two\nthree\n");
    assert_eq!(after, 1);
    assert_eq!(lines, vec!["two".to_string(), "three".to_string()]);
    assert_eq!(total, 3);
}

#[test]
fn transcript_tail_seeds_existing_partial_without_marking_it_seen() {
    let mut tail = TranscriptTail::default();
    tail.seed_from_raw("one\ntwo");
    assert_eq!(tail.line_offset, 1);

    let (after, lines, total) = tail.push_chunk("\n");
    assert_eq!(after, 1);
    assert_eq!(lines, vec!["two".to_string()]);
    assert_eq!(total, 2);
}

#[test]
fn transcript_tail_rotation_restarts_from_line_zero() {
    let root = temp_dir("tail-rotation");
    let path = root.join("session.jsonl");
    fs::write(&path, "one\ntwo\n").unwrap();
    let mut tail = TranscriptTail::default();

    let (after, lines, total) = tail.read_new_lines(&path).unwrap();
    assert_eq!(after, 0);
    assert_eq!(lines, vec!["one".to_string(), "two".to_string()]);
    assert_eq!(total, 2);

    fs::write(&path, "new\n").unwrap();
    let (after, lines, total) = tail.read_new_lines(&path).unwrap();
    assert_eq!(after, 0);
    assert_eq!(lines, vec!["new".to_string()]);
    assert_eq!(total, 1);
}

#[test]
fn file_tree_status_marks_the_file_and_every_folder_above_it() {
    let m =
        parse_status_porcelain(" M bin/crew.sh\n?? desktop/src/features/workspace/new.tsx\n");
    assert_eq!(m.get("bin/crew.sh"), Some(&"M".to_string()));
    // a closed folder must still show that something inside it changed
    assert_eq!(m.get("bin"), Some(&"M".to_string()));
    assert_eq!(
        m.get("desktop/src/features/workspace"),
        Some(&"??".to_string())
    );
    assert_eq!(m.get("README.md"), None);
}

#[test]
fn file_tree_status_follows_a_rename_to_its_new_name() {
    let m = parse_status_porcelain("R  old/a.ts -> src/b.ts\n");
    assert_eq!(m.get("src/b.ts"), Some(&"R".to_string()));
    assert_eq!(m.get("old/a.ts"), None);
}

#[test]
fn seat_diff_parses_numstat_and_untracked_porcelain() {
    let files = parse_numstat("12\t3\tsrc/lib.rs\n-\t-\tassets/icon.png\n");
    assert_eq!(
        files[0],
        SeatDiffFile {
            path: "src/lib.rs".into(),
            plus: Some(12),
            minus: Some(3),
            untracked: false
        }
    );
    assert_eq!(
        files[1],
        SeatDiffFile {
            path: "assets/icon.png".into(),
            plus: None,
            minus: None,
            untracked: false
        }
    );
    assert_eq!(
        parse_untracked_porcelain(" M src/lib.rs\n?? new-file.txt\n?? nested/path.rs\n"),
        vec![
            SeatDiffFile {
                path: "new-file.txt".into(),
                plus: None,
                minus: None,
                untracked: true
            },
            SeatDiffFile {
                path: "nested/path.rs".into(),
                plus: None,
                minus: None,
                untracked: true
            },
        ]
    );
}

#[test]
fn seat_diff_reports_branch_base_files_patch_and_truncation() {
    let root = temp_dir("seat-diff");
    let source = root.join("repo");
    fs::create_dir_all(&source).unwrap();
    git(&source, &["init", "-q", "-b", "main"]);
    git(&source, &["config", "user.email", "trantor@example.test"]);
    git(&source, &["config", "user.name", "Trantor Test"]);
    fs::write(source.join("tracked.txt"), "one\n").unwrap();
    fs::write(source.join("binary.bin"), [0u8, 1, 2, 3]).unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-q", "-m", "base"]);

    let bus = root.join("bus");
    let wt = bus.join("worktrees/demo/codex");
    fs::create_dir_all(wt.parent().unwrap()).unwrap();
    git(
        &source,
        &[
            "worktree",
            "add",
            "-q",
            "-B",
            "seat/codex",
            wt.to_str().unwrap(),
            "HEAD",
        ],
    );
    fs::write(wt.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
    fs::write(wt.join("new.txt"), "new\n").unwrap();
    let diff = seat_diff_from_bus_dir(&bus, "demo", "codex").unwrap();

    assert_eq!(diff.branch, "seat/codex");
    assert_eq!(diff.base.len(), 40);
    assert!(diff.files.contains(&SeatDiffFile {
        path: "tracked.txt".into(),
        plus: Some(2),
        minus: Some(0),
        untracked: false
    }));
    assert!(diff.files.contains(&SeatDiffFile {
        path: "new.txt".into(),
        plus: None,
        minus: None,
        untracked: true
    }));
    assert!(diff.patch.contains("two"));
    assert!(!diff.truncated);

    let huge = vec![b'x'; 400_010];
    let (patch, truncated) = cap_patch(&huge);
    assert_eq!(patch.len(), 400_000);
    assert!(truncated);
}
