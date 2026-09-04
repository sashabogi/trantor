use serde_json::Value;
use std::path::Path;
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

fn checked_slug(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("{field} must be a provider/project slug"));
    }
    Ok(value.to_string())
}

fn command(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<Output, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).env("PATH", crate::terminal_path());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.output()
        .map_err(|e| format!("could not run {program}: {e}"))
}

fn successful(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let out = command(program, args, cwd)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if detail.is_empty() {
            format!("{program} exited {}", out.status)
        } else {
            detail
        })
    }
}

fn parsed(raw: &str) -> Result<Value, String> {
    let offset = raw
        .find(['{', '['])
        .ok_or_else(|| "herdr returned no JSON".to_string())?;
    serde_json::from_str(&raw[offset..]).map_err(|e| format!("herdr returned invalid JSON: {e}"))
}

fn rows<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .as_array()
        .or_else(|| value.get(key).and_then(Value::as_array))
        .or_else(|| {
            value
                .get("result")
                .and_then(|r| r.get(key))
                .and_then(Value::as_array)
        })
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
}

fn workspace_for(raw: &str, label: &str) -> Result<Option<String>, String> {
    let value = parsed(raw)?;
    Ok(rows(&value, "workspaces")
        .iter()
        .find(|workspace| field(workspace, &["label", "name", "custom_title"]) == Some(label))
        .and_then(|workspace| field(workspace, &["workspace_id", "id"]))
        .map(str::to_string))
}

fn pane_for(raw: &str, workspace: &str, cwd: &Path) -> Result<Option<String>, String> {
    let value = parsed(raw)?;
    let panes: Vec<&Value> = rows(&value, "panes")
        .iter()
        .filter(|pane| field(pane, &["workspace_id", "workspace"]) == Some(workspace))
        .collect();
    let preferred = panes
        .iter()
        .find(|pane| field(pane, &["cwd"]) == cwd.to_str())
        .copied()
        .or_else(|| panes.first().copied());
    Ok(preferred
        .and_then(|pane| field(pane, &["pane_id", "id"]))
        .map(str::to_string))
}

fn created_ids(raw: &str) -> Result<(String, String), String> {
    let value = parsed(raw)?;
    let result = value.get("result").unwrap_or(&value);
    let workspace = result
        .get("workspace")
        .and_then(|v| field(v, &["workspace_id", "id"]))
        .ok_or_else(|| "herdr created no workspace id".to_string())?;
    let pane = result
        .get("root_pane")
        .and_then(|v| field(v, &["pane_id", "id"]))
        .ok_or_else(|| "herdr created no root pane id".to_string())?;
    Ok((workspace.to_string(), pane.to_string()))
}

fn created_pane(raw: &str) -> Result<String, String> {
    let value = parsed(raw)?;
    let result = value.get("result").unwrap_or(&value);
    result
        .get("pane")
        .and_then(|v| field(v, &["pane_id", "id"]))
        .map(str::to_string)
        .ok_or_else(|| "herdr split returned no pane id".to_string())
}

fn login_blocking(provider: String, project: String) -> Result<(), String> {
    let provider = checked_slug(&provider, "provider")?;
    let project = checked_slug(&project, "project")?;
    let dir =
        crate::project_dir(&project).ok_or_else(|| format!("no local checkout for {project}"))?;
    let label = format!("trantor:{project}");
    let listed = successful("herdr", &["workspace", "list"], None)?;

    let pane = if let Some(workspace) = workspace_for(&listed, &label)? {
        let pane_list = successful("herdr", &["pane", "list"], None)?;
        let host = pane_for(&pane_list, &workspace, &dir)?
            .ok_or_else(|| format!("workspace {label} has no pane to split"))?;
        let split = successful(
            "herdr",
            &[
                "pane",
                "split",
                &host,
                "--direction",
                "right",
                "--cwd",
                dir.to_string_lossy().as_ref(),
                "--focus",
            ],
            None,
        )?;
        created_pane(&split)?
    } else {
        let created = successful(
            "herdr",
            &[
                "workspace",
                "create",
                "--cwd",
                dir.to_string_lossy().as_ref(),
                "--label",
                &label,
            ],
            None,
        )?;
        created_ids(&created)?.1
    };

    successful(
        "herdr",
        &["pane", "rename", &pane, &format!("Log in · {provider}")],
        None,
    )?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let marker = format!("__TRANTOR_PROVIDER_LOGIN_{nonce}__");
    let login =
        format!("trantor provider login {provider}; rc=$?; printf '\\n{marker}:%s\\n' \"$rc\"");
    successful("herdr", &["pane", "run", &pane, &login], None)?;
    successful(
        "herdr",
        &[
            "pane",
            "wait-output",
            &pane,
            "--match",
            &marker,
            "--source",
            "recent-unwrapped",
            "--timeout",
            "1800000",
        ],
        None,
    )?;
    Ok(())
}

#[tauri::command]
pub async fn provider_login(provider: String, project: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || login_blocking(provider, project))
        .await
        .map_err(|e| format!("provider login task failed: {e}"))?
}

fn trantor_provider(args: &[&str]) -> Result<(), String> {
    successful("trantor", args, None).map(|_| ())
}

#[tauri::command]
pub async fn provider_verify_key(provider: String, key: String) -> Result<(), String> {
    let provider = checked_slug(&provider, "provider")?;
    if key.trim().is_empty() {
        return Err("key is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        trantor_provider(&["provider", "verify", &provider, "--key", &key])
    })
    .await
    .map_err(|e| format!("provider verify task failed: {e}"))?
}

#[tauri::command]
pub async fn provider_save_key(provider: String, key: String) -> Result<(), String> {
    let provider = checked_slug(&provider, "provider")?;
    if key.trim().is_empty() {
        return Err("key is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        trantor_provider(&["provider", "add", &provider, "--key", &key])
    })
    .await
    .map_err(|e| format!("provider save task failed: {e}"))?
}

#[tauri::command]
pub async fn provider_remove(provider: String) -> Result<(), String> {
    let provider = checked_slug(&provider, "provider")?;
    tauri::async_runtime::spawn_blocking(move || {
        trantor_provider(&["provider", "remove", &provider, "--credentials"])
    })
    .await
    .map_err(|e| format!("provider remove task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_workspace_and_pane_from_real_herdr_envelopes() {
        let workspaces =
            r#"{"result":{"workspaces":[{"workspace_id":"w2","label":"trantor:drills"}]}}"#;
        assert_eq!(
            workspace_for(workspaces, "trantor:drills")
                .unwrap()
                .as_deref(),
            Some("w2")
        );
        let panes = r#"{"result":{"panes":[{"pane_id":"w2:p1","workspace_id":"w2","cwd":"/tmp/other"},{"pane_id":"w2:p2","workspace_id":"w2","cwd":"/tmp/drills"}]}}"#;
        assert_eq!(
            pane_for(panes, "w2", Path::new("/tmp/drills"))
                .unwrap()
                .as_deref(),
            Some("w2:p2")
        );
    }

    #[test]
    fn rejects_values_that_could_become_shell_syntax() {
        assert!(checked_slug("codex", "provider").is_ok());
        assert!(checked_slug("codex; rm", "provider").is_err());
        assert!(checked_slug("../project", "project").is_err());
    }
}
