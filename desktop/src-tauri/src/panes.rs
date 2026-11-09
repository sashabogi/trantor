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
    let delivery = deliver_prompt(&target, &text);
    match delivery.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PromptDelivery {
    pub(crate) outcome: &'static str,
    pub(crate) error: Option<String>,
}

pub(crate) fn deliver_prompt(target: &str, text: &str) -> PromptDelivery {
    if target.trim().is_empty() {
        return PromptDelivery { outcome: "no_agent", error: Some("no pane".into()) };
    }
    prompt_delivery(herdr::prompt(target, text))
}

// Composer and phone acknowledgments share both herdr's outcome and the explanation (#12130).
pub(crate) fn prompt_delivery(result: Result<herdr::PromptOutcome, String>) -> PromptDelivery {
    use herdr::PromptOutcome;
    let (outcome, error) = match result {
        Ok(PromptOutcome::Delivered) => ("delivered", None),
        Ok(PromptOutcome::Blocked) => ("blocked", Some(
            "The agent is waiting on an approval or question in its terminal — answer it there \
             (Terminal tray), then send again. Nothing was typed.".into())),
        Ok(PromptOutcome::NotReady) => ("not_ready", Some(
            "The agent is still starting up — try again in a moment. Nothing was typed.".into())),
        Ok(PromptOutcome::Stalled) => ("stalled", Some(
            "The send didn't register with the agent — no lifecycle change was observed. \
             Try again.".into())),
        Ok(PromptOutcome::NoAgent) => ("no_agent", Some(
            "No agent is running in this pane — reopen the session first.".into())),
        Err(error) => ("stalled", Some(error)),
    };
    PromptDelivery { outcome, error }
}

/// The receipt channel of the session the pane's agent reported to herdr (#12913): after a
/// restart the panel can follow the SUCCESSOR transcript while a delivered send's echo sits in
/// the pane's own. The composer judges a pending against this before calling it lost or retrying.
#[tauri::command]
pub(crate) fn pane_receipt_texts(project: String, target: String) -> Result<Vec<String>, String> {
    reported_session_receipts(&project, herdr::reported_session(&target))
}

/// Split from the command for tests. None — no agent, no report, herdr down — is an empty
/// channel, never an error: the caller falls back to the panel's transcript, not a red row.
pub(crate) fn reported_session_receipts(
    project: &str,
    reported: Option<String>,
) -> Result<Vec<String>, String> {
    let Some(sid) = reported else {
        return Ok(Vec::new());
    };
    let path = sessions::claude_transcript_path(project, &sid)?;
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    Ok(receipt_texts_from_raw(&raw))
}

/// The receipt channel of one raw transcript, through the same decode the panel's watcher runs,
/// so the two judgments can never disagree about what counts as an echo.
pub(crate) fn receipt_texts_from_raw(raw: &str) -> Vec<String> {
    let lines = complete_lines(raw);
    let total = lines.len();
    decode_chat_lines(lines, total).receipt_texts
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

#[cfg(test)]
mod pane_receipt_tests {
    use super::*;

    /// No reported session is an empty channel, not an error — the composer keeps judging
    /// against the panel's transcript alone.
    #[test]
    fn no_reported_session_is_an_empty_channel_not_an_error() {
        let texts = reported_session_receipts("any-project", None).expect("None is not an error");
        assert!(texts.is_empty());
    }

    /// The judgment #12913 relies on: the channel carries the RAW arrival rows — a plain user
    /// message and a queue enqueue — and none of the assistant's own words.
    #[test]
    fn the_channel_carries_raw_user_rows_and_enqueues_only() {
        let raw = [
            serde_json::json!({"type":"user","message":{"content":"show me when the screenshots are on the canvas"}}).to_string(),
            serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"queued while mid-turn"}).to_string(),
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"on it"}]}}).to_string(),
        ]
        .join("\n");
        let texts = receipt_texts_from_raw(&raw);
        assert!(texts.iter().any(|t| t.contains("screenshots are on the canvas")));
        assert!(texts.iter().any(|t| t.contains("queued while mid-turn")));
        assert!(!texts.iter().any(|t| t.contains("on it")));
    }
}
