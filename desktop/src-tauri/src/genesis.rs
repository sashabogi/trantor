use serde::Deserialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    desktop_bus_dir, herdr, kickoff_after_reopen, kickoff_outcome_label, orch_pane_from_rows,
    project_dir, run_command_output, terminal_path, KickoffReport,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectNewArgs {
    name: String,
    target: String,
    source: Option<String>,
    adopt: bool,
    brief: String,
}

fn valid_project_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn project_new_cli_args(
    args: &ProjectNewArgs,
    brief_path: Option<&Path>,
) -> Result<Vec<String>, String> {
    if !valid_project_name(&args.name) {
        return Err("project name must start with a letter or number and contain only letters, numbers, ., _, or -".into());
    }
    let target = Path::new(args.target.trim());
    if target.file_name().and_then(|part| part.to_str()) != Some(args.name.as_str()) {
        return Err(format!("target directory must end in /{}", args.name));
    }
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "target directory needs a parent development root".to_string())?;
    let mut cli = vec![
        "new".into(),
        args.name.clone(),
        "--dir".into(),
        parent.to_string_lossy().to_string(),
        "--json".into(),
    ];
    if let Some(source) = args
        .source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cli.extend(["--from".into(), source.into()]);
    }
    if args.adopt {
        cli.push("--adopt".into());
    }
    if let Some(path) = brief_path {
        cli.extend(["--brief".into(), path.to_string_lossy().to_string()]);
    }
    Ok(cli)
}

/// What lives in the project's orchestrator pane, read off `herdr agent list` (#6138). Only idle
/// and working are live agents a wake can act on: idle takes the kickoff, working is busy. Every
/// other reading (done, no status row, unparsable output) is NO live agent — that is the reopen
/// path's job, exactly as before.
enum PaneAgentState {
    Idle,
    Working,
    NoAgent,
}

fn pane_agent_state(raw: &str, pane: &str) -> PaneAgentState {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("result")?.get("agents")?.as_array().cloned())
        .and_then(|agents| {
            agents
                .iter()
                .find(|agent| agent.get("pane_id").and_then(|id| id.as_str()) == Some(pane))
                .and_then(|agent| agent.get("agent_status").and_then(|s| s.as_str()).map(str::to_string))
        })
        .map(|status| match status.as_str() {
            "idle" => PaneAgentState::Idle,
            "working" => PaneAgentState::Working,
            _ => PaneAgentState::NoAgent,
        })
        .unwrap_or(PaneAgentState::NoAgent)
}

fn project_wake_reopen_args(project: &str) -> [&str; 2] {
    // An explicit project beats an inherited RELAY_PROJECT inside crew.sh. Its open path then
    // resolves `autonomy get harness --project "$PROJ"`; prompt/missing dials add no bypass flag.
    ["open", project]
}

#[tauri::command]
pub(crate) fn project_dev_root() -> String {
    std::env::var("TRANTOR_DEV_ROOT")
        .unwrap_or_else(|_| format!("{}/development", std::env::var("HOME").unwrap_or_default()))
}

#[tauri::command]
pub(crate) fn genesis_read_brief(path: String) -> Result<String, String> {
    let path = Path::new(path.trim());
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("cannot read dropped brief: {e}"))?;
    if !metadata.is_file() {
        return Err("the dropped brief is not a file".into());
    }
    if metadata.len() > 2 * 1024 * 1024 {
        return Err("the dropped brief is larger than 2 MB".into());
    }
    std::fs::read_to_string(path).map_err(|e| format!("brief must be UTF-8 text: {e}"))
}

#[tauri::command]
pub(crate) async fn project_new(args: ProjectNewArgs) -> Result<String, String> {
    let brief_path = if args.brief.is_empty() {
        None
    } else {
        let staging = desktop_bus_dir().join("tmp");
        std::fs::create_dir_all(&staging)
            .map_err(|e| format!("could not create brief staging directory: {e}"))?;
        let path = staging.join(format!(
            "genesis-{}-{}.md",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::write(&path, args.brief.as_bytes())
            .map_err(|e| format!("could not stage the project brief: {e}"))?;
        Some(path)
    };
    let cli = project_new_cli_args(&args, brief_path.as_deref());
    let result = match cli {
        Ok(cli) => {
            let mut command = tokio::process::Command::new("trantor");
            command.args(cli).env("PATH", terminal_path());
            run_command_output(command, "trantor new")
                .await
                .map(|(stdout, _)| stdout)
        }
        Err(error) => Err(error),
    };
    if let Some(path) = brief_path {
        let _ = std::fs::remove_file(path);
    }
    let stdout = result?;
    serde_json::from_str::<serde_json::Value>(&stdout)
        .map_err(|e| format!("trantor new returned invalid JSON: {e}"))?;
    Ok(stdout)
}

#[tauri::command]
pub(crate) async fn project_wake(project: String, kickoff: String) -> Result<String, String> {
    let project = project.trim().to_string();
    if !valid_project_name(&project) {
        return Err("project is required and must be a project name, not a path".into());
    }
    if kickoff.trim().is_empty() {
        return Err("kickoff prompt is required".into());
    }
    let dir = project_dir(&project).ok_or_else(|| format!("no local checkout for {project}"))?;
    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    if let Some(pane) = orch_pane_from_rows(&rows, &project) {
        let mut list = tokio::process::Command::new("herdr");
        list.args(["agent", "list"]).env("PATH", terminal_path());
        let (agents, _) = run_command_output(list, "herdr agent list").await?;
        match pane_agent_state(&agents, &pane) {
            // A LIVE idle orchestrator: deliver the kickoff straight into it — no reopen, no
            // stacking, no "already has a live orchestrator" refusal the operator cannot see
            // past (#6138). The idle wait inside kickoff_after_reopen is already satisfied.
            PaneAgentState::Idle => {
                let kickoff = cli_decided_kickoff(&project, &dir, kickoff).await;
                let KickoffReport { outcome, attempts, elapsed_secs } =
                    kickoff_after_reopen(&pane, kickoff).await;
                return match outcome {
                    Ok(outcome) => Ok(format!(
                        "kickoff sent into idle pane {pane} · kickoff: {} · {attempts} attempt(s), {elapsed_secs}s",
                        kickoff_outcome_label(&outcome)
                    )),
                    Err(error) => Err(format!(
                        "kickoff into idle pane {pane} failed after {attempts} attempt(s), {elapsed_secs}s: {error}"
                    )),
                };
            }
            // A LIVE working orchestrator: a second prompt would interrupt mid-turn. Name the
            // pane so the operator knows where to look; the row shows it until dismissed.
            PaneAgentState::Working => {
                return Err(format!("{project} is busy in pane {pane} — the orchestrator is mid-turn"));
            }
            // done / no agent row: nothing live to talk to — today's reopen path handles it.
            PaneAgentState::NoAgent => {}
        }
    }

    let mut reopen = tokio::process::Command::new("trantor");
    reopen
        .args(project_wake_reopen_args(&project))
        .current_dir(&dir)
        .env("PATH", terminal_path());
    run_command_output(reopen, "trantor open").await?;

    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let pane = orch_pane_from_rows(&rows, &project)
        .ok_or_else(|| format!("trantor open did not record an orchestrator pane for {project}"))?;
    // The CLI decides the kickoff (#6112): it alone holds the checkout's docs/PRD.md AND the
    // signed board, so a brief wakes into the crew's PRD review and a blank project wakes
    // plainly. The app's own `kickoff` is the fallback for a CLI that cannot answer. The
    // selector blocks on a signed hub read, so it runs off the async runtime's threads.
    let kickoff = cli_decided_kickoff(&project, &dir, kickoff).await;
    // #6139: the reopened session is BOOTING. A prompt fired straight after `trantor open`
    // returned was logged by herdr 90 ms after the claude process appeared, reported as
    // agent_prompted, and never reached the session (four wakes in a row, no kickoff in the
    // transcript). Ride the handoff chain's ladder: wait for idle, send, retry the transient
    // outcomes, and say how it went.
    let KickoffReport {
        outcome,
        attempts,
        elapsed_secs,
    } = kickoff_after_reopen(&pane, kickoff).await;
    match outcome {
        Ok(outcome) => Ok(wake_label(&pane, &outcome, attempts, elapsed_secs)),
        Err(error) => Err(format!(
            "project opened in pane {pane}, but the kickoff prompt failed after {attempts} attempt(s), {elapsed_secs}s: {error}"
        )),
    }
}

/// The CLI decides the kickoff (#6112): it alone holds the checkout's docs/PRD.md AND the signed
/// board. The app's own fallback answers for a CLI that cannot. The selector blocks on a signed
/// hub read, so it runs off the async runtime's threads. Shared by both wake paths (#6138): the
/// reopen path and the idle-pane path.
async fn cli_decided_kickoff(project: &str, dir: &Path, fallback: String) -> String {
    let (project, dir, for_selection) = (project.to_string(), dir.to_path_buf(), fallback.clone());
    tokio::task::spawn_blocking(move || {
        crate::terminal::wake_kickoff_prompt(&project, &dir, &for_selection)
    })
    .await
    .unwrap_or_else(|_| fallback)
}

/// The line project_wake returns: where the session lives and what became of its boot prompt,
/// with the tries and the seconds it took (#6139) — the same shape the handoff chain reports.
fn wake_label(
    pane: &str,
    outcome: &herdr::PromptOutcome,
    attempts: u32,
    elapsed_secs: u64,
) -> String {
    format!(
        "project awake in pane {pane} · kickoff: {} · {attempts} attempt(s), {elapsed_secs}s",
        kickoff_outcome_label(outcome)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> ProjectNewArgs {
        ProjectNewArgs {
            name: "new-client-portal".into(),
            target: "/Users/sasha/development/new-client-portal".into(),
            source: Some("https://example.test/repo.git".into()),
            adopt: false,
            brief: "Build the portal.".into(),
        }
    }

    #[test]
    fn the_pane_agent_state_reads_idle_working_and_no_agent_off_herdr_list_output() {
        // Shape copied from a real `herdr agent list` (2026-09-03): result.agents[] with pane_id
        // and agent_status; a pane can be idle, working, done (process gone), or absent.
        let raw = r#"{"id":"cli:agent:list","result":{"agents":[
            {"agent":"claude","agent_status":"idle","pane_id":"wJ:p1","cwd":"/tmp/pr-os"},
            {"agent":"claude","agent_status":"working","pane_id":"w2:p3H","cwd":"/tmp/busy"},
            {"agent":"claude","agent_status":"done","pane_id":"w9:p1","cwd":"/tmp/finished"}
        ],"type":"agent_list"}}"#;
        assert!(matches!(pane_agent_state(raw, "wJ:p1"), PaneAgentState::Idle));
        assert!(matches!(pane_agent_state(raw, "w2:p3H"), PaneAgentState::Working));
        // done is NOT a live agent: the reopen path owns it, a prompt would hit nobody.
        assert!(matches!(pane_agent_state(raw, "w9:p1"), PaneAgentState::NoAgent));
        assert!(matches!(pane_agent_state(raw, "w4:p9"), PaneAgentState::NoAgent));
        // garbage in, no agent out — the wake must fall toward the reopen path, never panic
        assert!(matches!(pane_agent_state("not json", "wJ:p1"), PaneAgentState::NoAgent));
        assert!(matches!(pane_agent_state("{\"result\":{}}", "wJ:p1"), PaneAgentState::NoAgent));
    }

    #[test]
    fn cli_root_is_derived_from_the_exact_target() {
        let cli = project_new_cli_args(&args(), Some(Path::new("/fixture/brief.md"))).unwrap();
        assert_eq!(
            cli,
            vec![
                "new",
                "new-client-portal",
                "--dir",
                "/Users/sasha/development",
                "--json",
                "--from",
                "https://example.test/repo.git",
                "--brief",
                "/fixture/brief.md",
            ]
        );
    }

    #[test]
    fn target_name_mismatch_is_rejected() {
        let mut input = args();
        input.target = "/Users/sasha/development/wrong-name".into();
        assert!(project_new_cli_args(&input, None)
            .unwrap_err()
            .contains("must end in /new-client-portal"));
    }

    #[test]
    fn prompt_project_wake_names_the_target_without_a_bypass_flag() {
        let cli = project_wake_reopen_args("pros");
        assert_eq!(cli, ["open", "pros"]);
        assert!(!cli.contains(&"--dangerously-skip-permissions"));
    }

    // #6139 — the wake's line carries the kickoff outcome, the tries and the seconds, like the
    // handoff's, so a wake that landed on the third try reads differently from one that stalled.
    #[test]
    fn wake_line_carries_kickoff_outcome_attempts_and_elapsed() {
        let line = wake_label("pane-7", &herdr::PromptOutcome::Delivered, 3, 12);
        assert!(line.starts_with("project awake in pane pane-7 · kickoff: prompt delivered"));
        assert!(line.ends_with("· 3 attempt(s), 12s"), "{line}");
    }

    #[test]
    fn live_orchestrator_detection_is_pane_exact() {
        let rows = r#"{"result":{"agents":[{"pane_id":"pane-live","agent_status":"idle"}]}}"#;
        // #6138: the live reading is the state, not just presence — idle and working are live
        // agents a wake acts on; done or absent is nobody.
        assert!(matches!(pane_agent_state(rows, "pane-live"), PaneAgentState::Idle));
        assert!(matches!(pane_agent_state(rows, "pane-other"), PaneAgentState::NoAgent));
    }

    /// #6138 real path, run by hand against a REAL idle orchestrator pane:
    ///   1. `trantor new` a throwaway + `trantor open <name>` (a claude session boots in a pane)
    ///   2. wait for `herdr agent list` to read idle on that pane
    ///   3. `cargo test --manifest-path <Cargo.toml> wake_delivers -- --ignored --test-threads=1`
    /// The command under test is the exact handler the sidebar's Wake button invokes.
    /// #[tokio::test] needs the macros+rt features, which only the dev profile's tests pull in
    /// via the dev-dependency below — the runtime itself only needs rt-multi-thread/time/process.
    #[cfg(test)]
    #[tokio::test]
    #[ignore = "real path: needs an idle orchestrator pane (see the steps in this comment)"]
    async fn wake_delivers_kickoff_into_an_idle_pane() {
        let project = std::env::var("WAKE_REAL_PROJECT").expect("set WAKE_REAL_PROJECT=<throwaway project with an idle pane>");
        let result = project_wake(project, "The project is empty; say what you see and ask what to build.".into())
            .await
            .expect("wake with an idle pane must deliver the kickoff, not refuse");
        assert!(result.starts_with("kickoff sent into idle pane"), "{result}");
        assert!(result.contains("prompt delivered"), "{result}");
    }
}
