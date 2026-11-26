//! Agent CLI compatibility (#14030): one Rust-owned row per agent CLI — minimum, verified up to,
//! and per feature the verified range plus one line of why. Claude Code first; more CLIs join as
//! rows. Below the minimum is one banner; newer than verified is a quiet line; fine is nothing.

use serde::Serialize;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

pub(crate) struct FeatureSpec {
    pub(crate) name: &'static str,
    pub(crate) verified_from: &'static str,
    pub(crate) verified_to: &'static str,
    pub(crate) why: &'static str,
}

pub(crate) struct AgentCliSpec {
    /// The binary name as it is probed (`claude --version`).
    pub(crate) cli: &'static str,
    /// The human name the shell and About page print.
    pub(crate) label: &'static str,
    pub(crate) minimum: &'static str,
    pub(crate) verified_up_to: &'static str,
    /// The CLI's own updater, verified from its help text (`claude update`: check for updates and
    /// install if available; package-manager installs update through the package manager). None
    /// means the command could not be confirmed for an install method — the UI then says "update
    /// it the way you installed it" instead of guessing.
    pub(crate) update_command: Option<&'static str>,
    pub(crate) features: &'static [FeatureSpec],
}

/// The table. Versions are Rust-owned data: 2.1.215 is the last hand audit, 2.1.326 the newest
/// release the Mode menu was verified on (#14022 reads the mode line under the input box).
/// Bump rule (#14030): raising minimum or verified_up_to is part of a release — the release drill
/// records the agent CLI versions it was drilled against — never a drive-by mid-build.
pub(crate) const AGENT_CLIS: &[AgentCliSpec] = &[AgentCliSpec {
    cli: "claude",
    label: "Claude Code",
    minimum: "2.1.215",
    verified_up_to: "2.1.326",
    update_command: Some("claude update"),
    features: &[FeatureSpec {
        name: "Mode menu",
        verified_from: "2.1.326",
        verified_to: "2.1.326",
        why: "reads the mode line Claude Code prints under its input box",
    }],
}];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum State {
    NotInstalled,
    BelowMinimum,
    NewerThanVerified,
    Ok,
}

impl State {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            State::NotInstalled => "not_installed",
            State::BelowMinimum => "below_minimum",
            State::NewerThanVerified => "newer_than_verified",
            State::Ok => "ok",
        }
    }
}

/// `claude --version` prints "2.1.326 (Claude Code)": take the first word, tolerate a leading v.
/// A string without three numeric parts does not parse, so it can never pass as a version.
pub(crate) fn release_version_parts(version: &str) -> Option<Vec<u64>> {
    let core = version.trim().split_whitespace().next()?;
    let core = core.trim_start_matches('v');
    let parts: Option<Vec<u64>> = core.split('.').map(|part| part.parse::<u64>().ok()).collect();
    parts.filter(|parts| parts.len() >= 3)
}

fn feature_in_range(spec: &FeatureSpec, installed: Option<&[u64]>) -> bool {
    match (release_version_parts(spec.verified_from), release_version_parts(spec.verified_to), installed) {
        (Some(from), Some(to), Some(parts)) => parts >= from.as_slice() && parts <= to.as_slice(),
        _ => false,
    }
}

/// The CLI-level state. An unreadable version output reads as not installed: no banner can fire
/// on text the app cannot interpret, and every feature shows its honest unavailable state.
pub(crate) fn state_of(spec: &AgentCliSpec, raw_installed: Option<&str>) -> (State, Option<Vec<u64>>) {
    let Some(raw) = raw_installed else { return (State::NotInstalled, None) };
    let Some(parts) = release_version_parts(raw) else { return (State::NotInstalled, None) };
    let (Some(minimum), Some(verified)) = (release_version_parts(spec.minimum), release_version_parts(spec.verified_up_to))
    else { return (State::NotInstalled, None) };
    let state = if parts.as_slice() < minimum.as_slice() {
        State::BelowMinimum
    } else if parts.as_slice() > verified.as_slice() {
        State::NewerThanVerified
    } else {
        State::Ok
    };
    (state, Some(parts))
}

/// One sentence naming the feature that needs it. Below the minimum the reason backs the banner;
/// above the verified range it is the quiet line in About and doctor — never a warning.
fn reason(spec: &AgentCliSpec, state: State, raw_installed: Option<&str>, installed: Option<&[u64]>) -> Option<String> {
    let out_of_range: Vec<&FeatureSpec> = spec
        .features
        .iter()
        .filter(|f| !feature_in_range(f, installed))
        .collect();
    match state {
        State::BelowMinimum => Some(if out_of_range.is_empty() {
            format!("Trantor has audited {} only down to {}", spec.label, spec.minimum)
        } else {
            let needs = out_of_range
                .iter()
                .map(|f| format!("{} needs {} ({})", f.name, f.verified_from, f.why))
                .collect::<Vec<_>>()
                .join("; ");
            format!("the {needs}")
        }),
        State::NewerThanVerified => {
            let verified = out_of_range
                .iter()
                .map(|f| format!("{} was verified on {}..{}", f.name, f.verified_from, f.verified_to))
                .collect::<Vec<_>>()
                .join("; ");
            Some(match verified.is_empty() {
                true => format!("newer than the newest release Trantor has verified ({})", spec.verified_up_to),
                false => format!("newer than the newest release Trantor has verified ({}); {verified}", spec.verified_up_to),
            })
        }
        State::NotInstalled => raw_installed.map(|raw| format!("its version output could not be read: {raw}")),
        State::Ok => None,
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeatureCompat {
    pub(crate) name: &'static str,
    pub(crate) verified_from: &'static str,
    pub(crate) verified_to: &'static str,
    pub(crate) why: &'static str,
    pub(crate) in_range: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCliCompatibility {
    pub(crate) cli: &'static str,
    pub(crate) label: &'static str,
    /// The version as parsed from `--version`, or the raw output when it does not parse.
    pub(crate) installed: Option<String>,
    pub(crate) state: &'static str,
    pub(crate) minimum: &'static str,
    pub(crate) verified_up_to: &'static str,
    pub(crate) reason: Option<String>,
    pub(crate) update_command: Option<&'static str>,
    pub(crate) features: Vec<FeatureCompat>,
}

/// The pure half of the check, so every state is testable without spawning a CLI.
pub(crate) fn compatibility(spec: &AgentCliSpec, raw_installed: Option<&str>) -> AgentCliCompatibility {
    let (state, parts) = state_of(spec, raw_installed);
    let installed = match (raw_installed, &parts) {
        (Some(_), Some(parts)) => Some(parts.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(".")),
        (Some(raw), None) => Some(raw.to_string()),
        (None, _) => None,
    };
    AgentCliCompatibility {
        cli: spec.cli,
        label: spec.label,
        installed,
        state: state.as_str(),
        minimum: spec.minimum,
        verified_up_to: spec.verified_up_to,
        reason: reason(spec, state, raw_installed, parts.as_deref()),
        update_command: spec.update_command,
        features: spec
            .features
            .iter()
            .map(|f| FeatureCompat {
                name: f.name,
                verified_from: f.verified_from,
                verified_to: f.verified_to,
                why: f.why,
                in_range: feature_in_range(f, parts.as_deref()),
            })
            .collect(),
    }
}

/// `claude --version` through the same scrubbed environment and terminal PATH the app's other
/// CLI spawns use, so a Finder-launched app still finds the binary.
async fn installed_version(cli: &str) -> Option<String> {
    let out = crate::identity_env::async_command(cli)
        .arg("--version")
        .env("PATH", crate::hub::terminal_path())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Per-CLI compatibility for the shell banner, the About list and the feature gates.
#[tauri::command]
pub(crate) async fn agent_cli_compatibility() -> Vec<AgentCliCompatibility> {
    let mut out = Vec::new();
    for spec in AGENT_CLIS {
        let raw = installed_version(spec.cli).await;
        out.push(compatibility(spec, raw.as_deref()));
    }
    out
}

// ── update, on a click only (#14030 slice 2) ───────────────────────────────────────────────────

/// The updater runs minutes-long installs; a CLI that never finishes must not hang the button.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(600);
/// Updater output is captured for the failure line, not for an archive: bounded, tail-kept.
const OUTPUT_CAP: usize = 8 * 1024;

/// The update command as argv, straight from the Rust-owned table — never a shell, never a CLI
/// whose command could not be confirmed (#14030).
pub(crate) fn update_argv(spec: &AgentCliSpec) -> Result<Vec<String>, String> {
    let Some(command) = spec.update_command else {
        return Err(format!(
            "{} has no confirmed update command — update it the way you installed it",
            spec.label
        ));
    };
    let argv: Vec<String> = command.split_whitespace().map(str::to_string).collect();
    match argv.is_empty() {
        true => Err(format!("{}'s update command is not a command line", spec.label)),
        false => Ok(argv),
    }
}

/// Keep the tail: a failed updater's LAST lines are the diagnosis, so the cap drops the head (#14030).
pub(crate) fn cap_output(raw: &str) -> String {
    if raw.len() <= OUTPUT_CAP {
        return raw.to_string();
    }
    let mut from = raw.len() - OUTPUT_CAP;
    while !raw.is_char_boundary(from) {
        from += 1;
    }
    format!("…{}", raw[from..].trim_start())
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct AgentCliUpdate {
    pub(crate) ok: bool,
    /// The probed version before the updater ran.
    pub(crate) before: Option<String>,
    /// The re-probed version after the updater ran — the click's whole point.
    pub(crate) after: Option<String>,
    pub(crate) output: String,
}

/// Pure assembly so the cap and the ok rule stay testable without any real updater (#14030).
pub(crate) fn update_result(
    before: Option<String>,
    after: Option<String>,
    ok: bool,
    raw_output: &str,
) -> AgentCliUpdate {
    AgentCliUpdate { ok, before, after, output: cap_output(raw_output) }
}

/// Runs the CLI's own updater as argv with a timeout, capturing stdout+stderr capped (#14030).
async fn run_updater(spec: &AgentCliSpec) -> Result<(bool, String), String> {
    let argv = update_argv(spec)?;
    let program = &argv[0];
    let child = crate::identity_env::async_command(program)
        .args(&argv[1..])
        .env("PATH", crate::hub::terminal_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start {program}: {e}"))?;
    match tokio::time::timeout(UPDATE_TIMEOUT, child.wait_with_output()).await {
        Err(_) => Ok((false, format!("timed out after {}s and was stopped", UPDATE_TIMEOUT.as_secs()))),
        Ok(Err(e)) => Ok((false, format!("the updater did not finish: {e}"))),
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            if !stderr.trim().is_empty() {
                text.push('\n');
                text.push_str(&stderr);
            }
            Ok((out.status.success(), text))
        }
    }
}

/// The update loop with probe and runner injected: the probe runs BEFORE and again AFTER the
/// updater (the re-probe IS the after version), so tests prove the sequence without a real updater.
pub(crate) async fn agent_cli_update_seams<P, F, R, G>(
    spec: &AgentCliSpec,
    probe: P,
    runner: R,
) -> Result<AgentCliUpdate, String>
where
    P: Fn() -> F,
    F: Future<Output = Option<String>>,
    R: Fn() -> G,
    G: Future<Output = Result<(bool, String), String>>,
{
    let before = probe().await;
    let (ok, output) = match runner().await {
        Ok(v) => v,
        Err(e) => (false, e),
    };
    let after = probe().await;
    crate::changes::app_trace(&format!(
        "agent_cli_update[{}]: ok={} before={} after={}",
        spec.cli,
        ok,
        before.as_deref().unwrap_or("unreadable"),
        after.as_deref().unwrap_or("unreadable")
    ));
    Ok(update_result(before, after, ok, &output))
}

/// Update one agent CLI from the app, on the operator's click — argv only, bounded, re-probed (#14030).
#[tauri::command]
pub(crate) async fn agent_cli_update(cli: String) -> Result<AgentCliUpdate, String> {
    let Some(spec) = AGENT_CLIS.iter().find(|s| s.cli == cli) else {
        return Err(format!("no agent CLI named '{cli}'"));
    };
    let probe_cli = spec.cli.to_string();
    agent_cli_update_seams(spec, || installed_version(&probe_cli), || run_updater(spec)).await
}

// ── sessions still on the old binary (#14030 slice 2) ─────────────────────────────────────────

/// A session the app can enumerate, with everything the filter needs: a running session keeps the
/// binary it started with, so the start time against the binary's change time is the whole truth.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionCandidate {
    pub(crate) project: String,
    pub(crate) seat: String,
    /// "handoff" (orchestrator pane), "agents" (crew seat), "none" (a plain terminal window).
    pub(crate) restart: &'static str,
    /// The session's claude start in epoch ms; None = cannot be known, never guessed.
    pub(crate) started_ms: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StaleSessionRow {
    pub(crate) project: String,
    pub(crate) seat: String,
    /// "handoff" | "agents" | "none" — what the row offers for a restart.
    pub(crate) restart: &'static str,
    /// "before_update" | "may_be_old" — the honest start-time verdict.
    pub(crate) stale: &'static str,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCliStaleSessions {
    pub(crate) rows: Vec<StaleSessionRow>,
    /// Machines hosting seats that this machine-local check did not look at (footer honesty).
    pub(crate) machines_not_checked: Vec<String>,
}

/// The before-update filter (#14030): a session started before the binary last changed runs the
/// old binary and is listed; started after means fresh and stays off the list; a start that cannot
/// be known is listed as may-be-old — "no evidence, no claim" reads here as "probably, honestly".
pub(crate) fn stale_sessions(candidates: &[SessionCandidate], binary_changed_ms: Option<u64>) -> Vec<StaleSessionRow> {
    candidates
        .iter()
        .filter_map(|c| {
            let stale = match (c.started_ms, binary_changed_ms) {
                (Some(started), Some(changed)) if started >= changed => return None,
                (Some(_), Some(_)) => "before_update",
                _ => "may_be_old",
            };
            Some(StaleSessionRow {
                project: c.project.clone(),
                seat: c.seat.clone(),
                restart: c.restart,
                stale,
            })
        })
        .collect()
}

/// The resolved `claude` executable on the terminal PATH — the binary whose mtime says when the
/// installed version last changed (#14030).
fn resolved_cli_path(cli: &str) -> Option<PathBuf> {
    crate::hub::terminal_path()
        .split(':')
        .filter_map(|dir| {
            let dir = dir.trim();
            (!dir.is_empty()).then(|| Path::new(dir).join(cli))
        })
        .find(|p| p.is_file())
}

fn binary_changed_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// A process's start in epoch ms from its `ps -o etime=` age; None = cannot be known (#14030).
fn process_start_ms(pid: u32, now_ms: u64) -> Option<u64> {
    let raw = crate::local_sessions::shell_stdout("/bin/ps", &["-p", &pid.to_string(), "-o", "etime="]);
    now_ms.checked_sub(crate::local_sessions::parse_ps_elapsed_ms(&raw)?)
}

/// herdr panes (orchestrator and crew seats) whose agent is Claude, each with its claude start (#14030).
fn pane_candidates(now_ms: u64) -> Vec<SessionCandidate> {
    let rows = std::fs::read_to_string(crate::local_sessions::desktop_bus_dir().join("crew-windows.txt"))
        .unwrap_or_default();
    crate::local_sessions::parse_herdr_seats(&rows)
        .into_iter()
        .filter(|seat| seat.kind == "orch" || seat.kind == "herdr")
        .filter_map(|seat| {
            if !crate::local_sessions::herdr_pane_alive(&seat.surface) {
                return None;
            }
            if crate::herdr::agent_kind_and_status(&seat.surface).0.as_deref() != Some("claude") {
                return None;
            }
            let info = crate::local_sessions::shell_stdout("herdr", &["pane", "process-info", "--pane", &seat.surface]);
            let started = crate::succession::foreground_pid_from_process_info(&info)
                .and_then(|pid| process_start_ms(pid, now_ms));
            let restart = if seat.kind == "orch" { "handoff" } else { "agents" };
            Some(SessionCandidate { project: seat.project, seat: seat.agent, restart, started_ms: started })
        })
        .collect()
}

/// Claude processes outside herdr panes (a plain terminal window), mapped to their project by cwd;
/// a project that already has a pane row is that same session, so the pane row wins (#14030).
fn process_candidates(now_ms: u64, covered: &[String]) -> Vec<SessionCandidate> {
    let root = crate::identity::dev_root().to_string_lossy().into_owned();
    let pids = crate::local_sessions::shell_stdout("/usr/bin/pgrep", &["-x", "claude"])
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>();
    if pids.is_empty() {
        return Vec::new();
    }
    let list = pids.join(",");
    let cwds = crate::local_sessions::parse_lsof_pid_cwds(&crate::local_sessions::shell_stdout(
        "/usr/sbin/lsof",
        &["-a", "-d", "cwd", "-p", &list, "-Fn"],
    ));
    cwds.into_iter()
        .filter_map(|(pid, cwd)| {
            let project = crate::local_sessions::project_of_cwd(&cwd, &root)?;
            (!covered.contains(&project)).then(|| SessionCandidate {
                project,
                seat: "claude".into(),
                restart: "none",
                started_ms: process_start_ms(pid, now_ms),
            })
        })
        .collect()
}

/// The machines /machines/health names that are not THIS machine — seats there were not checked.
/// Bounded and best-effort: a hub that does not answer in time claims nothing (#14030).
async fn machines_not_checked(local_label: &str) -> Vec<String> {
    let hubs = crate::identity::known_projects()
        .into_iter()
        .map(|p| crate::identity::hub_for_project(&p))
        .collect::<std::collections::BTreeSet<_>>();
    let mut out: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for base in hubs {
        let fetch = async {
            let owner = crate::identity::resolve_owner(&base).await.ok()?;
            let (status, body) = crate::identity::request(&owner, &base, "GET", "/machines/health", None).await.ok()?;
            (status == 200).then_some(body)
        };
        let body = match tokio::time::timeout(Duration::from_secs(3), fetch).await {
            Ok(Some(body)) => body,
            _ => continue,
        };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(machines) = v.get("machines").and_then(|m| m.as_array()) {
                for m in machines {
                    if let Some(name) = m.get("machine").and_then(|m| m.as_str()) {
                        if name != local_label && !name.is_empty() {
                            out.insert(name.to_string());
                        }
                    }
                }
            }
        }
    }
    out.into_iter().collect()
}

/// This machine's own label in the config the runner heartbeats with (#14030).
fn local_machine_label() -> String {
    let raw = std::fs::read_to_string(crate::local_sessions::desktop_bus_dir().join("config.json"))
        .unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("machineLabel").and_then(|l| l.as_str()).map(str::to_string))
        .filter(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && l.len() <= 24)
        .unwrap_or_default()
}

/// The local sessions still running the claude binary they started with (#14030): enumerated at
/// app start and after an update, listed with one restart-through-handoff each, never restarted
/// silently. Only claude is enumerated today; a row for another CLI honestly stays empty.
#[tauri::command]
pub(crate) async fn agent_cli_stale_sessions(cli: String) -> Result<AgentCliStaleSessions, String> {
    if !AGENT_CLIS.iter().any(|s| s.cli == cli) {
        return Err(format!("no agent CLI named '{cli}'"));
    }
    let claude_only = cli == "claude";
    let enumeration = tokio::task::spawn_blocking(move || {
        if !claude_only {
            return (Vec::new(), None);
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let panes = pane_candidates(now_ms);
        let covered = panes.iter().map(|c| c.project.clone()).collect::<Vec<_>>();
        let mut candidates = panes;
        candidates.extend(process_candidates(now_ms, &covered));
        let changed = resolved_cli_path("claude").as_deref().and_then(binary_changed_ms);
        (stale_sessions(&candidates, changed), changed)
    })
    .await
    .map_err(|e| format!("session enumeration failed: {e}"))?;
    let mut report = AgentCliStaleSessions { rows: enumeration.0, machines_not_checked: Vec::new() };
    if !report.rows.is_empty() {
        report.machines_not_checked = machines_not_checked(&local_machine_label()).await;
    }
    Ok(report)
}

#[cfg(test)]
#[path = "agent_cli_tests.rs"]
mod tests;
