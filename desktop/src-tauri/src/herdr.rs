//! The herdr adapter — the ONE place this app speaks to herdr's agent surface.
//!
//! Phase 1 of the reassembly (docs/TDD-one-surface-reassembly.md; ownership:
//! SYSTEM-CONTRACT §4 "prompt delivery" + "agent lifecycle"). The composer's send path
//! rides `agent.prompt`: herdr owns paste-mode handling, Enter encoding, and refuses a
//! blocked agent BEFORE any bytes land — the entire keystroke-transport bug family
//! (newline-as-Enter, /compact fusion, the esc-clear that interrupted live turns) is
//! herdr's solved problem, drill-proven in docs/RESEARCH-herdr-prompt.md.
//!
//! Requests go over herdr's local socket (newline-delimited JSON, protocol 20), not the
//! CLI: composer text is arbitrary, and a message starting with "-" breaks argv parsing
//! (verified 2026-08-30 — the CLI has no `--` separator), while the socket has no quoting
//! layer at all. One request per connection: prompt volume is a human typing, and a fresh
//! connection per send avoids holding a stream the server may drop on live-handoff
//! (socket-api.mdx: in-flight requests may be interrupted across server replacement).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

/// What became of a prompt. Mirrors herdr's own vocabulary — do not invent states here.
#[derive(Debug)]
pub enum PromptOutcome {
    /// herdr observed the prompt register with the agent (`agent_prompted`).
    Delivered,
    /// The agent sits at an approval/question UI; herdr refused before sending anything.
    Blocked,
    /// The agent is still starting up (`agent_not_ready`).
    NotReady,
    /// No lifecycle change was observed after the send (`agent_prompt_stalled`).
    Stalled,
    /// Nothing herdr recognizes as an agent lives at the target (`agent_not_found`).
    NoAgent,
}

fn socket_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/herdr/herdr.sock")
}

/// One request, one line back. herdr resolves a prompt in bounded time (its stall rule
/// fires within ~5s when no lifecycle change is observed), so a generous read timeout
/// only guards against a hung server, not a slow turn.
fn request(req: &serde_json::Value) -> Result<String, String> {
    let mut s = UnixStream::connect(socket_path())
        .map_err(|e| format!("herdr is not reachable ({e}) — is the herdr server running?"))?;
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let _ = s.set_read_timeout(Some(Duration::from_secs(30)));
    let mut line = req.to_string();
    line.push('\n');
    s.write_all(line.as_bytes())
        .map_err(|e| format!("herdr socket write failed: {e}"))?;
    let mut buf = String::new();
    BufReader::new(s)
        .read_line(&mut buf)
        .map_err(|e| format!("herdr socket read failed: {e}"))?;
    Ok(buf)
}

/// Deliver operator text to the agent occupying `target` (a pane id like "w2:p8", or a
/// live agent name). Text goes through verbatim — newlines stay newlines in the draft.
pub fn prompt(target: &str, text: &str) -> Result<PromptOutcome, String> {
    let req = serde_json::json!({
        "id": "trantor:agent.prompt",
        "method": "agent.prompt",
        "params": { "target": target, "text": text },
    });
    map_prompt_response(&request(&req)?)
}

/// The session id the agent occupying `target` reported through its official herdr
/// integration (`agent_session`, source e.g. "herdr:claude"). This is the RUNTIME identity
/// authority (SYSTEM-CONTRACT §4): the pane itself says which conversation lives in it,
/// reported by Claude Code's own SessionStart hook — so it is correct the moment a
/// successor session boots, before any map file catches up. None when no agent occupies
/// the target, no report was made (integration absent), or herdr is unreachable — callers
/// fall back to the durable map.
pub fn reported_session(target: &str) -> Option<String> {
    let req = serde_json::json!({
        "id": "trantor:agent.get",
        "method": "agent.get",
        "params": { "target": target },
    });
    let raw = request(&req).ok()?;
    session_from_agent_get(&raw)
}

/// Pure extraction, unit-tested against a captured real `agent.get` response.
fn session_from_agent_get(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let s = v.get("result")?.get("agent")?.get("agent_session")?;
    if s.get("kind").and_then(|k| k.as_str()) != Some("id") {
        return None;
    }
    let sid = s.get("value")?.as_str()?.trim();
    if sid.is_empty() { None } else { Some(sid.to_string()) }
}

/// The lifecycle state of the agent occupying `target` ("working" | "idle" | "blocked" |
/// "done" | "unknown"), None when no agent is there or herdr is unreachable.
pub fn agent_status(target: &str) -> Option<String> {
    let req = serde_json::json!({
        "id": "trantor:agent.get",
        "method": "agent.get",
        "params": { "target": target },
    });
    let raw = request(&req).ok()?;
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    v.get("result")?
        .get("agent")?
        .get("agent_status")?
        .as_str()
        .map(str::to_string)
}

/// A live `pane.agent_status_changed` subscription for ONE pane (Phase 3: the composer gate
/// stops polling). Protocol facts, captured live 2026-08-30 (see docs/CHECKLIST-reassembly.md
/// Phase 3): the ack line is `{"result":{"type":"subscription_started"}}`; frames are
/// `{"data":{"agent","agent_status","pane_id","workspace_id"},"event":"pane.agent_status_changed"}`.
/// Per-pane status subscriptions were observed LIVE-ONLY, unlike the global pane.* types,
/// which REPLAY history on subscribe — that replay is why this design subscribes per pane and
/// re-seeds via `agent_status()` instead of consuming the global stream.
pub struct StatusStream {
    reader: BufReader<UnixStream>,
}

pub fn subscribe_status(pane: &str, read_timeout: Duration) -> Result<StatusStream, String> {
    let s = UnixStream::connect(socket_path())
        .map_err(|e| format!("herdr is not reachable ({e})"))?;
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let _ = s.set_read_timeout(Some(read_timeout));
    let req = serde_json::json!({
        "id": "trantor:events.subscribe",
        "method": "events.subscribe",
        "params": { "subscriptions": [
            { "type": "pane.agent_status_changed", "pane_id": pane }
        ]},
    });
    let mut line = req.to_string();
    line.push('\n');
    (&s).write_all(line.as_bytes())
        .map_err(|e| format!("herdr socket write failed: {e}"))?;
    let mut reader = BufReader::new(s);
    let mut ack = String::new();
    reader
        .read_line(&mut ack)
        .map_err(|e| format!("herdr subscription ack read failed: {e}"))?;
    if !ack.contains("subscription_started") {
        return Err(format!("herdr refused the subscription: {}", ack.trim()));
    }
    Ok(StatusStream { reader })
}

impl StatusStream {
    /// The next pushed line. Ok(Some(line)) on a frame, Ok(None) on a quiet read-timeout tick
    /// (the caller's chance to re-check the world), Err on EOF or a real socket error (the
    /// caller reconnects — herdr documents in-flight streams as interruptible across
    /// live-handoff/server replacement).
    pub fn next_line(&mut self) -> Result<Option<String>, String> {
        let mut buf = String::new();
        match self.reader.read_line(&mut buf) {
            Ok(0) => Err("herdr closed the event stream".into()),
            Ok(_) => Ok(Some(buf)),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut => Ok(None),
            Err(e) => Err(format!("herdr event stream read failed: {e}")),
        }
    }
}

/// Pure frame decode: Some(status) when `raw` is an agent-status change for `pane`.
/// Accepts both spellings — the live per-pane frame says "pane.agent_status_changed",
/// while replayed global frames use underscore names.
pub fn status_from_frame(raw: &str, pane: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let ev = v.get("event")?.as_str()?;
    if ev != "pane.agent_status_changed" && ev != "pane_agent_status_changed" {
        return None;
    }
    let d = v.get("data")?;
    if d.get("pane_id")?.as_str()? != pane {
        return None;
    }
    d.get("agent_status")?.as_str().map(str::to_string)
}

/// Pure response mapping, unit-tested against captured real responses (P0b fixtures).
/// Unknown error codes surface verbatim rather than being guessed into an outcome.
fn map_prompt_response(raw: &str) -> Result<PromptOutcome, String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim())
        .map_err(|_| format!("herdr sent an unreadable response: {}", raw.trim()))?;
    if let Some(err) = v.get("error") {
        let code = err.get("code").and_then(|c| c.as_str()).unwrap_or("");
        return match code {
            "agent_blocked" => Ok(PromptOutcome::Blocked),
            "agent_not_ready" => Ok(PromptOutcome::NotReady),
            "agent_prompt_stalled" => Ok(PromptOutcome::Stalled),
            "agent_not_found" => Ok(PromptOutcome::NoAgent),
            _ => Err(err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or(if code.is_empty() { "herdr error" } else { code })
                .to_string()),
        };
    }
    if v.get("result").and_then(|r| r.get("type")).and_then(|t| t.as_str())
        == Some("agent_prompted")
    {
        return Ok(PromptOutcome::Delivered);
    }
    Err(format!("herdr sent an unexpected response: {}", raw.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured live 2026-08-30 (docs/RESEARCH-herdr-prompt.md): CLI and socket share the
    // same response bodies; the socket one carries our request id.
    const PROMPTED: &str = r#"{"id":"trantor:agent.prompt","result":{"agent":{"agent":"claude","agent_status":"idle","name":"drill2","pane_id":"w2:p16"},"type":"agent_prompted"}}"#;
    const BLOCKED: &str = r#"{"error":{"code":"agent_blocked","message":"agent drill2 is blocked and requires interactive input"},"id":"trantor:agent.prompt"}"#;
    const NOT_FOUND: &str = r#"{"id":"probe2","error":{"code":"agent_not_found","message":"agent target nonexistent not found"}}"#;
    const NOT_READY: &str = r#"{"error":{"code":"agent_not_ready","message":"agent drill is blocked during startup and is not ready for prompts"},"id":"cli:agent:start"}"#;
    const STALLED: &str = r#"{"error":{"code":"agent_prompt_stalled","message":"prompt produced no lifecycle change"},"id":"trantor:agent.prompt"}"#;

    #[test]
    fn maps_the_five_real_outcomes() {
        assert!(matches!(map_prompt_response(PROMPTED), Ok(PromptOutcome::Delivered)));
        assert!(matches!(map_prompt_response(BLOCKED), Ok(PromptOutcome::Blocked)));
        assert!(matches!(map_prompt_response(NOT_FOUND), Ok(PromptOutcome::NoAgent)));
        assert!(matches!(map_prompt_response(NOT_READY), Ok(PromptOutcome::NotReady)));
        assert!(matches!(map_prompt_response(STALLED), Ok(PromptOutcome::Stalled)));
    }

    // Captured live 2026-08-30: the p2drill measurement (docs/CHECKLIST-reassembly.md Phase 2)
    // — a fresh claude in a herdr pane, integration v8 installed, self-reported its session.
    const AGENT_GET_WITH_SESSION: &str = r#"{"id":"trantor:agent.get","result":{"type":"agent_info","agent":{"agent":"claude","agent_status":"idle","name":"p2drill","pane_id":"w2:p18","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"152505be-9b47-45e7-9c5c-211adda4695e"}}}}"#;
    const AGENT_GET_NO_SESSION: &str = r#"{"id":"trantor:agent.get","result":{"type":"agent_info","agent":{"agent":"claude","agent_status":"idle","name":"drill","pane_id":"w2:p16"}}}"#;

    // Captured live 2026-08-30 (scratchpad/status-events.txt): a per-pane subscription frame,
    // Claude Code's startup trust dialog recognized as blocked.
    const STATUS_FRAME: &str = r#"{"data":{"agent":"claude","agent_status":"blocked","pane_id":"w2:p1B","workspace_id":"w2"},"event":"pane.agent_status_changed"}"#;
    const ACK_FRAME: &str = r#"{"id":"trantor:events.subscribe","result":{"type":"subscription_started"}}"#;

    #[test]
    fn status_frames_decode_for_their_pane_and_nothing_else() {
        assert_eq!(status_from_frame(STATUS_FRAME, "w2:p1B").as_deref(), Some("blocked"));
        // Another pane's frame is not ours.
        assert_eq!(status_from_frame(STATUS_FRAME, "w2:p8"), None);
        // The subscription ack is not a status.
        assert_eq!(status_from_frame(ACK_FRAME, "w2:p1B"), None);
        // Replayed global frames spell the event with underscores — same decode.
        let underscored = STATUS_FRAME.replace("pane.agent_status_changed", "pane_agent_status_changed");
        assert_eq!(status_from_frame(&underscored, "w2:p1B").as_deref(), Some("blocked"));
        // Unrelated events and garbage are silently not-ours.
        assert_eq!(status_from_frame(r#"{"data":{"pane_id":"w2:p1B"},"event":"pane_closed"}"#, "w2:p1B"), None);
        assert_eq!(status_from_frame("not json", "w2:p1B"), None);
    }

    #[test]
    fn agent_status_reads_the_lifecycle_field() {
        // Reuses the captured agent.get fixture: status rides the same response.
        let v: serde_json::Value = serde_json::from_str(AGENT_GET_WITH_SESSION).unwrap();
        assert_eq!(
            v["result"]["agent"]["agent_status"].as_str(),
            Some("idle"),
            "fixture sanity: the captured record carries a status"
        );
    }

    #[test]
    fn reported_session_reads_the_integration_report_and_nothing_else() {
        assert_eq!(
            session_from_agent_get(AGENT_GET_WITH_SESSION).as_deref(),
            Some("152505be-9b47-45e7-9c5c-211adda4695e")
        );
        // No report (integration absent / pre-report) → None, never a guess.
        assert_eq!(session_from_agent_get(AGENT_GET_NO_SESSION), None);
        // No agent at the target → error response → None.
        assert_eq!(session_from_agent_get(NOT_FOUND), None);
        // A non-id reference kind (e.g. a path) is not a session id.
        let path_kind = AGENT_GET_WITH_SESSION.replace("\"kind\":\"id\"", "\"kind\":\"path\"");
        assert_eq!(session_from_agent_get(&path_kind), None);
    }

    #[test]
    fn unknown_error_codes_surface_their_message_verbatim() {
        let raw = r#"{"error":{"code":"something_new","message":"the server grew a new refusal"}}"#;
        assert_eq!(map_prompt_response(raw).unwrap_err(), "the server grew a new refusal");
    }

    #[test]
    fn garbage_and_unexpected_shapes_are_errors_not_outcomes() {
        assert!(map_prompt_response("not json at all").is_err());
        assert!(map_prompt_response(r#"{"id":"x","result":{"type":"pong"}}"#).is_err());
    }
}
