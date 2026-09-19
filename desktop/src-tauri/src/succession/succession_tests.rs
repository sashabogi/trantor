#[allow(unused_imports)]
use super::*;

use super::*;

// #5649 SUCCESSION rust: handoff_now(reason) · autonomy_set shells the CLI dial ·
// kickoff-after-reopen boot prompt via the herdr socket. These drills cover the pure parts of
// all three so the command wiring has a test bed without a live herdr/trantor to shell.

#[test]
fn handoff_reasons_are_exactly_the_three_declared_values() {
    assert_eq!(HANDOFF_REASONS, &["clicked", "countdown", "unattended"]);
}

#[test]
fn handoff_args_carry_the_reason_when_present() {
    assert_eq!(
        trantor_handoff_args(Some("clicked")),
        vec!["handoff", "--write-only", "--reason", "clicked"]
    );
    assert_eq!(
        trantor_handoff_args(Some("countdown")),
        vec!["handoff", "--write-only", "--reason", "countdown"]
    );
    assert_eq!(
        trantor_handoff_args(Some("unattended")),
        vec!["handoff", "--write-only", "--reason", "unattended"]
    );
}

#[test]
fn handoff_args_stay_backward_compatible_without_a_reason() {
    // The pre-#5649 call shape (frontend omitting reason) must still produce the old command.
    assert_eq!(trantor_handoff_args(None), vec!["handoff", "--write-only"]);
}

#[test]
fn handoff_force_args_extend_the_write_only_command() {
    // #6528: the boundary-deadline leg — same command the chain already runs, plus --force
    // so the CLI writes past the boundary gate.
    assert_eq!(
        trantor_handoff_force_args(Some("unattended")),
        vec!["handoff", "--write-only", "--reason", "unattended", "--force"]
    );
}

#[test]
fn armed_marker_matches_only_the_armed_line() {
    // #6528: "handoff saved" (the gate passed, record written) must NOT read as armed.
    assert!(handoff_armed("⏸ handoff armed — it fires when this turn finishes"));
    assert!(!handoff_armed("📋 handoff saved for trantor: /tmp/x.json"));
    assert!(!handoff_armed(""));
}

#[test]
fn boundary_wait_passes_only_on_a_newer_record() {
    // #6528: the wait's whole job — hold until the Stop hook's record lands, then pass;
    // a record from BEFORE the chain started (a stale sibling) must not pass it.
    let deadline = Duration::from_secs(100);
    assert!(matches!(
        boundary_wait_step(0, 500, Duration::from_secs(1), deadline),
        BoundaryStep::Wait
    ));
    assert!(matches!(
        boundary_wait_step(500, 500, Duration::from_secs(1), deadline),
        BoundaryStep::Wait // same stamp = not new
    ));
    assert!(matches!(
        boundary_wait_step(501, 500, Duration::from_secs(1), deadline),
        BoundaryStep::Pass
    ));
    assert!(matches!(
        boundary_wait_step(0, 500, Duration::from_secs(100), deadline),
        BoundaryStep::Deadline
    ));
}

#[test]
fn newest_unconsumed_stamp_reads_project_records() {
    let dir = std::env::temp_dir().join(format!("trantor-boundary-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("trantor-100.json"), r#"{"consumed":true}"#).unwrap();
    std::fs::write(dir.join("trantor-200.json"), r#"{"consumed":false}"#).unwrap();
    std::fs::write(dir.join("other-900.json"), r#"{"consumed":false}"#).unwrap();
    std::fs::write(dir.join("trantor-notstamp.json"), "{}").unwrap();
    assert_eq!(newest_unconsumed_stamp(&dir, "trantor"), 200);
    assert_eq!(newest_unconsumed_stamp(&dir, "missing"), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn policy_bridge_args_are_the_cli_contract() {
    assert_eq!(
        trantor_policy_args("set", &[String::from("trantor")], Some(3), None).unwrap(),
        vec!["policy", "set", "trantor", "3"]
    );
    assert_eq!(
        trantor_policy_args(
            "link",
            &[
                String::from("crebral-health"),
                String::from("crebral-scribe")
            ],
            None,
            Some("shared schema")
        )
        .unwrap(),
        vec![
            "policy",
            "link",
            "crebral-health",
            "crebral-scribe",
            "--reason",
            "shared schema"
        ]
    );
    assert_eq!(
        trantor_policy_args(
            "unlink",
            &[
                String::from("crebral-health"),
                String::from("crebral-scribe")
            ],
            None,
            None
        )
        .unwrap(),
        vec!["policy", "unlink", "crebral-health", "crebral-scribe"]
    );
}

#[test]
fn policy_bridge_rejects_unsafe_or_incomplete_args() {
    assert!(trantor_policy_args("set", &[String::from("trantor")], Some(5), None).is_err());
    assert!(trantor_policy_args("link", &[String::from("trantor")], None, Some("x")).is_err());
    assert!(trantor_policy_args(
        "link",
        &[String::from("trantor"), String::from("teams")],
        None,
        Some("")
    )
    .is_err());
    assert!(
        trantor_policy_args("set", &[String::from("bad\nproject")], Some(2), None).is_err()
    );
}

#[test]
fn kickoff_prompt_is_the_fixed_recap_instruction() {
    // The one line the successor sees after the pane reopens. If this changes, the recap the
    // successor gives changes with it — so it is asserted, not assumed.
    assert_eq!(
        KICKOFF_PROMPT,
        "You have just taken over via handoff. Recap now per your instructions."
    );
}

#[test]
fn every_kickoff_outcome_has_a_human_label() {
    use herdr::PromptOutcome as O;
    for o in [
        O::Delivered,
        O::Blocked,
        O::NotReady,
        O::Stalled,
        O::NoAgent,
    ] {
        let label = kickoff_outcome_label(&o);
        assert!(!label.is_empty(), "outcome {o:?} needs a label");
    }
    assert!(kickoff_outcome_label(&O::Delivered).contains("delivered"));
    assert!(kickoff_outcome_label(&O::Blocked).contains("blocked"));
    assert!(kickoff_outcome_label(&O::NotReady).contains("starting"));
    assert!(kickoff_outcome_label(&O::NoAgent).contains("no agent"));
}

// #6184 — the boot prompt's retry ladder, all six cases (five outcomes + Err). Pure, so the
// whole ladder drills without a herdr socket.
#[test]
fn boot_prompt_retry_decisions() {
    use herdr::PromptOutcome as O;
    // Landed, or parked at a dialog a human must answer: stop trying.
    assert_eq!(boot_prompt_decision(&Ok(O::Delivered), 0), BootPromptDecision::Stop);
    assert_eq!(boot_prompt_decision(&Ok(O::Blocked), 0), BootPromptDecision::Stop);
    // The successor is still booting: keep trying.
    assert_eq!(boot_prompt_decision(&Ok(O::NotReady), 0), BootPromptDecision::Retry);
    assert_eq!(boot_prompt_decision(&Ok(O::NoAgent), 0), BootPromptDecision::Retry);
    // Stalled retries ONCE — the second stall is the answer, not a reason to try again.
    assert_eq!(boot_prompt_decision(&Ok(O::Stalled), 0), BootPromptDecision::Retry);
    assert_eq!(boot_prompt_decision(&Ok(O::Stalled), 1), BootPromptDecision::Stop);
    // herdr unreachable / unreadable is transient by definition: retry until the deadline.
    let err: Result<O, String> = Err("herdr is not reachable".into());
    assert_eq!(boot_prompt_decision(&err, 0), BootPromptDecision::Retry);
}

// #6139 — the ladder both handoff_now and project_wake ride: no prompt goes out before the
// agent reads idle, transient outcomes retry, and the report carries the tries. Driven with
// fake status/prompt closures and a zero cadence, so it runs in milliseconds without herdr.
#[test]
fn kickoff_ladder_waits_for_idle_then_retries_until_delivered() {
    use herdr::PromptOutcome as O;
    use std::cell::{Cell, RefCell};
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    // The successor boots: two polls say "working", the third says idle. The first two sends
    // find it not ready; the third lands. The prompt must not go out while it is booting.
    let polls = Cell::new(0u32);
    let idle_seen_before_send = Cell::new(false);
    let sends = RefCell::new(vec![Ok(O::NotReady), Ok(O::NotReady), Ok(O::Delivered)]);
    let report = rt.block_on(kickoff_ladder(
        || {
            polls.set(polls.get() + 1);
            let s = if polls.get() < 3 { "working" } else { "idle" };
            if s == "idle" {
                idle_seen_before_send.set(true);
            }
            async move { Some(s.to_string()) }
        },
        || {
            assert!(
                idle_seen_before_send.get(),
                "prompt sent before the agent was idle"
            );
            let r = sends.borrow_mut().remove(0);
            async move { r }
        },
        Duration::ZERO,
        Duration::from_secs(5),
        |_, _| {},
    ));
    // 3 gate polls + one retry-guard read before EACH of the two retries (#6201): the guard
    // re-asks the pane before re-sending, and both reads say idle here.
    assert_eq!(polls.get(), 5);
    assert_eq!(report.attempts, 3);
    assert!(matches!(report.outcome, Ok(O::Delivered)));

    // No agent ever reads idle and every send is NotReady: both phases run out their budget,
    // the last outcome is reported honestly, and at least one send was attempted.
    let report = rt.block_on(kickoff_ladder(
        || async { None },
        || async { Ok(O::NotReady) },
        Duration::ZERO,
        Duration::from_millis(20),
        |_, _| {},
    ));
    assert!(report.attempts >= 1);
    assert!(matches!(report.outcome, Ok(O::NotReady)));

    // Blocked stops at once: a dialog needs a human, retrying would hammer it.
    let report = rt.block_on(kickoff_ladder(
        || async { Some("idle".to_string()) },
        || async { Ok(O::Blocked) },
        Duration::ZERO,
        Duration::from_secs(5),
        |_, _| {},
    ));
    assert_eq!(report.attempts, 1);
    assert!(matches!(report.outcome, Ok(O::Blocked)));
}

// #6201 — the phase sequence the wake chain forwards to the frontend: waiting for idle,
// kickoff sent, kickoff landed — in that order, exactly once each, and the landed detail
// names the outcome in the operator's words.
#[test]
fn kickoff_ladder_reports_the_phase_sequence() {
    use herdr::PromptOutcome as O;
    use std::cell::RefCell;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let phases: RefCell<Vec<(&'static str, Option<String>)>> = RefCell::new(Vec::new());
    let report = rt.block_on(kickoff_ladder(
        || async { Some("idle".to_string()) },
        || async { Ok(O::Delivered) },
        Duration::ZERO,
        Duration::from_secs(5),
        |phase, detail| phases.borrow_mut().push((phase.as_str(), detail)),
    ));
    assert!(matches!(report.outcome, Ok(O::Delivered)));
    let phases = phases.borrow();
    let names: Vec<&str> = phases.iter().map(|(p, _)| *p).collect();
    assert_eq!(names, ["waiting_idle", "kickoff_sent", "kickoff_landed"]);
    let (_, landed) = phases.last().unwrap();
    assert!(
        landed.as_deref().unwrap_or_default().contains("delivered"),
        "the landed detail must name the outcome, got {landed:?}"
    );
}

// #6201 — the ladder's own error end also lands, with the herdr error verbatim, so the
// frontend's pending label can always clear.
#[test]
fn a_ladder_ended_on_a_herdr_error_lands_with_the_error_verbatim() {
    use std::cell::RefCell;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let landed: RefCell<Option<String>> = RefCell::new(None);
    rt.block_on(kickoff_ladder(
        || async { Some("idle".to_string()) },
        || async { Err("herdr is not reachable".into()) },
        Duration::ZERO,
        Duration::from_secs(5),
        |phase, detail| {
            if phase == KickoffPhase::Landed {
                *landed.borrow_mut() = detail;
            }
        },
    ));
    assert_eq!(landed.borrow().as_deref(), Some("herdr is not reachable"));
}

// #6201 — the double-kickoff guard: tiny-timer's kickoff landed on the first send but herdr
// answered Stalled (no lifecycle change OBSERVED in its window), and the ladder re-typed the
// prompt 16s later into a session already chewing on it. A Stalled send with the pane now
// reading mid-turn must NOT be retried.
#[test]
fn a_stalled_send_with_the_agent_already_working_is_not_retried() {
    use herdr::PromptOutcome as O;
    use std::cell::Cell;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let sent = Cell::new(false);
    let report = rt.block_on(kickoff_ladder(
        // The gate reads idle (the send goes out), then the agent starts OUR prompt.
        || {
            let working = sent.get();
            async move { Some(if working { "working" } else { "idle" }.to_string()) }
        },
        || {
            sent.set(true);
            async { Ok(O::Stalled) }
        },
        Duration::ZERO,
        Duration::from_secs(5),
        |_, _| {},
    ));
    assert!(matches!(report.outcome, Ok(O::Stalled)));
    assert_eq!(report.attempts, 1, "the landed-but-misreported prompt must not be re-sent");
}

// #6201 — the guard must not over-block: a Stalled send with the pane still idle IS a send
// that did not register, and the retry that lands it is the ladder working as designed.
#[test]
fn a_stalled_send_with_an_idle_agent_still_retries() {
    use herdr::PromptOutcome as O;
    use std::cell::{Cell, RefCell};
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let sends = RefCell::new(vec![Ok(O::Stalled), Ok(O::Delivered)]);
    let count = Cell::new(0u32);
    let report = rt.block_on(kickoff_ladder(
        || async { Some("idle".to_string()) },
        || {
            count.set(count.get() + 1);
            let r = sends.borrow_mut().remove(0);
            async move { r }
        },
        Duration::ZERO,
        Duration::from_secs(5),
        |_, _| {},
    ));
    assert_eq!(count.get(), 2);
    assert!(matches!(report.outcome, Ok(O::Delivered)));
}

// #6201 — the retry guard's whole reading table.
#[test]
fn prompt_retry_safe_holds_only_off_a_mid_turn_agent() {
    assert!(!prompt_retry_safe(Some("working")));
    assert!(!prompt_retry_safe(Some("blocked")));
    for reading in [Some("idle"), Some("done"), Some("unknown"), None] {
        assert!(prompt_retry_safe(reading), "reading {reading:?} must not block a retry");
    }
}

// #6184 — the returned label carries the tries and the elapsed time, not just the outcome.
#[test]
fn kickoff_label_names_attempts_and_elapsed() {
    use herdr::PromptOutcome as O;
    let label = kickoff_label(&O::Delivered, 3, 12);
    assert!(label.contains("prompt delivered"), "{label}");
    assert!(label.contains("3 attempt(s)"), "{label}");
    assert!(label.contains("12s"), "{label}");
}

// #6081 — the pre-kill idle gate holds ONLY for an in-flight turn. Every other state —
// idle, blocked at a dialog, done, unknown, no agent at all — passes at once: nothing live
// gets ended, and a dead pane must not stall the chain.
#[test]
fn idle_gate_waits_only_on_in_flight_turns() {
    let budget = Duration::from_secs(120);
    let at = Duration::from_secs(5);
    assert_eq!(idle_gate_step(Some("working"), at, budget), IdleGateStep::Wait);
    assert_eq!(idle_gate_step(Some("busy"), at, budget), IdleGateStep::Wait);
    for status in [Some("idle"), Some("blocked"), Some("done"), Some("unknown"), None] {
        assert_eq!(
            idle_gate_step(status, at, budget),
            IdleGateStep::Pass(IdleGateOutcome::Idle),
            "status {status:?} must pass the gate"
        );
    }
}

// #6081 — the gate is BOUNDED: a turn still running when the budget passes lets the chain
// proceed, and the outcome says so. A status that passes beats the clock even at the wall.
#[test]
fn idle_gate_deadline_ends_the_wait_mid_turn() {
    let budget = Duration::from_secs(120);
    assert_eq!(
        idle_gate_step(Some("working"), budget, budget),
        IdleGateStep::Pass(IdleGateOutcome::Deadline)
    );
    assert_eq!(
        idle_gate_step(Some("working"), budget + Duration::from_secs(30), budget),
        IdleGateStep::Pass(IdleGateOutcome::Deadline)
    );
    assert_eq!(
        idle_gate_step(Some("idle"), budget, budget),
        IdleGateStep::Pass(IdleGateOutcome::Idle)
    );
}

// #6081 — both gate outcomes carry a label, and the deadline one names the honest residual.
#[test]
fn idle_gate_labels_name_both_outcomes() {
    let passed = idle_gate_label(&IdleGateOutcome::Idle, 4);
    assert!(passed.contains("passed"), "{passed}");
    assert!(passed.contains("4s"), "{passed}");
    let late = idle_gate_label(&IdleGateOutcome::Deadline, 120);
    assert!(late.contains("deadline"), "{late}");
    assert!(late.contains("mid-turn"), "{late}");
}

#[test]
fn agent_drop_wait_passes_only_when_herdr_retires_the_agent_and_is_bounded() {
    let deadline = Duration::from_secs(10);
    assert_eq!(
        agent_drop_step(true, Duration::from_millis(9999), deadline),
        AgentDropStep::Wait
    );
    assert_eq!(
        agent_drop_step(false, Duration::from_secs(1), deadline),
        AgentDropStep::Dropped
    );
    assert_eq!(
        agent_drop_step(true, deadline, deadline),
        AgentDropStep::Deadline
    );
}

#[test]
fn trace_summaries_are_one_line_bounded_and_name_empty_streams() {
    assert_eq!(trace_summary(""), "<empty>");
    assert_eq!(trace_summary("first\n second\tthird"), "first second third");
    let long = trace_summary(&"x".repeat(300));
    assert_eq!(long.chars().count(), 240);
    assert!(long.ends_with('…'));
}

// #6081 — the returned line carries the gate outcome NEXT TO the kickoff's: one read says
// how the kill happened and how the boot prompt landed.
#[test]
fn handoff_label_carries_gate_and_kickoff() {
    use herdr::PromptOutcome as O;
    let label = handoff_label(&IdleGateOutcome::Idle, 4, &O::Delivered, 1, 6);
    assert!(label.contains("idle gate passed in 4s"), "{label}");
    assert!(label.contains("prompt delivered"), "{label}");
    let forced = handoff_label(&IdleGateOutcome::Deadline, 120, &O::NotReady, 30, 90);
    assert!(forced.contains("idle gate deadline after 120s"), "{forced}");
    assert!(forced.contains("still starting"), "{forced}");
}

// #5401 — the restore detector's pure half. The reboot shape: orch rows survive in
// crew-windows.txt while herdr's agent list no longer knows their panes.
#[test]
fn restorables_are_orch_rows_without_a_live_agent() {
    let rows = "proj-a\torch\t__orch__\tw1:p1\n\
                proj-a\therdrws\t__ws__\tw1\n\
                proj-b\torch\t__orch__\tw2:p1\n\
                proj-c\therdr\tkimi\tw3:p2\n\
                proj-b\torch\t__orch__\tw2:p9\n";
    let live: std::collections::HashSet<String> = ["w1:p1".to_string()].into();
    // proj-a's agent is alive → not restorable. proj-b's two orch rows dedupe to one entry,
    // keeping its first handle as the session id. proj-c has only a SEAT row — seats belong
    // to the crew, never to restore.
    assert_eq!(
        restorables_from(rows, &live),
        vec![RestorableSession { project: "proj-b".to_string(), session_id: "w2:p1".to_string() }]
    );
    // Nothing tracked, or every agent alive → nothing to restore.
    assert!(restorables_from("", &live).is_empty());
    let all_live: std::collections::HashSet<String> = [
        "w1:p1".to_string(),
        "w2:p1".to_string(),
        "w2:p9".to_string(),
    ]
    .into();
    assert!(restorables_from(rows, &all_live).is_empty());
    // A malformed row never panics and never restores.
    assert!(restorables_from("garbage-no-tabs\n\torch\t\t\n", &live).is_empty());
}
