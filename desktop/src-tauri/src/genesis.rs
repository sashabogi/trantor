use serde::Deserialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    desktop_bus_dir, herdr, kickoff_outcome_label, orch_pane_from_rows, project_dir,
    run_command_output, terminal_path, trantor_reopen_args,
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

fn agent_list_has_pane(raw: &str, pane: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("result")?.get("agents")?.as_array().cloned())
        .is_some_and(|agents| {
            agents
                .iter()
                .any(|agent| agent.get("pane_id").and_then(|id| id.as_str()) == Some(pane))
        })
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
        if agent_list_has_pane(&agents, &pane) {
            return Err(format!(
                "{project} already has a live orchestrator in pane {pane}"
            ));
        }
    }

    let mut reopen = tokio::process::Command::new("trantor");
    reopen
        .args(trantor_reopen_args())
        .current_dir(&dir)
        .env("PATH", terminal_path());
    run_command_output(reopen, "trantor open").await?;

    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let pane = orch_pane_from_rows(&rows, &project)
        .ok_or_else(|| format!("trantor open did not record an orchestrator pane for {project}"))?;
    match herdr::prompt(&pane, &kickoff) {
        Ok(outcome) => Ok(format!(
            "project awake in pane {pane} · kickoff: {}",
            kickoff_outcome_label(&outcome)
        )),
        Err(error) => Err(format!(
            "project opened in pane {pane}, but the kickoff prompt failed: {error}"
        )),
    }
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
    fn live_orchestrator_detection_is_pane_exact() {
        let rows = r#"{"result":{"agents":[{"pane_id":"pane-live","agent_status":"idle"}]}}"#;
        assert!(agent_list_has_pane(rows, "pane-live"));
        assert!(!agent_list_has_pane(rows, "pane-other"));
    }
}
