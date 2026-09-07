//! #6668: the built-app acceptance drill for the handoff entry guard.
//!
//! Witnessed 2026-09-07 12:35: the operator opened the crebral-health Chat onto a pane whose
//! claude had died at 12:16 (a bare zsh, pid 80368), the gauge read the dead transcript at 92%,
//! and app-trace showed "chain started (reason unattended)" then "armed mid-turn". The chain's
//! boundary wait would have expired at 12:52 and TERMed the shell. Two guards now stand in
//! front of that: Chat withholds the banner/countdown/auto-fire unless the pane has a live
//! agent, and `handoff_now` refuses (Err, traced) before writing anything when herdr reports
//! no agent in the orch pane.
//!
//! `TRANTOR_HANDOFF_DRILL=<project>`: after boot the Rust shell emits `handoff-drill`; the
//! frontend (src/features/chat/handoffDrill.ts) opens that project's Chat, watches for a
//! banner and a chain for a while, then invokes `handoff_now` directly and expects the refusal.
//! The verdict reads only what THIS run wrote to app-trace.log: no "chain started" for the
//! project, the Chat's "banner withheld" line, and the "refused" line. Exit 0 on pass, 3
//! otherwise. Inert unless the variable is set. The seat writes this drill; the orchestrator
//! stages a project whose pane is a bare shell at 92% and runs it.

use serde::Serialize;
use std::sync::OnceLock;
use std::time::Duration;

pub const ENV: &str = "TRANTOR_HANDOFF_DRILL";

/// app-trace.log length when the drill was armed: the probe reads only what this run wrote.
static TRACE_START: OnceLock<u64> = OnceLock::new();

fn project_from_env() -> Option<String> {
    let value = std::env::var(ENV).ok()?;
    let value = value.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// In `setup`: when armed, tell the webview to start once it has had time to mount.
pub fn arm(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let Some(project) = project_from_env() else {
        return;
    };
    let _ = TRACE_START.set(trace_len());
    let Some(window) = app.get_webview_window("main") else {
        crate::app_trace("handoff-drill ERROR no main window to drive");
        return;
    };
    crate::app_trace(&format!("handoff-drill armed project={project}"));
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        let _ = window.emit("handoff-drill", project);
    });
}

/// What this run's trace says about the project's handoff path so far.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffDrillProbe {
    /// A "handoff[<project>]: chain started" line — the failure the drill exists to catch.
    pub chain_started: bool,
    /// The Chat's "banner withheld" line: the gauge was over the threshold and it did nothing.
    pub withheld: bool,
    /// The entry guard's "refused" line from a direct handoff_now.
    pub refused: bool,
}

/// Pure: the probe read off the trace text this run wrote.
pub fn probe_from_trace(project: &str, written: &str) -> HandoffDrillProbe {
    let chain = format!("handoff[{project}]: chain started");
    let refused = format!("handoff[{project}]: refused");
    let gauge = format!("chat handoff gauge {project}:");
    let mut out = HandoffDrillProbe { chain_started: false, withheld: false, refused: false };
    for line in written.lines() {
        if line.contains(&chain) {
            out.chain_started = true;
        }
        if line.contains(&refused) {
            out.refused = true;
        }
        if line.contains(&gauge) && line.contains("withheld") {
            out.withheld = true;
        }
    }
    out
}

/// Refuses unless the drill is armed: a normal run never exposes a trace reader.
#[tauri::command]
pub fn handoff_drill_probe(project: String) -> Result<HandoffDrillProbe, String> {
    if project_from_env().is_none() {
        return Err(format!("{ENV} is not set; refusing to read the trace"));
    }
    let start = TRACE_START.get().copied().unwrap_or(0) as usize;
    let log = read_trace();
    let written = log.get(start..).unwrap_or("");
    Ok(probe_from_trace(&project, written))
}

/// The frontend's last call. Leaves the run loop time to drain, then exits with the verdict.
#[tauri::command]
pub fn handoff_drill_finish(passed: bool, summary: String) -> Result<(), String> {
    if project_from_env().is_none() {
        return Err(format!("{ENV} is not set"));
    }
    let code = verdict(passed);
    // The frontend already traced "handoff-drill PASS/FAIL: <summary>"; this side adds only
    // the exit code, so the verdict reads once.
    let _ = summary;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        crate::app_trace(&format!("handoff-drill verdict exit={code}"));
        std::process::exit(code);
    });
    Ok(())
}

pub fn verdict(passed: bool) -> i32 {
    if passed {
        0
    } else {
        3
    }
}

fn trace_path() -> std::path::PathBuf {
    crate::desktop_bus_dir().join("app-trace.log")
}

fn trace_len() -> u64 {
    std::fs::metadata(trace_path())
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn read_trace() -> String {
    std::fs::read_to_string(trace_path()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reads_only_this_projects_lines() {
        let written = "\
1788 handoff[other]: chain started (reason unattended)\n\
1788 chat handoff gauge crebral-health: frac=0.92 past the threshold but no live agent in the pane (status=unknown) — banner withheld, no chain\n\
1789 handoff[crebral-health]: refused (reason unattended) — no live agent in orchestrator pane w9:p1 (herdr reports none)\n";
        assert_eq!(
            probe_from_trace("crebral-health", written),
            HandoffDrillProbe { chain_started: false, withheld: true, refused: true }
        );
        assert_eq!(
            probe_from_trace("other", written),
            HandoffDrillProbe { chain_started: true, withheld: false, refused: false }
        );
        assert_eq!(
            probe_from_trace("nobody", ""),
            HandoffDrillProbe { chain_started: false, withheld: false, refused: false }
        );
    }

    #[test]
    fn a_gauge_line_without_withheld_is_not_a_withhold() {
        let written = "1788 chat handoff gauge p: frac=0.92 offered\n";
        assert!(!probe_from_trace("p", written).withheld);
    }

    #[test]
    fn verdict_is_zero_only_on_pass() {
        assert_eq!(verdict(true), 0);
        assert_eq!(verdict(false), 3);
    }
}
