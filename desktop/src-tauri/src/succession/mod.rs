#[allow(unused_imports)]
use super::*;

pub(crate) const HANDOFF_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// The CLI args for a write-only handoff, plus the reason when one is known. The reason rides as
/// `--reason <value>` so it can be persisted into the handoff record's trigger; a CLI that has not
/// yet learned the flag ignores it (baton.mjs only inspects `--write-only`), so the call stays
/// forward-compatible.
pub(crate) fn trantor_handoff_args(reason: Option<&str>) -> Vec<&str> {
    let mut args = vec!["handoff", "--write-only"];
    if let Some(r) = reason {
        args.push("--reason");
        args.push(r);
    }
    args
}

/// The successor opens in the CLICKED project's workspace: a bare `trantor open` lets the CLI read
/// the badge of whoever launched the app instead of the click (#7414).
pub(crate) fn trantor_reopen_args(project: &str) -> [&str; 2] {
    ["open", project]
}

/// The reopen step's command, built in one place so the drill inspects what the chain spawns.
pub(crate) fn reopen_command(project: &str, dir: &Path) -> tokio::process::Command {
    let mut reopen = trantor_cli::async_command();
    reopen.args(trantor_reopen_args(project)).current_dir(dir);
    reopen
}

pub(crate) fn trantor_takeover_args(project: &str) -> [&str; 3] {
    ["takeover", project, "--json"]
}

pub(crate) fn write_only_flag_rejected(stderr: &str) -> bool {
    stderr.contains("--write-only")
}

/// The shells a pane idles in once its agent is gone. Their pid is never the process to end.
pub(crate) const SHELL_NAMES: &[&str] = &[
    "zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login",
];

pub(crate) fn is_shell_process(p: &serde_json::Value) -> bool {
    let raw = p
        .get("name")
        .and_then(|s| s.as_str())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| p.get("argv0").and_then(|s| s.as_str()))
        .unwrap_or("")
        .trim();
    // login shells spell themselves "-zsh"; a path spells itself /bin/zsh
    let name = raw.trim_start_matches('-').rsplit('/').next().unwrap_or("");
    SHELL_NAMES.contains(&name)
}

pub(crate) fn pid_field(v: &serde_json::Value, key: &str) -> Option<u32> {
    v.get(key)
        .and_then(|p| p.as_u64())
        .and_then(|p| u32::try_from(p).ok())
        .filter(|p| *p > 0)
}

/// The pid the graceful end targets, from herdr's `pane process-info` reply (parity with
/// bin/baton-pane.mjs foregroundPid). The shell is never a candidate (#6668): with only the shell
/// in the foreground there is nothing to end, and the answer is None.
pub(crate) fn foreground_pid_from_process_info(raw: &str) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let info = v.get("result")?.get("process_info")?;
    let procs = info
        .get("foreground_processes")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let shell_pid = pid_field(info, "shell_pid");
    let by_pid = |pid: u32| procs.iter().find(|p| pid_field(p, "pid") == Some(pid));
    let usable = |pid: u32| Some(pid) != shell_pid && !by_pid(pid).is_some_and(is_shell_process);
    if let Some(pid) = pid_field(info, "foreground_process_group_id").filter(|p| usable(*p)) {
        return Some(pid);
    }
    for p in &procs {
        let hay = [
            p.get("name").and_then(|s| s.as_str()).unwrap_or(""),
            p.get("argv0").and_then(|s| s.as_str()).unwrap_or(""),
            p.get("cmdline").and_then(|s| s.as_str()).unwrap_or(""),
        ]
        .join(" ")
        .to_lowercase();
        if hay.contains("claude") && !is_shell_process(p) {
            if let Some(pid) = pid_field(p, "pid").filter(|p| Some(*p) != shell_pid) {
                return Some(pid);
            }
        }
    }
    procs
        .iter()
        .rev()
        .filter_map(|p| pid_field(p, "pid"))
        .find(|p| usable(*p))
}

/// Why `handoff_now` will not start a chain on this pane, or None when it may (#6668). No agent in
/// the pane means nothing to hand off: a chain there would summarize a dead transcript and end the shell.
pub(crate) fn handoff_refusal(pane: &str, agent_status: Option<&str>) -> Option<String> {
    match agent_status.map(str::trim) {
        Some(s) if !s.is_empty() && s != "none" => None,
        _ => Some(format!(
            "no live agent in orchestrator pane {pane} (herdr reports none) — nothing to hand off; open a session from the Workspace lens first"
        )),
    }
}

pub(crate) async fn run_command_output(
    mut cmd: tokio::process::Command,
    label: &str,
) -> Result<(String, String), String> {
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("{label} could not start: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok((stdout, stderr))
    } else {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(if detail.is_empty() {
            format!("{label} failed")
        } else {
            format!("{label} failed: {detail}")
        })
    }
}

pub(crate) fn trace_summary(raw: &str) -> String {
    let one_line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.is_empty() {
        return "<empty>".to_string();
    }
    let mut chars = one_line.chars();
    let head = chars.by_ref().take(239).collect::<String>();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

pub(crate) fn signal_process(pid: u32, signal: &str) -> Result<(), String> {
    let status = std::process::Command::new("/bin/kill")
        .arg(format!("-{signal}"))
        .arg(pid.to_string())
        .status()
        .map_err(|e| format!("kill {signal} {pid}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kill {signal} {pid} failed"))
    }
}

pub(crate) fn process_alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub(crate) async fn end_process_gracefully(pid: u32) -> Result<(), String> {
    signal_process(pid, "TERM")?;
    let deadline = Instant::now() + HANDOFF_EXIT_TIMEOUT;
    while Instant::now() < deadline {
        if !process_alive(pid) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    signal_process(pid, "KILL")?;
    Ok(())
}

/// Why a handoff was fired. A fixed list on purpose: the reason lands in the handoff record's
/// `trigger` field (via `trantor handoff --reason`), and the SUCCESSION wave's recap and
/// messaging branch on it, so a free-form string would drift into places that parse it.
pub(crate) const HANDOFF_REASONS: &[&str] = &["clicked", "countdown", "unattended"];

/// The one boot prompt the successor gets after the pane reopens (card #5649, failure 2: the
/// successor sat idle ~15min until the human typed). A session never runs a turn unprompted, so
/// the recap waited for a human — this is the prompt that makes it recapitulate on its own.
pub(crate) const KICKOFF_PROMPT: &str =
    "You have just taken over via handoff. Recap now per your instructions.";

/// The pane-level warning while a handoff chain runs (#6081): the chain marks its project from the
/// first step to the last so the Workspace tab shows the session going away before anyone types into it.
pub(crate) const HANDOFF_PROGRESS_EVENT: &str = "handoff-progress";

#[derive(Serialize, Clone)]
pub(crate) struct HandoffProgress {
    project: String,
    active: bool,
}

/// Which projects have a handoff chain in flight right now. Two projects can hand off at once;
/// the frontend busy-gates its click per project, so one project never runs two chains. Queried
/// on lens mount as well — an event alone would race a lens switch mid-chain.
#[derive(Default)]
pub(crate) struct HandoffChains(std::sync::Mutex<Vec<String>>);

/// Emits the marker active on begin and inactive on drop, so EVERY exit path — early error
/// returns included — unmarks the pane. Drop also runs on unwind, so a panic inside the chain
/// cannot strand the "handing off" label.
pub(crate) struct HandoffChainGuard {
    app: tauri::AppHandle,
    project: String,
}

impl HandoffChainGuard {
    fn begin(app: tauri::AppHandle, project: &str) -> Self {
        use tauri::{Emitter, Manager};
        {
            let chains = app.state::<HandoffChains>();
            let mut v = chains.0.lock().unwrap();
            if !v.iter().any(|p| p == project) {
                v.push(project.to_string());
            }
        }
        let _ = app.emit(
            HANDOFF_PROGRESS_EVENT,
            HandoffProgress {
                project: project.to_string(),
                active: true,
            },
        );
        Self {
            app,
            project: project.to_string(),
        }
    }
}

impl Drop for HandoffChainGuard {
    fn drop(&mut self) {
        use tauri::{Emitter, Manager};
        {
            let chains = self.app.state::<HandoffChains>();
            let mut v = chains.0.lock().unwrap();
            v.retain(|p| p != &self.project);
        }
        let _ = self.app.emit(
            HANDOFF_PROGRESS_EVENT,
            HandoffProgress {
                project: self.project.clone(),
                active: false,
            },
        );
    }
}

/// The projects whose handoff chain is in flight right now (#6081) — the mount-time truth for
/// the pane label; the event stream keeps it current afterwards.
#[tauri::command]
pub(crate) fn handoff_in_progress(chains: tauri::State<'_, HandoffChains>) -> Vec<String> {
    chains.0.lock().unwrap().clone()
}

#[tauri::command]
pub(crate) async fn handoff_now(
    app: tauri::AppHandle,
    project: String,
    reason: Option<String>,
) -> Result<String, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    let reason = reason.unwrap_or_else(|| "clicked".to_string());
    if !HANDOFF_REASONS.contains(&reason.as_str()) {
        return Err(format!(
            "unknown handoff reason '{reason}' — one of {}",
            HANDOFF_REASONS.join("|")
        ));
    }
    let dir = project_dir(&project).ok_or_else(|| format!("no local checkout for {project}"))?;

    // The entry guard (#6668): before a single step runs, the orch pane must exist AND hold a live
    // agent, or the chain would end a bare shell. The refusal is traced so the next incident reads itself.
    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let pane = match orch_pane_from_rows(&rows, &project) {
        Some(p) => p,
        None => {
            app_trace(&format!("handoff[{project}]: refused (reason {reason}) — no orchestrator pane recorded"));
            return Err(format!("no orchestrator pane recorded for {project}"));
        }
    };
    let entry_status = {
        let pane = pane.clone();
        tokio::task::spawn_blocking(move || herdr::agent_status(&pane))
            .await
            .unwrap_or(None)
    };
    if let Some(why) = handoff_refusal(&pane, entry_status.as_deref()) {
        app_trace(&format!("handoff[{project}]: refused (reason {reason}) — {why}"));
        return Err(why);
    }

    // Mark the pane for the whole chain — summarize (~50s), idle gate, kill, reopen, kickoff —
    // so the Workspace tab says the session is doomed before anyone types into it (#6081).
    let _chain = HandoffChainGuard::begin(app, &project);
    // #6528: the chain is now traceable. Tonight's fire left app-trace.log empty because this
    // command never traced a single step — an undiagnosable incident is its own bug.
    app_trace(&format!("handoff[{project}]: chain started (reason {reason})"));

    let mut handoff = trantor_cli::async_command();
    handoff
        .args(trantor_handoff_args(Some(&reason)))
        .current_dir(&dir);
    let (handoff_stdout, handoff_stderr) = run_command_output(handoff, "trantor handoff --write-only").await?;
    if write_only_flag_rejected(&handoff_stderr) {
        return Err(format!(
            "trantor handoff --write-only rejected by CLI: {handoff_stderr}"
        ));
    }

    // The CLI's boundary gate may have ARMED the baton instead of writing a record (#6528): the
    // record must describe a finished turn, so wait (bounded) for the Stop hook's record before the kill.
    let chain_start = unix_secs();
    if handoff_armed(&handoff_stdout) {
        app_trace(&format!("handoff[{project}]: armed mid-turn — chain waits for the turn boundary (deadline {}s)", HANDOFF_BOUNDARY_DEADLINE.as_secs()));
        let boundary_started = Instant::now();
        loop {
            let newest = newest_unconsumed_stamp(&desktop_bus_dir().join("handoffs"), &project);
            match boundary_wait_step(newest, chain_start, boundary_started.elapsed(), HANDOFF_BOUNDARY_DEADLINE) {
                BoundaryStep::Pass => {
                    app_trace(&format!("handoff[{project}]: boundary reached — the armed baton fired (record stamp {newest})"));
                    break;
                }
                BoundaryStep::Deadline => {
                    app_trace(&format!("handoff[{project}]: boundary deadline after {}s — firing past the gate (--force)", boundary_started.elapsed().as_secs()));
                    let mut force_cmd = trantor_cli::async_command();
                    force_cmd
                        .args(trantor_handoff_force_args(Some(&reason)))
                        .current_dir(&dir);
                    run_command_output(force_cmd, "trantor handoff --write-only --force").await?;
                    break;
                }
                BoundaryStep::Wait => tokio::time::sleep(KICKOFF_CADENCE).await,
            }
        }
    } else {
        app_trace(&format!("handoff[{project}]: record written immediately (session was idle)"));
    }

    // The idle gate before the kill (#6081): never end a predecessor mid-turn. Poll on
    // KICKOFF_CADENCE, bounded by HANDOFF_IDLE_DEADLINE; a deadline pass still ends the session
    // (the chain stays bounded) and the label names which side of the gate the kill happened on.
    let gate_started = Instant::now();
    let gate_outcome = loop {
        let status = {
            let pane = pane.clone();
            tokio::task::spawn_blocking(move || herdr::agent_status(&pane))
                .await
                .unwrap_or(None)
        };
        match idle_gate_step(status.as_deref(), gate_started.elapsed(), HANDOFF_IDLE_DEADLINE) {
            IdleGateStep::Pass(outcome) => break outcome,
            IdleGateStep::Wait => tokio::time::sleep(KICKOFF_CADENCE).await,
        }
    };
    let gate_secs = gate_started.elapsed().as_secs();
    app_trace(&format!("handoff[{project}]: idle gate {} after {gate_secs}s", match gate_outcome { IdleGateOutcome::Idle => "passed", IdleGateOutcome::Deadline => "deadline" }));

    let mut info = identity_env::async_command("herdr");
    info.args(["pane", "process-info", "--pane", &pane])
        .env("PATH", terminal_path());
    let (process_info, _) = run_command_output(info, "herdr pane process-info").await?;
    let pid = foreground_pid_from_process_info(&process_info)
        .ok_or_else(|| format!("no foreground process for orchestrator pane {pane}"))?;
    app_trace(&format!("handoff[{project}]: ending foreground pid {pid} in pane {pane}"));
    let post_kill = async {
        end_process_gracefully(pid).await?;
        app_trace(&format!("handoff[{project}]: foreground pid {pid} ended"));

        // herdr retires an ended agent asynchronously. Reopening while its registry still names
        // the predecessor makes `trantor open` reattach to nobody, so hold this seam until the
        // pane has no agent (bounded: a stale registry must not hang the handoff forever).
        let drop_started = Instant::now();
        let drop_outcome = loop {
            let present = {
                let pane = pane.clone();
                tokio::task::spawn_blocking(move || herdr::agent_status(&pane).is_some())
                    .await
                    .unwrap_or(true)
            };
            match agent_drop_step(
                present,
                drop_started.elapsed(),
                HANDOFF_AGENT_DROP_DEADLINE,
            ) {
                AgentDropStep::Wait => tokio::time::sleep(HANDOFF_AGENT_DROP_CADENCE).await,
                outcome => break outcome,
            }
        };
        app_trace(&format!(
            "handoff[{project}]: agent drop {} after {}ms",
            drop_outcome.as_str(),
            drop_started.elapsed().as_millis()
        ));

        let mut reopen = reopen_command(&project, &dir);
        app_trace(&format!("handoff[{project}]: trantor open starting"));
        let reopened = reopen
            .output()
            .await
            .map_err(|e| format!("trantor open could not start: {e}"))?;
        let reopen_stdout = String::from_utf8_lossy(&reopened.stdout).trim().to_string();
        let reopen_stderr = String::from_utf8_lossy(&reopened.stderr).trim().to_string();
        app_trace(&format!(
            "handoff[{project}]: trantor open status={} stdout={} stderr={}",
            reopened
                .status
                .code()
                .map_or_else(|| "signal".to_string(), |code| code.to_string()),
            trace_summary(&reopen_stdout),
            trace_summary(&reopen_stderr)
        ));
        if !reopened.status.success() {
            let detail = if reopen_stderr.is_empty() {
                &reopen_stdout
            } else {
                &reopen_stderr
            };
            return Err(if detail.is_empty() {
                "trantor open failed".to_string()
            } else {
                format!("trantor open failed: {detail}")
            });
        }

        // Kickoff-after-reopen (#5649, #6184, #6139): one boot prompt over the herdr SOCKET, only
        // after the successor reads idle, retrying transient outcomes on a cadence. Every herdr call
        // rides spawn_blocking; the sleeps are tokio's. The same ladder serves project_wake.
        let KickoffReport {
            outcome,
            attempts,
            elapsed_secs: elapsed,
        } = kickoff_after_reopen(&pane, KICKOFF_PROMPT.to_string(), |_, _| {}).await;
        app_trace(&format!(
            "handoff[{project}]: kickoff outcome={} attempts={attempts} elapsed={elapsed}s",
            trace_summary(&kickoff_landed_detail(&outcome))
        ));
        match outcome {
            Ok(outcome) => Ok(handoff_label(&gate_outcome, gate_secs, &outcome, attempts, elapsed)),
            Err(e) => Err(format!(
                "handoff chain done, but the kickoff prompt failed after {attempts} attempt(s), {elapsed}s (successor may sit idle): {e}"
            )),
        }
    }
    .await;
    match &post_kill {
        Ok(label) => app_trace(&format!(
            "handoff[{project}]: returned success: {}",
            trace_summary(label)
        )),
        Err(error) => app_trace(&format!(
            "handoff[{project}]: returned error: {}",
            trace_summary(error)
        )),
    }
    post_kill
}

/// The cadence and the budget for the post-reopen kickoff (#6184): poll/retry every 3s, give up
/// at 90s per phase (idle gate, then the prompt ladder).
pub(crate) const KICKOFF_CADENCE: Duration = Duration::from_secs(3);
pub(crate) const KICKOFF_DEADLINE: Duration = Duration::from_secs(90);

/// What became of a post-reopen kickoff: the last prompt outcome (or the last herdr error), the
/// tries it took, and the seconds the whole section ran, idle wait included.
pub(crate) struct KickoffReport {
    pub(crate) outcome: Result<herdr::PromptOutcome, String>,
    pub(crate) attempts: u32,
    pub(crate) elapsed_secs: u64,
}

/// The boot prompt for a session that was JUST reopened in `pane` (#6184, #6139). A prompt fired
/// straight after `trantor open` lands on nobody, so: wait for idle, send, retry the transient
/// outcomes on the kickoff cadence until it lands, is blocked, or the deadline passes.
pub(crate) async fn kickoff_after_reopen(
    pane: &str,
    prompt: String,
    progress: impl Fn(KickoffPhase, Option<String>),
) -> KickoffReport {
    let status_pane = pane.to_string();
    let prompt_pane = pane.to_string();
    kickoff_ladder(
        move || {
            let pane = status_pane.clone();
            async move {
                tokio::task::spawn_blocking(move || herdr::agent_status(&pane))
                    .await
                    .unwrap_or(None)
            }
        },
        move || {
            let pane = prompt_pane.clone();
            let text = prompt.clone();
            async move {
                tokio::task::spawn_blocking(move || herdr::prompt(&pane, &text))
                    .await
                    .unwrap_or_else(|e| Err(format!("kickoff task join error: {e}")))
            }
        },
        KICKOFF_CADENCE,
        KICKOFF_DEADLINE,
        progress,
    )
    .await
}

/// Where the ladder is, told to the caller's reporter (#6201). The wake chain's wake-progress
/// event carries these verbatim (the frontend contract); the handoff chain reports nothing and
/// passes a no-op — it has its own handoff-progress label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KickoffPhase {
    /// The ladder is polling for the session to read idle (the gate that ran 88s on tiny-timer).
    WaitingIdle,
    /// The prompt is going out — including the transient-outcome retries.
    KickoffSent,
    /// The chain reached its end; the detail names the outcome in the operator's words.
    Landed,
}

impl KickoffPhase {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            KickoffPhase::WaitingIdle => "waiting_idle",
            KickoffPhase::KickoffSent => "kickoff_sent",
            KickoffPhase::Landed => "kickoff_landed",
        }
    }
}

/// The ladder itself over a status poll and a prompt send, so it drills without a herdr socket:
/// wait for idle (bounded), then send and retry per boot_prompt_decision on `cadence`. The first
/// send always happens, so the report carries a real last outcome; `progress` feeds wake-progress (#6201).
pub(crate) async fn kickoff_ladder<S, SF, P, PF, C>(
    status: S,
    prompt: P,
    cadence: Duration,
    deadline: Duration,
    mut progress: C,
) -> KickoffReport
where
    S: Fn() -> SF,
    SF: std::future::Future<Output = Option<String>>,
    P: Fn() -> PF,
    PF: std::future::Future<Output = Result<herdr::PromptOutcome, String>>,
    C: FnMut(KickoffPhase, Option<String>),
{
    let started = Instant::now();

    progress(KickoffPhase::WaitingIdle, None);
    let idle_deadline = tokio::time::Instant::now() + deadline;
    loop {
        if status().await.as_deref() == Some("idle") {
            break;
        }
        if tokio::time::Instant::now() + cadence > idle_deadline {
            break;
        }
        tokio::time::sleep(cadence).await;
    }

    progress(KickoffPhase::KickoffSent, None);
    let prompt_deadline = tokio::time::Instant::now() + deadline;
    let mut attempts = 0u32;
    let mut stalled_retries = 0u32;
    let outcome = loop {
        attempts += 1;
        let r = prompt().await;
        if boot_prompt_decision(&r, stalled_retries) == BootPromptDecision::Stop {
            break r;
        }
        if matches!(r, Ok(herdr::PromptOutcome::Stalled)) {
            stalled_retries += 1;
        }
        // The double-kickoff guard (#6201): herdr's Stalled means "no lifecycle change observed",
        // not "the send did not happen". An agent now reading working/blocked is mid-turn on OUR
        // prompt, so no retry.
        if !prompt_retry_safe(status().await.as_deref()) {
            break r;
        }
        if tokio::time::Instant::now() + cadence > prompt_deadline {
            break r;
        }
        tokio::time::sleep(cadence).await;
    };
    progress(KickoffPhase::Landed, Some(kickoff_landed_detail(&outcome)));

    KickoffReport {
        outcome,
        attempts,
        elapsed_secs: started.elapsed().as_secs(),
    }
}

/// Whether a prompt retry may proceed given the pane's current reading (#6201). A mid-turn
/// agent — working, or blocked at a dialog — is chewing on the send we are about to repeat:
/// re-sending would fire the kickoff twice. Every other reading (idle again, done, no agent,
/// herdr unreachable) leaves the decision to boot_prompt_decision.
pub(crate) fn prompt_retry_safe(status: Option<&str>) -> bool {
    !matches!(status, Some("working") | Some("blocked"))
}

/// The one-line outcome a finished ladder reports (#6201): the human label for a prompt
/// outcome, or the herdr error verbatim. Pure so it drills without a socket.
pub(crate) fn kickoff_landed_detail(outcome: &Result<herdr::PromptOutcome, String>) -> String {
    match outcome {
        Ok(o) => kickoff_outcome_label(o).to_string(),
        Err(e) => e.clone(),
    }
}

/// The budget for the pre-kill idle gate (#6081): an operator is watching, and a typical turn ends
/// inside two minutes. A session parked in `relay_wait` reads "working" forever, so for it this
/// deadline IS the gate (#6668): the wait is not work, and the boundary record is already on disk.
pub(crate) const HANDOFF_IDLE_DEADLINE: Duration = Duration::from_secs(120);

pub(crate) const HANDOFF_AGENT_DROP_CADENCE: Duration = Duration::from_millis(200);
pub(crate) const HANDOFF_AGENT_DROP_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AgentDropStep {
    Wait,
    Dropped,
    Deadline,
}

impl AgentDropStep {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Wait => "waiting",
            Self::Dropped => "confirmed",
            Self::Deadline => "deadline",
        }
    }
}

pub(crate) fn agent_drop_step(present: bool, elapsed: Duration, deadline: Duration) -> AgentDropStep {
    if !present {
        return AgentDropStep::Dropped;
    }
    if elapsed >= deadline {
        AgentDropStep::Deadline
    } else {
        AgentDropStep::Wait
    }
}

/// What the idle gate saw before the kill (#6081). Idle = the predecessor reached a turn
/// boundary; Deadline = the budget ran out mid-turn and the chain ended it anyway.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdleGateOutcome {
    Idle,
    Deadline,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdleGateStep {
    Wait,
    Pass(IdleGateOutcome),
}

/// One polling step of the pre-kill idle gate (#6081), pure so it drills without a socket. Only an
/// in-flight turn ("working"/"busy") holds the gate; once the budget passes the chain proceeds and says so.
pub(crate) fn idle_gate_step(
    status: Option<&str>,
    elapsed: Duration,
    deadline: Duration,
) -> IdleGateStep {
    match status {
        Some("working") | Some("busy") => {
            if elapsed >= deadline {
                IdleGateStep::Pass(IdleGateOutcome::Deadline)
            } else {
                IdleGateStep::Wait
            }
        }
        _ => IdleGateStep::Pass(IdleGateOutcome::Idle),
    }
}

/// The gate segment of the handoff's returned line — which side of the boundary the kill
/// happened on, and how long the wait was (#6081 checklist: the outcome rides next to the
/// kickoff's, never buried).
pub(crate) fn idle_gate_label(outcome: &IdleGateOutcome, elapsed_secs: u64) -> String {
    match outcome {
        IdleGateOutcome::Idle => format!("idle gate passed in {elapsed_secs}s"),
        IdleGateOutcome::Deadline => {
            format!("idle gate deadline after {elapsed_secs}s — ended mid-turn")
        }
    }
}

/// #6528: how long the chain may wait for an ARMED baton to fire at the turn boundary. The
/// hook-side hard cap (TRANTOR_BATON_ARM_MAX_MS, 15 min) fires it at the session's next tool
/// boundary past that age, so the chain's bound is the cap plus slack for the turn's final
/// no-tool stretch. A bounded chain must end in a record either way.
pub(crate) const HANDOFF_BOUNDARY_DEADLINE: Duration = Duration::from_secs(17 * 60);

/// The marker bin/baton.mjs prints when the boundary gate ARMED the baton instead of writing
/// the record (#6528). Matched on stdout because at that moment the record does not exist —
/// there is nothing else to observe, and tonight's failure was exactly a chain that assumed
/// "the CLI ran" meant "the record exists".
pub(crate) fn handoff_armed(stdout: &str) -> bool {
    stdout.contains("handoff armed")
}

/// The chain's deadline leg (#6528): the same write-only command plus --force, so the CLI
/// writes past the boundary gate. Only reached when the boundary wait timed out — a bounded
/// chain must still produce a record before the kill, or the successor claims nothing.
pub(crate) fn trantor_handoff_force_args(reason: Option<&str>) -> Vec<&str> {
    let mut args = trantor_handoff_args(reason);
    args.push("--force");
    args
}

/// Newest stamp among THIS project's still-unconsumed handoff records (`<project>-<stamp>.json`
/// with `consumed: false`), or 0 when none. The boundary wait polls this: the Stop hook firing
/// the armed baton is observed as a record newer than the chain's start.
pub(crate) fn newest_unconsumed_stamp(dir: &std::path::Path, project: &str) -> u64 {
    let mut best = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let prefix = format!("{project}-");
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(&prefix) else { continue };
        let Some(stamp) = rest.strip_suffix(".json") else { continue };
        let Ok(stamp) = stamp.parse::<u64>() else { continue };
        if stamp <= best {
            continue;
        }
        let consumed_false = std::fs::read_to_string(entry.path())
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| v.get("consumed").and_then(|c| c.as_bool()))
            == Some(false);
        if consumed_false {
            best = stamp;
        }
    }
    best
}

/// One poll step of the boundary wait (#6528), pure so it drills without a disk. Pass = a NEW
/// unconsumed record exists (the Stop hook fired the armed baton); Deadline = the budget ran
/// out and the chain proceeds on the --force leg; anything else keeps waiting.
pub(crate) enum BoundaryStep {
    Wait,
    Pass,
    Deadline,
}

pub(crate) fn boundary_wait_step(
    newest: u64,
    chain_start: u64,
    elapsed: Duration,
    deadline: Duration,
) -> BoundaryStep {
    if newest > chain_start {
        return BoundaryStep::Pass;
    }
    if elapsed >= deadline {
        return BoundaryStep::Deadline;
    }
    BoundaryStep::Wait
}

pub(crate) fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// The retry decision for one boot-prompt attempt (#6184), pure. Delivered and Blocked stop,
/// NotReady/NoAgent/Err retry, Stalled gets exactly one retry (the count lives with the caller).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BootPromptDecision {
    Retry,
    Stop,
}
pub(crate) fn boot_prompt_decision(
    outcome: &Result<herdr::PromptOutcome, String>,
    stalled_retries: u32,
) -> BootPromptDecision {
    match outcome {
        Ok(o) => match o {
            herdr::PromptOutcome::Delivered | herdr::PromptOutcome::Blocked => BootPromptDecision::Stop,
            herdr::PromptOutcome::NotReady | herdr::PromptOutcome::NoAgent => BootPromptDecision::Retry,
            herdr::PromptOutcome::Stalled => {
                if stalled_retries < 1 {
                    BootPromptDecision::Retry
                } else {
                    BootPromptDecision::Stop
                }
            }
        },
        Err(_) => BootPromptDecision::Retry,
    }
}

/// A short, operator-facing label for what became of the boot prompt. Pure + unit-tested so the
/// kickoff path has a drill without needing a live herdr socket.
pub(crate) fn kickoff_outcome_label(outcome: &herdr::PromptOutcome) -> &'static str {
    match outcome {
        herdr::PromptOutcome::Delivered => "prompt delivered — successor is recapping",
        herdr::PromptOutcome::Blocked => "agent blocked at a dialog — answer it in the pane",
        herdr::PromptOutcome::NotReady => "agent still starting — recap will wait",
        herdr::PromptOutcome::Stalled => "no lifecycle change observed — recap may not land",
        herdr::PromptOutcome::NoAgent => "no agent in the pane — reopen the session",
    }
}

/// The full kickoff line: what became of the prompt, plus the tries it took and how long the
/// whole kickoff section ran — idle gate included (#6184). Pure so it drills without a socket.
pub(crate) fn kickoff_label(outcome: &herdr::PromptOutcome, attempts: u32, elapsed_secs: u64) -> String {
    format!(
        "handoff written · session ended · pane reopened · kickoff: {} · {attempts} attempt(s), {elapsed_secs}s",
        kickoff_outcome_label(outcome)
    )
}

/// #6081: the line handoff_now returns — the pre-kill idle gate's outcome riding NEXT TO the
/// kickoff line (#6184), so one read says how the kill happened and how the boot prompt landed.
pub(crate) fn handoff_label(
    gate: &IdleGateOutcome,
    gate_secs: u64,
    outcome: &herdr::PromptOutcome,
    attempts: u32,
    elapsed_secs: u64,
) -> String {
    format!(
        "{} · {}",
        idle_gate_label(gate, gate_secs),
        kickoff_label(outcome, attempts, elapsed_secs)
    )
}

#[tauri::command]
pub(crate) async fn takeover_now(project: String) -> Result<String, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    let dir = project_dir(&project).ok_or_else(|| format!("no local checkout for {project}"))?;
    let out = trantor_cli::async_command()
        .args(trantor_takeover_args(&project))
        .current_dir(&dir)
        .output()
        .await
        .map_err(|e| format!("trantor takeover could not start: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(stdout)
    } else if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err("trantor takeover failed".into())
    }
}

#[cfg(test)]
mod herdr_tests;
#[cfg(test)]
mod succession_tests;
