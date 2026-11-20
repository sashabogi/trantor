use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use std::process::Command;

const SSH_CONNECT_TIMEOUT: &str = "5";

fn configured_ssh_target(config: &Value, machine: &str) -> Result<Option<String>, String> {
    let target = config
        .get("machines")
        .and_then(Value::as_object)
        .and_then(|machines| machines.get(machine))
        .and_then(Value::as_object)
        .and_then(|entry| entry.get("ssh"))
        .and_then(Value::as_str)
        .map(str::trim);
    match target {
        None | Some("") => Ok(None),
        Some(value) if value.starts_with('-') || value.chars().any(char::is_whitespace) => {
            Err(format!("invalid SSH target for machine {machine}"))
        }
        Some(value) => Ok(Some(value.to_string())),
    }
}

pub(crate) fn ssh_target(machine: &str) -> Result<Option<String>, String> {
    let path = crate::desktop_bus_dir().join("config.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read machine SSH config: {error}")),
    };
    let config = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("could not parse machine SSH config: {error}"))?;
    configured_ssh_target(&config, machine)
}

fn valid_remote_surface(surface: &str) -> bool {
    !surface.is_empty()
        && surface
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b":._-".contains(&byte))
}

fn surface_from_rows(raw: &str, project: &str, agent: &str) -> Result<Option<String>, String> {
    let seat = crate::local_sessions::parse_herdr_seats(raw)
        .into_iter()
        .find(|seat| seat.project == project && seat.agent == agent);
    let Some(seat) = seat else {
        return Ok(None);
    };
    if !valid_remote_surface(&seat.surface) {
        return Err("invalid remote pane id".into());
    }
    Ok(Some(seat.surface))
}

pub(crate) fn resolve_remote_surface(
    machine: &str,
    project: &str,
    agent: &str,
) -> Result<Option<(String, String)>, String> {
    let Some(target) = ssh_target(machine)? else {
        return Ok(None);
    };
    let output = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            &target,
            "cat",
            "~/.agent-bus/crew-windows.txt",
        ])
        .output()
        .map_err(|error| format!("SSH to {machine} failed: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("SSH to {machine} failed (exit {})", output.status)
        } else {
            format!("SSH to {machine} failed: {detail}")
        });
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    surface_from_rows(&raw, project, agent)
        .map(|surface| surface.map(|surface| (surface, target)))
        .map_err(|error| format!("{error} on {machine}"))
}

#[tauri::command]
pub(crate) fn remote_herdr_surface(
    machine: String,
    project: String,
    agent: String,
) -> Result<Option<String>, String> {
    if machine.trim().is_empty() || project.trim().is_empty() || agent.trim().is_empty() {
        return Err("machine, project, and agent are required".into());
    }
    let machine = machine.trim();
    if ssh_target(machine)?.is_none() {
        return Err(format!("no SSH target configured for machine {machine}"));
    }
    resolve_remote_surface(machine, project.trim(), agent.trim())
        .map(|resolved| resolved.map(|(surface, _)| surface))
}

pub(crate) fn ssh_attach_args(ssh_target: &str, surface: &str) -> Result<Vec<String>, String> {
    if ssh_target.trim().is_empty() || ssh_target.starts_with('-') || !valid_remote_surface(surface) {
        return Err("invalid remote terminal target".into());
    }
    Ok(vec![
        "-tt".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT}"),
        ssh_target.into(),
        "herdr".into(),
        "agent".into(),
        "attach".into(),
        surface.into(),
    ])
}

pub(crate) fn terminal_key(machine: Option<&str>, surface: &str) -> String {
    match machine {
        Some(machine) => format!("remote:{machine}:{surface}"),
        None => surface.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_machine_specific_ssh_target() {
        let config = json!({"machines": {"netcup": {"ssh": "crew@netcup"}}});
        assert_eq!(configured_ssh_target(&config, "netcup").unwrap(), Some("crew@netcup".into()));
        assert_eq!(configured_ssh_target(&config, "other").unwrap(), None);
    }

    #[test]
    fn rejects_ssh_option_injection_and_whitespace() {
        for target in ["-oProxyCommand=bad", "user@host command"] {
            let config = json!({"machines": {"netcup": {"ssh": target}}});
            assert!(configured_ssh_target(&config, "netcup").is_err());
        }
    }

    #[test]
    fn remote_attach_uses_batch_mode_and_a_forced_pty() {
        assert_eq!(
            ssh_attach_args("crew@netcup", "w3:p2").unwrap(),
            ["-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "crew@netcup", "herdr", "agent", "attach", "w3:p2"]
        );
        assert!(ssh_attach_args("crew@netcup", "w3:p2;rm").is_err());
    }

    #[test]
    fn attach_registry_keys_are_scoped_by_machine() {
        assert_eq!(terminal_key(None, "w3:p2"), "w3:p2");
        assert_eq!(terminal_key(Some("netcup"), "w3:p2"), "remote:netcup:w3:p2");
        assert_ne!(terminal_key(Some("netcup"), "w3:p2"), terminal_key(Some("other"), "w3:p2"));
    }

    #[test]
    fn resolves_the_last_matching_remote_crew_record() {
        let rows = "trantor\therdr\tcodex-7\tw3:p1\ntrantor\therdr\tcodex-7\tw3:p2\nother\therdr\tcodex-7\tw4:p3\n";
        assert_eq!(surface_from_rows(rows, "trantor", "codex-7").unwrap(), Some("w3:p2".into()));
        assert_eq!(surface_from_rows(rows, "trantor", "missing").unwrap(), None);
        assert!(surface_from_rows("trantor\therdr\tcodex-7\tbad;pane\n", "trantor", "codex-7").is_err());
    }
}
