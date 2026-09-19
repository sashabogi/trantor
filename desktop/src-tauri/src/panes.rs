#[allow(unused_imports)]
use super::*;

pub(crate) fn orch_pane_from_rows(raw: &str, project: &str) -> Option<String> {
    raw.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() >= 4 && f[0] == project && f[1] == "orch" && !f[3].trim().is_empty() {
                Some(f[3].trim().to_string())
            } else {
                None
            }
        })
        .next_back()
}

/// Is the orchestrator mid-turn? Resolved by PANE id rather than by agent label, because "claude"
/// is not unique — a crew could run one as a seat. The pane is.
#[tauri::command]
pub(crate) fn orchestrator_status(project: String) -> Result<String, String> {
    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let pane = match orch_pane_from_rows(&rows, &project) {
        Some(p) => p,
        None => return Ok("none".into()),
    };
    let out = identity_env::command("herdr")
        .args(["agent", "list"])
        .env("PATH", terminal_path())
        .output()
        .map_err(|_| "herdr is not answering".to_string())?;
    let v: serde_json::Value = serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim())
        .unwrap_or(serde_json::Value::Null);
    let agents = v
        .get("result")
        .and_then(|r| r.get("agents"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    for a in agents {
        if a.get("pane_id").and_then(|p| p.as_str()) == Some(pane.as_str()) {
            return Ok(a
                .get("agent_status")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown")
                .to_string());
        }
    }
    Ok("unknown".into())
}

/// Send raw key presses to a pane. Separate from pane_send because interrupting a turn is a KEY,
/// not text — typing the word "Escape" would just be typed.
#[tauri::command]
pub(crate) fn pane_keys(target: String, keys: String) -> Result<(), String> {
    // Closed list. This runs a subprocess, so an arbitrary string would be an injection surface,
    // and there is no reason the front end should be able to press anything it likes.
    const ALLOWED: &[&str] = &["Escape", "Enter", "C-c"];
    if !ALLOWED.contains(&keys.as_str()) {
        return Err(format!("key '{keys}' is not offered"));
    }
    if target.trim().is_empty() {
        return Err("no pane".into());
    }
    let out = identity_env::command("herdr")
        .args(["pane", "send-keys", &target, &keys])
        .env("PATH", terminal_path())
        .output()
        .map_err(|e| format!("herdr: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Answer a picker (AskUserQuestion, a permission prompt) with raw keystrokes (#6094): the picker IS
/// the blocked state `agent.prompt` refuses, so this rides `herdr::send_text`, the pane-level
/// primitive with no agent-lifecycle gating and no client lifecycle to get wrong.
#[tauri::command]
pub(crate) fn ask_answer(target: String, data: String) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("no pane".into());
    }
    herdr::send_text(&target, &data)
}

/// Deliver the operator's message to the agent in a pane through herdr's `agent.prompt`, never as
/// keystrokes: herdr honors paste mode, encodes Enter, refuses a blocked agent before any bytes land.
/// Delivery truth is unchanged: the transcript receipt decides what the operator is told.
#[tauri::command]
pub(crate) fn pane_send(target: String, text: String) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("no pane".into());
    }
    match herdr::prompt(&target, &text)? {
        herdr::PromptOutcome::Delivered => Ok(()),
        herdr::PromptOutcome::Blocked => Err(
            "The agent is waiting on an approval or question in its terminal — answer it there \
             (Terminal tray), then send again. Nothing was typed."
                .into(),
        ),
        herdr::PromptOutcome::NotReady => {
            Err("The agent is still starting up — try again in a moment. Nothing was typed.".into())
        }
        herdr::PromptOutcome::Stalled => Err(
            "The send didn't register with the agent — no lifecycle change was observed. \
             Try again."
                .into(),
        ),
        herdr::PromptOutcome::NoAgent => {
            Err("No agent is running in this pane — reopen the session first.".into())
        }
    }
}

/// Is this seat writing to its worktree right now? One owner for this answer: herdr, which
/// crew-runner tells at every turn boundary. It decides whether a human edit is allowed, so no guess.
#[tauri::command]
pub(crate) fn seat_state(agent: String) -> Result<String, String> {
    if agent.trim().is_empty() {
        return Ok("unknown".into());
    }
    let out = identity_env::command("herdr")
        .args(["agent", "list"])
        .env("PATH", terminal_path())
        .output()
        .map_err(|_| "herdr is not answering".to_string())?;
    let raw = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(_) => return Ok("unknown".into()),
    };
    let agents = v
        .get("result")
        .and_then(|r| r.get("agents"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    for a in agents {
        if a.get("agent").and_then(|x| x.as_str()) == Some(agent.as_str()) {
            return Ok(a
                .get("agent_status")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
                .to_string());
        }
    }
    Ok("unknown".into())
}
