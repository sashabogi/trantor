// #14030: every state and the feature range are pure functions of the table + the raw
// `--version` output, so no test needs to spawn a CLI. Slice 2: the update's argv, cap and
// re-probe sequence, and the before-update session filter, all with injected fakes — no real
// updater ever runs from a test.
use super::*;

const SPEC: &AgentCliSpec = &AGENT_CLIS[0];

fn claude() -> &'static AgentCliSpec {
    AGENT_CLIS.iter().find(|s| s.cli == "claude").expect("claude row")
}

#[test]
fn version_parse_accepts_the_claude_code_suffix_and_rejects_non_versions() {
    assert_eq!(release_version_parts("2.1.326 (Claude Code)").as_deref(), Some(&[2, 1, 326][..]));
    assert_eq!(release_version_parts("  2.1.326 (Claude Code)  ").as_deref(), Some(&[2, 1, 326][..]));
    assert_eq!(release_version_parts("2.1.326").as_deref(), Some(&[2, 1, 326][..]));
    assert_eq!(release_version_parts("v2.1.326").as_deref(), Some(&[2, 1, 326][..]));
    assert_eq!(release_version_parts("2.1").map(|p| p.len()), None);
    assert_eq!(release_version_parts("Claude Code 2.1.326").map(|p| p.len()), None);
    assert_eq!(release_version_parts("").map(|p| p.len()), None);
}

#[test]
fn the_table_only_declares_versions_that_parse() {
    for spec in AGENT_CLIS {
        assert!(release_version_parts(spec.minimum).is_some(), "{} minimum", spec.cli);
        assert!(release_version_parts(spec.verified_up_to).is_some(), "{} verified_up_to", spec.cli);
        for f in spec.features {
            assert!(release_version_parts(f.verified_from).is_some(), "{} {}", spec.cli, f.name);
            assert!(release_version_parts(f.verified_to).is_some(), "{} {}", spec.cli, f.name);
        }
    }
}

#[test]
fn each_state_classifies_against_the_rust_owned_table() {
    let below = compatibility(SPEC, Some("2.1.100 (Claude Code)"));
    assert_eq!(below.state, "below_minimum");
    assert_eq!(below.installed.as_deref(), Some("2.1.100"));
    let reason = below.reason.expect("below minimum carries a reason");
    assert!(reason.contains("Mode menu needs 2.1.326"), "{reason}");
    assert!(reason.contains("reads the mode line"), "{reason}");

    assert_eq!(compatibility(SPEC, Some("2.1.215")).state, "ok");
    assert_eq!(compatibility(SPEC, Some("2.1.326 (Claude Code)")).state, "ok");
    assert_eq!(compatibility(SPEC, Some("2.1.326 (Claude Code)")).reason, None);

    let newer = compatibility(SPEC, Some("2.1.400"));
    assert_eq!(newer.state, "newer_than_verified");
    let reason = newer.reason.expect("newer than verified carries the quiet line");
    assert!(reason.contains("newer than the newest release Trantor has verified (2.1.326)"), "{reason}");
    assert!(reason.contains("Mode menu was verified on 2.1.326..2.1.326"), "{reason}");

    assert_eq!(compatibility(SPEC, None).state, "not_installed");
    assert_eq!(compatibility(SPEC, None).installed, None);
}

#[test]
fn an_unreadable_version_never_fires_the_banner_but_shows_the_raw_output() {
    let unreadable = compatibility(SPEC, Some("something went wrong"));
    assert_eq!(unreadable.state, "not_installed");
    assert_eq!(unreadable.installed.as_deref(), Some("something went wrong"));
    let reason = unreadable.reason.expect("the raw output is named");
    assert!(reason.contains("could not be read"), "{reason}");
    assert!(unreadable.features.iter().all(|f| !f.in_range));
}

#[test]
fn a_feature_is_in_range_only_inside_its_verified_range() {
    let in_range = compatibility(SPEC, Some("2.1.326"));
    assert_eq!(in_range.features.len(), 1);
    assert!(in_range.features[0].in_range);

    // Inside the app's range but outside the feature's: the CLI reads ok, the feature says so.
    let below_feature = compatibility(SPEC, Some("2.1.220"));
    assert_eq!(below_feature.state, "ok");
    assert!(!below_feature.features[0].in_range);
    assert!(below_feature.reason.is_none());

    let above_feature = compatibility(SPEC, Some("2.1.400"));
    assert!(!above_feature.features[0].in_range);
    assert_eq!(compatibility(SPEC, None).features[0].in_range, false);
}

#[test]
fn the_update_command_is_the_verified_cli_owned_updater() {
    let report = compatibility(claude(), Some("2.1.100"));
    assert_eq!(report.update_command, Some("claude update"));
    assert_eq!(report.cli, "claude");
    assert_eq!(report.label, "Claude Code");
}

// ── update, on a click only (#14030 slice 2) ───────────────────────────────────────────────────

/// A CLI whose updater could not be confirmed: the update refuses rather than guessing (#14030).
#[test]
fn update_refuses_a_cli_without_a_command() {
    let spec = AgentCliSpec {
        cli: "mystery",
        label: "Mystery CLI",
        minimum: "1.0.0",
        verified_up_to: "1.0.0",
        update_command: None,
        features: &[],
    };
    let err = update_argv(&spec).expect_err("a None command must refuse");
    assert!(err.contains("no confirmed update command"), "{err}");
    assert!(err.contains("update it the way you installed it"), "{err}");
}

#[test]
fn the_updater_runs_as_argv_never_a_shell() {
    let argv = update_argv(claude()).expect("claude's command is confirmed");
    assert_eq!(argv, vec!["claude".to_string(), "update".to_string()]);
}

#[test]
fn updater_output_is_capped_tail_kept() {
    let tiny = "all good\n";
    assert_eq!(cap_output(tiny), tiny);
    let huge = "A".repeat(OUTPUT_CAP + 5000);
    let capped = cap_output(&huge);
    assert!(capped.len() <= OUTPUT_CAP + 4, "the cap bounds the answer: {}", capped.len());
    assert!(capped.starts_with('…'), "truncation says so");
    assert!(capped.ends_with(&"A".repeat(10)), "the tail survives — failures read their last lines");
    // A cut landing mid-multibyte still yields valid text, never a panic.
    let multibyte = "é".repeat(OUTPUT_CAP / 2 + 40);
    assert!(cap_output(&multibyte).chars().all(|c| c == '…' || c == 'é'));
}

#[tokio::test]
async fn the_update_reprobes_the_version_after_running_the_updater() {
    let probes = std::sync::Mutex::new(Vec::new());
    let ran = std::sync::Mutex::new(0);
    let result = agent_cli_update_seams(
        claude(),
        || {
            probes.lock().unwrap().push("probe");
            async {
                let n = probes.lock().unwrap().len();
                Some(if n == 1 { "2.1.100" } else { "2.1.326" }.to_string())
            }
        },
        || {
            *ran.lock().unwrap() += 1;
            async { Ok((true, "updated to 2.1.326".to_string())) }
        },
    )
    .await
    .expect("the seams never spawn anything real");
    assert_eq!(*probes.lock().unwrap(), vec!["probe", "probe"], "probe runs before AND after");
    assert_eq!(*ran.lock().unwrap(), 1, "the updater itself runs once");
    assert_eq!(
        result,
        AgentCliUpdate {
            ok: true,
            before: Some("2.1.100".into()),
            after: Some("2.1.326".into()),
            output: "updated to 2.1.326".into(),
        }
    );
}

#[tokio::test]
async fn a_failed_updater_reports_not_ok_with_its_output() {
    let result = agent_cli_update_seams(
        claude(),
        || async { Some("2.1.100".to_string()) },
        || async { Err("npm ERR! network".to_string()) },
    )
    .await
    .expect("a failed updater is a report, not an exception");
    assert!(!result.ok);
    assert_eq!(result.before.as_deref(), Some("2.1.100"));
    assert!(result.output.contains("npm ERR! network"));
    assert_eq!(result.after, Some("2.1.100".to_string()), "the re-probe still runs");
}

// ── sessions still on the old binary (#14030 slice 2) ─────────────────────────────────────────

fn candidate(project: &str, seat: &str, restart: &'static str, started_ms: Option<u64>) -> SessionCandidate {
    SessionCandidate { project: project.into(), seat: seat.into(), restart, started_ms }
}

#[test]
fn the_before_update_session_filter_classifies_with_fake_sessions() {
    let candidates = vec![
        candidate("trantor", "orchestrator", "handoff", Some(1_000)),
        candidate("crebral", "codex", "agents", Some(2_000)),
        candidate("fresh", "orchestrator", "handoff", Some(4_000)),
        candidate("bare", "claude", "none", None),
    ];
    // Binary changed at 3_000: started before → listed; an unknown start → may-be-old.
    let rows = stale_sessions(&candidates, Some(3_000));
    assert_eq!(
        rows,
        vec![
            StaleSessionRow { project: "trantor".into(), seat: "orchestrator".into(), restart: "handoff", stale: "before_update" },
            StaleSessionRow { project: "crebral".into(), seat: "codex".into(), restart: "agents", stale: "before_update" },
            StaleSessionRow { project: "bare".into(), seat: "claude".into(), restart: "none", stale: "may_be_old" },
        ]
    );
    // Started at/after the change: the session runs the new binary and stays off the list.
    assert!(!rows.iter().any(|r| r.project == "fresh"), "the fresh session is not listed");
    assert!(stale_sessions(&[candidate("trantor", "orchestrator", "handoff", Some(3_000))], Some(3_000)).is_empty());
    // No binary mtime: nothing can be claimed, so every row is honestly may-be-old.
    let all_may = stale_sessions(&candidates, None);
    assert_eq!(all_may.len(), candidates.len());
    assert!(all_may.iter().all(|r| r.stale == "may_be_old"));
    assert!(stale_sessions(&[], Some(3_000)).is_empty());
}
