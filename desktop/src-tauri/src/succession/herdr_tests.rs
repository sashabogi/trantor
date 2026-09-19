use super::*;
use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let p = std::env::temp_dir().join(format!("trantor-{name}-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&p).unwrap();
    p
}

pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
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
