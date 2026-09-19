use super::*;
use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let p = std::env::temp_dir().join(format!("trantor-{name}-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&p).unwrap();
    p
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn herdr_seat_rows_keep_only_last_modern_herdr_entry() {
    let rows = [
        "legacy-agent\tterminal-1",
        "trantor\therdr\tcodex\tpane-old",
        "trantor\tcmux\tglm\tsurface-no",
        "trantor\therdr\tcodex\tpane-new",
        "other\therdr\tkimi\tpane-k",
    ]
    .join("\n");
    let seats = parse_herdr_seats(&rows);
    assert_eq!(
        seats,
        vec![
            HerdrSeat {
                project: "other".into(),
                agent: "kimi".into(),
                surface: "pane-k".into(),
                kind: "herdr".into()
            },
            HerdrSeat {
                project: "trantor".into(),
                agent: "codex".into(),
                surface: "pane-new".into(),
                kind: "herdr".into()
            },
        ]
    );
}

#[test]
fn herdr_seat_rows_carry_the_orchestrator_pane() {
    // `trantor open` records kind `orch` into the same file as the crew seats. Dropping it was
    // why a live orchestrator pane existed on disk and in herdr but never in the app.
    let rows = [
        "trantor\therdr\tcodex\tw2:p1",
        "trantor\torch\t__orch__\tw2:p5",
    ]
    .join("\n");
    let seats = parse_herdr_seats(&rows);
    assert_eq!(
        seats,
        vec![
            HerdrSeat {
                project: "trantor".into(),
                agent: "codex".into(),
                surface: "w2:p1".into(),
                kind: "herdr".into()
            },
            HerdrSeat {
                project: "trantor".into(),
                agent: "orchestrator".into(),
                surface: "w2:p5".into(),
                kind: "orch".into()
            },
        ]
    );
}

#[test]
fn herdr_seat_rows_still_drop_other_muxes() {
    let rows = [
        "trantor\tcmux\tglm\tsurface-no",
        "trantor\therdrws\t__ws__\tw2",
    ]
    .join("\n");
    assert_eq!(parse_herdr_seats(&rows), vec![]);
}

#[test]
fn handoff_command_args_are_write_only_and_same_pane() {
    assert_eq!(trantor_handoff_args(None), ["handoff", "--write-only"]);
    assert_eq!(trantor_reopen_args("trantor"), ["open", "trantor"]);
    assert_eq!(
        trantor_takeover_args("trantor"),
        ["takeover", "trantor", "--json"]
    );
}

#[test]
fn handoff_reopen_names_the_clicked_project_under_a_badged_env() {
    // The #7414 incident: the app launched from a badged pane ran a bare `trantor open` and
    // reattached to the badge's orchestrator instead of the clicked project's.
    let badge = [
        ("TRANTOR_ORCH", "other"),
        ("TRANTOR_SEAT", "codex"),
        ("RELAY_PROJECT", "other"),
        ("RELAY_URL", "http://other.invalid"),
        ("CLAUDECODE", "1"),
        ("CLAUDE_CODE_SESSION_ID", "badge"),
        ("CLAUDE_PID", "1"),
        ("HERDR_PANE_ID", "w2R:p1"),
        ("HERDR_WORKSPACE_ID", "w2R"),
        ("HERDR_TAB_ID", "t1"),
    ];
    for (key, value) in badge {
        std::env::set_var(key, value);
    }
    let reopen = reopen_command("crebral-scribe", Path::new("/tmp/crebral-scribe"));
    let spawned = reopen.as_std();
    let args: Vec<String> = spawned
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let leaked: Vec<String> = spawned
        .get_envs()
        .filter(|(_, value)| value.is_some())
        .map(|(key, _)| key.to_string_lossy().into_owned())
        .filter(|key| identity_env::is_identity_key(std::ffi::OsStr::new(key)))
        .collect();
    for (key, _) in badge {
        std::env::remove_var(key);
    }
    assert_eq!(&args[args.len() - 2..], ["open", "crebral-scribe"]);
    assert_eq!(
        spawned.get_current_dir(),
        Some(Path::new("/tmp/crebral-scribe"))
    );
    assert!(leaked.is_empty(), "badge leaked into the successor: {leaked:?}");
}

#[test]
fn orch_pane_resolves_the_last_project_orch_row() {
    let rows = [
        "trantor\torch\t__orch__\tw2:old",
        "trantor\therdr\tcodex\tw2:seat",
        "other\torch\t__orch__\tw9:other",
        "trantor\torch\t__orch__\tw2:new",
        "trantor\torch\t__orch__\t ",
    ]
    .join("\n");
    assert_eq!(
        orch_pane_from_rows(&rows, "trantor").as_deref(),
        Some("w2:new")
    );
}

#[test]
fn orch_projects_from_rows_lists_every_project_with_an_orch_row() {
    let rows = [
        "pr-os\torch\t__orch__\twH:p1",
        "pr-os\therdr\tcodex\twH:p2",
        "trantor\torch\t__orch__\tw2:old",
        "trantor\torch\t__orch__\tw2:new",
    ]
    .join("\n");
    assert_eq!(
        orch_projects_from_rows(&rows),
        vec![
            ("pr-os".to_string(), "wH:p1".to_string()),
            // last row wins per project, same rule as orch_pane_from_rows
            ("trantor".to_string(), "w2:new".to_string()),
        ]
    );
}

#[test]
fn local_sessions_merge_counts_a_herdr_only_pane_as_open() {
    // #6163 — pr-os's orch pane never showed up in pgrep/lsof (a freshly-woken pane herdr
    // still resolves an agent for, with no local process and no heartbeat yet), so process
    // truth alone drops it entirely. herdr's own answer must still count it as open.
    let rows = merge_local_sessions(vec![], vec![("pr-os".to_string(), "working".to_string())]);
    assert_eq!(
        rows,
        vec![LocalSessionRow { project: "pr-os".to_string(), status: Some("working".to_string()) }]
    );
}

#[test]
fn local_sessions_merge_prefers_herdr_status_over_bare_process_truth() {
    let rows = merge_local_sessions(
        vec!["pr-os".to_string()],
        vec![("pr-os".to_string(), "idle".to_string())],
    );
    assert_eq!(
        rows,
        vec![LocalSessionRow { project: "pr-os".to_string(), status: Some("idle".to_string()) }]
    );
}

#[test]
fn local_sessions_merge_keeps_a_process_only_project_with_no_status() {
    // A project process truth sees but herdr never answered for (no orch row, or herdr
    // unreachable) still counts as open — just without a status word to show.
    let rows = merge_local_sessions(vec!["crebral-health".to_string()], vec![]);
    assert_eq!(
        rows,
        vec![LocalSessionRow { project: "crebral-health".to_string(), status: None }]
    );
}

#[test]
fn process_info_prefers_the_foreground_process_group_id() {
    let raw = serde_json::json!({
        "result": {
            "process_info": {
                "foreground_process_group_id": 23311,
                "foreground_processes": [
                    { "name": "node", "pid": 10 },
                    { "name": "claude.exe", "pid": 20 }
                ]
            }
        }
    })
    .to_string();
    assert_eq!(foreground_pid_from_process_info(&raw), Some(23311));
}

// #6668: the pane's claude had exited and the foreground process group WAS the pane's zsh.
// The shell is never the process to end, by shell_pid or by name; a shell-only foreground answers None.
#[test]
fn process_info_never_returns_the_panes_shell() {
    let bare_shell = serde_json::json!({
        "result": {
            "process_info": {
                "foreground_process_group_id": 80368,
                "foreground_processes": [
                    { "name": "zsh", "argv0": "-zsh", "pid": 80368 }
                ],
                "shell_pid": 80368
            }
        }
    })
    .to_string();
    assert_eq!(foreground_pid_from_process_info(&bare_shell), None);

    // shell_pid names it even when the entry carries no name
    let by_shell_pid = serde_json::json!({
        "result": {
            "process_info": {
                "foreground_process_group_id": 80368,
                "foreground_processes": [{ "pid": 80368 }],
                "shell_pid": 80368
            }
        }
    })
    .to_string();
    assert_eq!(foreground_pid_from_process_info(&by_shell_pid), None);

    // the name names it even when shell_pid is absent (an older herdr)
    let by_name = serde_json::json!({
        "result": {
            "process_info": {
                "foreground_process_group_id": 4242,
                "foreground_processes": [{ "name": "bash", "pid": 4242 }]
            }
        }
    })
    .to_string();
    assert_eq!(foreground_pid_from_process_info(&by_name), None);

    // the last-entry fallback skips the shell too
    let shell_last = serde_json::json!({
        "result": {
            "process_info": {
                "foreground_processes": [
                    { "name": "node", "pid": 10 },
                    { "name": "/bin/zsh", "pid": 11 }
                ],
                "shell_pid": 11
            }
        }
    })
    .to_string();
    assert_eq!(foreground_pid_from_process_info(&shell_last), Some(10));
}

#[test]
fn process_info_with_a_live_agent_still_ends_the_agent() {
    // The live shape from herdr pane process-info: the group id is claude's pid, MCP children
    // follow it, and shell_pid is the pane's zsh.
    let live = serde_json::json!({
        "result": {
            "process_info": {
                "foreground_process_group_id": 87044,
                "foreground_processes": [
                    { "name": "node", "argv0": "node", "pid": 87076 },
                    { "name": "claude.exe", "argv0": "claude", "pid": 87044 }
                ],
                "shell_pid": 2309
            }
        }
    })
    .to_string();
    assert_eq!(foreground_pid_from_process_info(&live), Some(87044));
}

#[test]
fn handoff_refuses_a_pane_without_an_agent() {
    // herdr answers nothing for a pane holding a bare shell — the 12:35 pane.
    let why = handoff_refusal("w9:p1", None).expect("refused");
    assert!(why.contains("no live agent"), "{why}");
    assert!(why.contains("w9:p1"), "{why}");
    assert!(handoff_refusal("w9:p1", Some("")).is_some());
    assert!(handoff_refusal("w9:p1", Some("none")).is_some());
    // any real status word — the agent is there; the idle gate decides WHEN, not whether
    for st in ["working", "idle", "blocked", "busy", "done"] {
        assert_eq!(handoff_refusal("w9:p1", Some(st)), None, "{st}");
    }
}

#[test]
fn process_info_can_fall_back_to_the_claude_process() {
    let raw = serde_json::json!({
        "result": {
            "process_info": {
                "foreground_processes": [
                    { "name": "node", "pid": 10 },
                    { "argv0": "claude", "pid": 20 },
                    { "name": "helper", "pid": 30 }
                ]
            }
        }
    })
    .to_string();
    assert_eq!(foreground_pid_from_process_info(&raw), Some(20));
}

#[test]
fn lsof_pid_cwds_keep_pid_context() {
    let raw =
        "p111\nfcwd\nn/Users/s/development/trantor\np222\nfcwd\nn/Users/s/development/other\n";
    assert_eq!(
        parse_lsof_pid_cwds(raw),
        vec![
            (111, "/Users/s/development/trantor".into()),
            (222, "/Users/s/development/other".into())
        ]
    );
}

#[test]
fn crew_runner_pids_match_the_project_dir_argv() {
    let raw = "101 node /x/crew-runner.mjs codex /Users/s/.agent-bus/worktrees/trantor/codex\n102 node /x/crew-runner.mjs glm /Users/s/.agent-bus/worktrees/other/glm\n";
    assert_eq!(parse_crew_runner_pids(raw, "codex"), vec![101]);
    assert_eq!(parse_crew_runner_pids(raw, "glm"), vec![102]);
}

#[test]
fn project_sessions_json_assembles_pane_terminal_and_seat_rows() {
    let crew_rows = [
        "trantor\torch\t__orch__\tpane-1",
        "trantor\therdr\tcodex\tseat-pane",
    ]
    .join("\n");
    let orch_rows = "other\told\ntrantor\tsid-pane\n";
    let agents = serde_json::json!({
        "result": { "agents": [
            { "pane_id": "pane-1", "agent_status": "idle" }
        ]}
    })
    .to_string();
    let proc = serde_json::json!({
        "result": { "process_info": { "foreground_process_group_id": 700 } }
    })
    .to_string();
    let raw = project_sessions_json(
        "trantor",
        &crew_rows,
        orch_rows,
        &agents,
        Some(&proc),
        vec![701],
        vec![TranscriptCandidate {
            session_id: "sid-term".into(),
            active_ago_sec: 42,
            transcript: "/tmp/sid-term.jsonl".into(),
        }],
        vec![990],
    );
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["sessions"][0]["kind"], "pane");
    assert_eq!(v["sessions"][0]["pid"], 700);
    assert_eq!(v["sessions"][0]["sessionId"], "sid-pane");
    assert_eq!(v["sessions"][0]["state"], "idle");
    assert_eq!(v["sessions"][1]["kind"], "terminal");
    assert_eq!(v["sessions"][1]["pid"], 701);
    assert_eq!(v["sessions"][1]["sessionId"], "sid-term");
    assert_eq!(v["sessions"][1]["activeAgoSec"], 42);
    assert_eq!(v["sessions"][1]["transcript"], "/tmp/sid-term.jsonl");
    assert_eq!(v["sessions"][2]["kind"], "seat");
    assert_eq!(v["sessions"][2]["pid"], 990);
}

#[test]
fn project_sessions_json_excludes_the_pane_pid_from_terminal_sessions() {
    let crew_rows = "trantor\torch\t__orch__\tpane-1\n";
    let agents = serde_json::json!({
        "result": { "agents": [
            { "pane_id": "pane-1", "agent_status": "working" }
        ]}
    })
    .to_string();
    let proc = serde_json::json!({
        "result": { "process_info": { "foreground_process_group_id": 700 } }
    })
    .to_string();
    let raw = project_sessions_json(
        "trantor",
        crew_rows,
        "",
        &agents,
        Some(&proc),
        vec![700, 701],
        vec![TranscriptCandidate {
            session_id: "sid-term".into(),
            active_ago_sec: 12,
            transcript: "/tmp/sid-term.jsonl".into(),
        }],
        vec![],
    );
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["sessions"][0]["kind"], "pane");
    assert_eq!(v["sessions"][1]["kind"], "terminal");
    assert_eq!(v["sessions"][1]["pid"], 701);
}

#[test]
fn project_sessions_json_preserves_two_recent_transcript_candidates() {
    let raw = project_sessions_json(
        "trantor",
        "",
        "",
        "",
        None,
        vec![301],
        vec![
            TranscriptCandidate {
                session_id: "newest".into(),
                active_ago_sec: 8,
                transcript: "/tmp/newest.jsonl".into(),
            },
            TranscriptCandidate {
                session_id: "older".into(),
                active_ago_sec: 700,
                transcript: "/tmp/older.jsonl".into(),
            },
        ],
        vec![],
    );
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(v["sessions"][0]["sessionId"], "newest");
    assert_eq!(v["sessions"][0]["pid"], 301);
    assert_eq!(v["sessions"][1]["sessionId"], "older");
    assert_eq!(v["sessions"][1]["pid"], 301);
}

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
