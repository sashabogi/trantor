use std::process::Output;

fn decode(output: Output) -> Result<String, String> {
    if !output.status.success() {
        return Err(format!(
            "Attribution unavailable: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if !value["head"].is_string() || !value["files"].is_array() || !value["agents"].is_array() {
        return Err("Attribution unavailable: invalid CLI response".into());
    }
    Ok(text)
}

#[tauri::command]
pub(crate) async fn code_attribution(
    project: String,
    seat: Option<String>,
) -> Result<String, String> {
    let root = crate::source_root(&project, seat.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("trantor")
            .args(["attribution", "--json", "--project", &project])
            .current_dir(root)
            .env("PATH", crate::terminal_path())
            .output()
            .map_err(|e| format!("Attribution unavailable: {e}"))?;
        decode(output)
    })
    .await
    .map_err(|e| format!("attribution worker: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    fn output(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn accepts_cli_attribution_and_preserves_errors() {
        let json = r#"{"head":"abc","files":[],"agents":[]}"#;
        assert_eq!(decode(output(0, json, "")).unwrap(), json);
        assert!(decode(output(1, "", "hub offline"))
            .unwrap_err()
            .contains("hub offline"));
        assert!(decode(output(0, "{}", "")).is_err());
        assert!(decode(output(0, "not JSON", "")).is_err());
    }
}
