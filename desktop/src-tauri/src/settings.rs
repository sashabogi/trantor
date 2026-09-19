#[allow(unused_imports)]
use super::*;

/// The first-run wizard's state. See onboarding.rs for the migration rule (a pre-existing hub pin
/// means "already set up", never show the wizard) and what each write does.
#[tauri::command]
pub(crate) fn onboarding_get() -> Result<String, String> {
    serde_json::to_string(&onboarding::get()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn onboarding_has_hub_pin() -> bool {
    onboarding::on_disk_has_hub_pin()
}

#[tauri::command]
pub(crate) fn onboarding_set_step(step: String) -> Result<String, String> {
    serde_json::to_string(&onboarding::set_step(step)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn onboarding_close() -> Result<String, String> {
    serde_json::to_string(&onboarding::close()?).map_err(|e| e.to_string())
}

/// "Show onboarding again" in Settings.
#[tauri::command]
pub(crate) fn onboarding_reopen() -> Result<String, String> {
    serde_json::to_string(&onboarding::reopen()?).map_err(|e| e.to_string())
}

/// #6476 — durable Interrupted-session dismissals. See dismissals.rs: keyed on (project,
/// sessionId) so a dismissal never hides a NEW dead session for the same project.
#[tauri::command]
pub(crate) fn dismissed_sessions_list() -> Result<String, String> {
    serde_json::to_string(&dismissals::list()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn dismissed_sessions_dismiss(project: String, session_id: String) -> Result<String, String> {
    serde_json::to_string(&dismissals::dismiss(project, session_id)?).map_err(|e| e.to_string())
}

/// A real Wake on `project` — clears every dismissal recorded against it.
#[tauri::command]
pub(crate) fn dismissed_sessions_clear(project: String) -> Result<String, String> {
    serde_json::to_string(&dismissals::clear_project(project)?).map_err(|e| e.to_string())
}

/// #6499 — the right mode pane's tab (Files/Git/Sessions/Chat) and dock, durable per project so
/// a restart restores where the operator left it. See right_panel.rs.
#[tauri::command]
pub(crate) fn right_panel_get(project: String) -> Result<String, String> {
    serde_json::to_string(&right_panel::get(project)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn right_panel_set(project: String, tab: String, dock: String) -> Result<String, String> {
    serde_json::to_string(&right_panel::set(project, tab, dock)?).map_err(|e| e.to_string())
}

/// The autonomy dials, read and written through the CLI: the dependency rules between dials live
/// in lib/autonomy.mjs, and a Rust copy would drift on the side that decides whether we push.
#[tauri::command]
pub(crate) fn autonomy_get(project: Option<String>) -> Result<String, String> {
    let mut cmd = trantor_cli::command();
    cmd.arg("autonomy").arg("json");
    match project.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            cmd.arg("--project").arg(p);
        }
        _ => {
            cmd.arg("--global");
        }
    }
    let out = cmd
        .output()
        .map_err(|e| format!("trantor autonomy: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
pub(crate) fn autonomy_set(project: Option<String>, dial: String, value: String) -> Result<String, String> {
    // The CLI owns the json AND the validation (bin/autonomy.mjs + lib/autonomy.mjs); a parallel
    // whitelist here went stale when the `baton` dial landed. Its error is surfaced verbatim.
    let mut cmd = trantor_cli::command();
    cmd.arg("autonomy").arg("set").arg(&dial).arg(&value);
    match project.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            cmd.arg("--project").arg(p);
        }
        _ => {
            cmd.arg("--global");
        }
    }
    let out = cmd
        .output()
        .map_err(|e| format!("trantor autonomy set: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    // Hand back the resolved state, because the dependencies may have refused what was just asked.
    autonomy_get(project)
}

pub(crate) fn policy_project_arg(project: &str) -> Result<String, String> {
    let p = project.trim();
    if p.is_empty() {
        return Err("project is required".into());
    }
    if p.chars().any(|c| c.is_control()) {
        return Err("project contains a control character".into());
    }
    Ok(p.to_string())
}

pub(crate) fn policy_projects_arg(projects: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for p in projects.iter().take(4) {
        let p = policy_project_arg(p)?;
        if !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    }
    if out.len() < 2 {
        return Err("at least two projects are required".into());
    }
    Ok(out)
}

pub(crate) fn trantor_policy_args(
    cmd: &str,
    projects: &[String],
    level: Option<u8>,
    reason: Option<&str>,
) -> Result<Vec<String>, String> {
    match cmd {
        "set" => {
            let p = projects
                .first()
                .ok_or_else(|| "project is required".to_string())?;
            let level = level.ok_or_else(|| "level is required".to_string())?;
            if !(1..=4).contains(&level) {
                return Err("level must be 1-4".into());
            }
            Ok(vec![
                "policy".into(),
                "set".into(),
                policy_project_arg(p)?,
                level.to_string(),
            ])
        }
        "link" => {
            let ps = policy_projects_arg(projects)?;
            let reason = reason.unwrap_or("").trim();
            if reason.is_empty() {
                return Err("reason is required".into());
            }
            let mut args = vec!["policy".into(), "link".into()];
            args.extend(ps);
            args.push("--reason".into());
            args.push(reason.to_string());
            Ok(args)
        }
        "unlink" => {
            let ps = policy_projects_arg(projects)?;
            let mut args = vec!["policy".into(), "unlink".into()];
            args.extend(ps);
            Ok(args)
        }
        _ => Err("unknown policy command".into()),
    }
}

pub(crate) async fn trantor_cli(args: Vec<String>, label: &str) -> Result<String, String> {
    let mut cmd = trantor_cli::async_command();
    cmd.args(&args);
    let (stdout, stderr) = run_command_output(cmd, label).await?;
    if stdout.is_empty() {
        Ok(stderr)
    } else {
        Ok(stdout)
    }
}

#[tauri::command]
pub(crate) async fn duty_start() -> Result<String, String> {
    trantor_cli(vec!["duty".into(), "up".into()], "trantor duty up").await
}

#[tauri::command]
pub(crate) async fn duty_stop() -> Result<String, String> {
    trantor_cli(vec!["duty".into(), "down".into()], "trantor duty down").await
}

#[tauri::command]
pub(crate) async fn duty_log_path() -> Result<String, String> {
    Ok(desktop_bus_dir()
        .join("duty.log")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub(crate) async fn policy_set_level(project: String, level: u8) -> Result<String, String> {
    trantor_cli(
        trantor_policy_args("set", &[project], Some(level), None)?,
        "trantor policy set",
    )
    .await
}

#[tauri::command]
pub(crate) async fn policy_link_projects(projects: Vec<String>, reason: String) -> Result<String, String> {
    trantor_cli(
        trantor_policy_args("link", &projects, None, Some(&reason))?,
        "trantor policy link",
    )
    .await
}

#[tauri::command]
pub(crate) async fn policy_unlink_projects(projects: Vec<String>) -> Result<String, String> {
    trantor_cli(
        trantor_policy_args("unlink", &projects, None, None)?,
        "trantor policy unlink",
    )
    .await
}
