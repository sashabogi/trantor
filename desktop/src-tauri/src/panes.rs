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
/// the pane's own. Only rows at/after `since_ms` count — an old identical message is not proof.
/// The transcript read is blocking IO, so it rides spawn_blocking, never the main thread.
#[tauri::command]
pub(crate) async fn pane_receipt_texts(
    project: String,
    target: String,
    since_ms: i64,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        reported_session_receipts(&project, herdr::reported_session(&target), since_ms)
    })
    .await
    .map_err(|e| format!("receipt read task: {e}"))?
}

/// Split from the command for tests. None — no agent, no report, herdr down — is an empty
/// channel, never an error: the caller falls back to the panel's transcript, not a red row.
pub(crate) fn reported_session_receipts(
    project: &str,
    reported: Option<String>,
    since_ms: i64,
) -> Result<Vec<String>, String> {
    let Some(sid) = reported else {
        return Ok(Vec::new());
    };
    let path = sessions::claude_transcript_path(project, &sid)?;
    Ok(receipt_texts_from_raw_since(&read_tail(&path), since_ms))
}

/// At most this much of the transcript's TAIL is read: a pending's echo is seconds old, and a
/// full decode of a giant transcript on every check would stall the app.
const RECEIPT_TAIL_BYTES: u64 = 2 * 1024 * 1024;

pub(crate) fn read_tail(path: &Path) -> String {
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(RECEIPT_TAIL_BYTES);
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&buf);
    // A mid-file read starts mid-row: the first partial line is dropped, never half-parsed.
    let cut = if start > 0 { tail_cut(&text) } else { text.as_ref() };
    cut.to_string()
}

/// Everything after the first newline — the tail read's mid-row stub is dropped here.
pub(crate) fn tail_cut(s: &str) -> &str {
    match s.find('\n') {
        Some(i) => &s[i + 1..],
        None => "",
    }
}

/// Milliseconds since the epoch of an ISO-8601 UTC row timestamp ("<date>T<time>.<frac>Z").
/// None when the shape is off — a row with no readable timestamp is kept, never fenced out.
pub(crate) fn iso_utc_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |from: usize, to: usize| s.get(from..to)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || b[13] != b':' || b[16] != b':' {
        return None;
    }
    // days-from-civil (Hinnant's algorithm): days since 1970-01-01.
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut ms = ((days * 24 + h) * 60 + mi) * 60_000 + sec * 1000;
    if let Some(frac) = s.get(19..).and_then(|r| r.strip_prefix('.')) {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            ms += format!("{digits:0<3}").get(..3)?.parse::<i64>().ok()?;
        }
    }
    Some(ms)
}

fn row_timestamp_ms(v: &serde_json::Value) -> Option<i64> {
    v.get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(iso_utc_ms)
}

/// The receipt channel of one raw transcript, fenced to rows at/after `since_ms` (#12913
/// bounce): containment over ALL history let an old "yes" prove a fresh "yes" delivered. The
/// arrival shapes match the watcher's decode exactly — plain user rows and queue enqueues.
pub(crate) fn receipt_texts_from_raw_since(raw: &str, since_ms: i64) -> Vec<String> {
    complete_lines(raw)
        .into_iter()
        .filter_map(|line| {
            if skippable_big_row(line) {
                return None;
            }
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            if let Some(ms) = row_timestamp_ms(&v) {
                if ms < since_ms {
                    return None;
                }
            }
            let text = match v.get("type").and_then(|t| t.as_str()) {
                Some("user") => v.get("message").and_then(|m| m.get("content")).map(text_content),
                Some("queue-operation") => v
                    .get("content")
                    .and_then(|c| c.as_str())
                    .map(str::to_string),
                _ => None,
            }?;
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        })
        .collect()
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
        let texts =
            reported_session_receipts("any-project", None, 0).expect("None is not an error");
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
        let texts = receipt_texts_from_raw_since(&raw, 0);
        assert!(texts.iter().any(|t| t.contains("screenshots are on the canvas")));
        assert!(texts.iter().any(|t| t.contains("queued while mid-turn")));
        assert!(!texts.iter().any(|t| t.contains("on it")));
    }

    /// The bounce fence: an identical message from BEFORE the send is not this send's echo —
    /// only the fresh row survives the since_ms cut.
    #[test]
    fn an_old_identical_message_is_not_the_sends_echo() {
        let raw = [
            serde_json::json!({"type":"user","timestamp":"2025-10-28T02:14:45.123Z","message":{"content":"yes"}}).to_string(),
            serde_json::json!({"type":"user","timestamp":"2025-10-29T15:26:25.000Z","message":{"content":"yes"}}).to_string(),
        ]
        .join("\n")
            + "\n";
        let since = iso_utc_ms("2025-10-29T00:00:00.000Z").expect("threshold parses");
        let texts = receipt_texts_from_raw_since(&raw, since);
        assert_eq!(texts.len(), 1, "only the at/after-send row survives: {texts:?}");
        // A row with NO readable timestamp is kept — fenced out only on positive evidence of age.
        let timeless =
            serde_json::json!({"type":"user","message":{"content":"yes"}}).to_string() + "\n";
        assert_eq!(receipt_texts_from_raw_since(&timeless, since).len(), 1);
    }

    /// The tail read drops the mid-row stub it starts on, and iso_utc_ms agrees with the epoch.
    #[test]
    fn tail_cut_drops_the_partial_first_line_and_iso_parses() {
        assert_eq!(tail_cut("partial row{\"type\":\"us\nfull row\n"), "full row\n");
        assert_eq!(tail_cut("one partial line, no newline"), "");
        assert_eq!(
            iso_utc_ms("2025-10-28T02:14:45.123Z"),
            Some(1_761_617_685_123)
        );
        assert_eq!(iso_utc_ms("2025-10-28 02:14:45"), None, "a space is not a T");
        assert_eq!(iso_utc_ms("not a date at all"), None);
    }
}
