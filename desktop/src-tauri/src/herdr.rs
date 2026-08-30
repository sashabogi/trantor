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
