//! Ghost-text fast path (#5897).
//!
//! The original `ghost_complete` shelled out to scrooge (a CLI that spins up a fresh model per
//! call): 16-36 s end to end, so the feature shipped OFF. This module replaces that with ONE
//! direct OpenAI-compatible HTTP call from the app process to a fast model, so a ghost can answer
//! in well under a second. Config is read at RUNTIME from ~/.agent-bus/.env — never baked in:
//!
//!   • qwen (preferred): base https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1,
//!     model qwen3.8-flash, key QWEN_API_KEY. `enable_thinking: false` keeps it fast.
//!   • deepseek (fallback when QWEN_API_KEY is absent): base https://api.deepseek.com/v1,
//!     model deepseek-v4-flash, key DEEPSEEK_API_KEY.
//!
//! The call is deliberately small: max_tokens 32 (measured default, #5897 probe: 32 ran ~200 ms
//! faster p50 than 64 and its p95 stays under the 2 s timeout that 64 occasionally tripped), a
//! stop at the first blank line, and a 2 s client timeout so a slow provider degrades to "no
//! ghost" rather than a stalled editor.
//!
//! Purity split: everything that SHAPES the request (env parse, provider pick, prompt, request
//! body, completion parse) is a plain function with a unit test; only the network round-trip lives
//! in `ghost_complete`.
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;

const QWEN_BASE: &str = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL: &str = "qwen3.8-flash";
const DEEPSEEK_BASE: &str = "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL: &str = "deepseek-v4-flash";
const MAX_TOKENS: u64 = 32;
/// A blank line ends a ghost: whatever the model would say after "\n\n" is prose, not code.
const STOP_BLANK_LINE: [&str; 1] = ["\n\n"];
const TIMEOUT: Duration = Duration::from_secs(2);

// No Debug derive: `key` is the provider's live API key, and a Debug impl is exactly what a
// stray `{:?}` in a log line would reach for — never give it something to redact.
#[derive(PartialEq)]
pub struct Provider {
    pub base: &'static str,
    pub model: &'static str,
    pub key: String,
    /// qwen's compatible mode accepts `enable_thinking: false`; deepseek-chat needs no such flag.
    pub thinking_off: bool,
}

/// Parse ~/.agent-bus/.env lines into KEY → VALUE. Handles comment lines, `export ` prefixes and
/// single/double-quoted values; mirrors what `source` does for the crew layer.
pub fn parse_env(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some((k, v)) = line.split_once('=') else { continue };
        let k = k.trim();
        if k.is_empty() {
            continue;
        }
        let mut v = v.trim().to_string();
        if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
            v = v[1..v.len() - 1].to_string();
        }
        if !v.is_empty() {
            out.insert(k.to_string(), v);
        }
    }
    out
}

/// The env value for `key` — process env first (a dev shell / seat exports it), then the file.
fn env_value(env_file: &HashMap<String, String>, key: &str) -> Option<String> {
    if let Ok(v) = std::env::var(key) {
        if !v.is_empty() {
            return Some(v);
        }
    }
    env_file.get(key).cloned()
}

/// Pick the provider for this machine. qwen wins when its key is present; deepseek is the fallback
/// (both keys live in ~/.agent-bus/.env, and the runner exports them for CLI seats).
pub fn pick_provider(env_file: &HashMap<String, String>) -> Option<Provider> {
    if let Some(key) = env_value(env_file, "QWEN_API_KEY") {
        return Some(Provider { base: QWEN_BASE, model: QWEN_MODEL, key, thinking_off: true });
    }
    env_value(env_file, "DEEPSEEK_API_KEY").map(|key| Provider {
        base: DEEPSEEK_BASE, model: DEEPSEEK_MODEL, key, thinking_off: false,
    })
}

/// The FIM-style user prompt: what is before the cursor, what is after, and the file path for
/// context. The model is told to emit ONLY the missing middle.
pub fn build_prompt(prefix: &str, suffix: &str, path: &str) -> String {
    format!(
        "You are an inline code-completion model in an editor.\n\
         Complete the code exactly where the cursor is. Do NOT repeat the prefix or the suffix.\n\
         Return ONLY the code that fills the gap — no commentary, no markdown fences.\n\n\
         FILE: {path}\n\n\
         <code before the cursor>\n{prefix}\n</code before the cursor>\n\n\
         <code after the cursor>\n{suffix}\n</code after the cursor>\n\n\
         Completion:"
    )
}

/// The OpenAI-compatible chat request body for one ghost. Kept small and deterministic.
pub fn build_request_body(provider: &Provider, prefix: &str, suffix: &str, path: &str) -> Value {
    let mut body = json!({
        "model": provider.model,
        "messages": [{ "role": "user", "content": build_prompt(prefix, suffix, path) }],
        "max_tokens": MAX_TOKENS,
        "stop": STOP_BLANK_LINE,
        "temperature": 0,
        "stream": false,
    });
    if provider.thinking_off {
        body["enable_thinking"] = Value::Bool(false);
    }
    body
}

/// Pull `choices[0].message.content` out of a chat-completions response.
pub fn parse_completion(raw: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("ghost: bad json: {e}"))?;
    let content = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| "ghost: no completion in response".to_string())?;
    Ok(content.trim().to_string())
}

fn trace(ms: u128, model: &str, chars: usize) {
    let dir = crate::desktop_bus_dir();
    let _ = std::fs::create_dir_all(&dir);
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("app-trace.log")) {
        use std::io::Write;
        let _ = writeln!(f, "{ts} ghost: ms={ms} model={model} chars={chars}");
    }
}

/// One inline-completion call. Reads provider config from the environment at runtime, makes a
/// single HTTP round-trip to the fast model, and returns the trimmed completion text (may be empty
/// when the model produced nothing useful). 2 s timeout; every call appends a `ghost:` trace line.
#[tauri::command]
pub async fn ghost_complete(prefix: String, suffix: String, path: String) -> Result<String, String> {
    let t0 = Instant::now();
    let env_file = read_env_file();
    let provider = pick_provider(&env_file)
        .ok_or_else(|| "ghost: no QWEN_API_KEY or DEEPSEEK_API_KEY in ~/.agent-bus/.env".to_string())?;
    let body = build_request_body(&provider, &prefix, &suffix, &path).to_string();

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("ghost: client: {e}"))?;
    let url = format!("{}/chat/completions", provider.base.trim_end_matches('/'));
    let res = client
        .post(&url)
        .bearer_auth(&provider.key)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| {
            trace(t0.elapsed().as_millis(), provider.model, 0);
            format!("ghost: request failed: {e}")
        })?;

    let status = res.status();
    let text = res.text().await.map_err(|e| {
        trace(t0.elapsed().as_millis(), provider.model, 0);
        format!("ghost: read body: {e}")
    })?;
    if !status.is_success() {
        trace(t0.elapsed().as_millis(), provider.model, 0);
        return Err(format!("ghost: http {status}: {}", text.chars().take(200).collect::<String>()));
    }
    let completion = parse_completion(&text).map_err(|e| {
        trace(t0.elapsed().as_millis(), provider.model, 0);
        e
    })?;
    trace(t0.elapsed().as_millis(), provider.model, completion.chars().count());
    Ok(completion)
}

/// ~/.agent-bus/.env, empty map when unreadable (the pick then falls through to process env).
fn read_env_file() -> HashMap<String, String> {
    let raw = std::fs::read_to_string(crate::desktop_bus_dir().join(".env")).unwrap_or_default();
    parse_env(&raw)
}

// ── Streaming ghost (#6160) ────────────────────────────────────────────────────────────────────
// The non-streaming path above measures ~1.4 s of network+server floor before the WHOLE body lands
// (see ghost_latency_matrix). Streaming flips the target to TIME-TO-FIRST-LINE: we read the SSE
// byte stream as it arrives, forward each delta to the webview on a request-keyed channel, and stop
// the moment the first line is complete (or ~32 tokens), aborting the HTTP stream so we never pay
// for the rest. The same 2 s budget now applies to first-line arrival, not to the whole response.

/// One streaming event, pushed to the webview on the channel keyed by request id. `Delta` fires as
/// each token chunk lands; `Done` fires when the first line is complete (or the stream is capped),
/// carrying the time-to-first-line so the editor can trace it.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GhostEvent {
    Delta { id: String, text: String },
    Done { id: String, text: String, ttl_ms: u64, reason: String },
}

/// The payload of one SSE `data:` line, or None for keep-alives, blanks and the `[DONE]` sentinel.
pub fn sse_data(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix("data:")?.trim();
    if rest.is_empty() || rest == "[DONE]" {
        return None;
    }
    Some(rest.to_string())
}

/// The delta content carried by one chat.completion.chunk payload. Chunks that only carry a role or
/// finish_reason (or that are not JSON) yield None. May be Some("") for an empty content delta.
pub fn parse_stream_delta(payload: &str) -> Option<String> {
    let v: Value = serde_json::from_str(payload).ok()?;
    let content = v
        .get("choices")?
        .as_array()?
        .first()?
        .get("delta")?
        .get("content")?
        .as_str()?;
    Some(content.to_string())
}

/// The accumulated streamed completion, and the rules for when it is "enough to show".
#[derive(Default)]
pub struct GhostAcc {
    pub content: String,
}

impl GhostAcc {
    pub fn push(&mut self, delta: &str) {
        self.content.push_str(delta);
    }
    /// The first line is complete the moment a newline lands — that is the moment the ghost paints.
    pub fn first_line_done(&self) -> bool {
        self.content.contains('\n')
    }
    /// The ghost text: everything up to the first newline (or the whole stream when the model ended
    /// without one), trailing whitespace trimmed so Monaco does not paint trailing spaces.
    pub fn ghost(&self) -> String {
        match self.content.split_once('\n') {
            Some((first, _)) => first.trim_end().to_string(),
            None => self.content.trim_end().to_string(),
        }
    }
    /// A whitespace-word stand-in for tokens, used to honour the ~32-token cap when the model never
    /// sends a newline. Deliberately coarse: the provider also enforces `max_tokens`, this is only a
    /// belt-and-braces so a run-on line cannot stream forever.
    pub fn token_estimate(&self) -> usize {
        self.content.split_whitespace().count()
    }
}

/// The streaming FIM prompt, ordered for the provider's cached-input tier: the STABLE bytes go
/// first (instructions, the FILE header, then the context block above the cursor minus its last
/// few lines), and the only part that changes per keystroke — the last few lines right before the
/// cursor — rides LAST inside the before-cursor block. Keystroke N and N+1 therefore share an
/// identical leading prefix, so prefill can hit the cache.
pub fn build_stream_prompt(head: &str, near: &str, suffix: &str, path: &str) -> String {
    format!(
        "You are an inline code-completion model in an editor.\n\
         Complete the code exactly where the cursor is. Do NOT repeat what is before or after it.\n\
         Return ONLY the code that fills the gap — no commentary, no markdown fences.\n\n\
         FILE: {path}\n\n\
         <code before the cursor>\n{head}\n{near}\n</code before the cursor>\n\n\
         <code after the cursor>\n{suffix}\n</code after the cursor>\n\n\
         Completion:"
    )
}

/// The streaming request body. Identical knobs to the batch path (small max_tokens, stop at a blank
/// line, temperature 0) but `stream: true` so the first line can land well before the whole body.
pub fn build_stream_request_body(provider: &Provider, head: &str, near: &str, suffix: &str, path: &str) -> Value {
    let mut body = json!({
        "model": provider.model,
        "messages": [{ "role": "user", "content": build_stream_prompt(head, near, suffix, path) }],
        "max_tokens": MAX_TOKENS,
        "stop": STOP_BLANK_LINE,
        "temperature": 0,
        "stream": true,
    });
    if provider.thinking_off {
        body["enable_thinking"] = Value::Bool(false);
    }
    body
}

// Cancel registry: each streaming request registers an AtomicBool under its id; ghost_cancel flips
// it, and the stream loop checks it between chunks. Keyed by request id (the webview owns the id),
// so a keystroke cancels exactly its own in-flight completion and nothing else.
fn cancel_registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_cancel(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    cancel_registry().lock().unwrap().insert(id.to_string(), flag.clone());
    flag
}

fn unregister_cancel(id: &str) {
    cancel_registry().lock().unwrap().remove(id);
}

/// Ask an in-flight streaming ghost to stop. Idempotent; a completed/unknown id is a no-op.
#[tauri::command]
pub fn ghost_cancel(id: String) -> Result<(), String> {
    if let Some(flag) = cancel_registry().lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn trace_stream(ms: u128, ttl_ms: u64, model: &str, chars: usize, reason: &str) {
    let dir = crate::desktop_bus_dir();
    let _ = std::fs::create_dir_all(&dir);
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("app-trace.log")) {
        use std::io::Write;
        let _ = writeln!(f, "{ts} ghost-stream: ms={ms} ttl={ttl_ms} model={model} chars={chars} reason={reason}");
    }
}

/// One streaming inline-completion call. Reads provider config at runtime, opens a `stream: true`
/// request, and reads the SSE byte stream as it arrives — forwarding each delta on `on_event` and
/// resolving to the first-line ghost the moment the first line is complete (or at ~32 tokens),
/// aborting the rest of the HTTP stream. The 2 s budget is TIME-TO-FIRST-LINE: if no first line has
/// landed by then, the request is dropped and an error is returned (the editor shows no ghost).
#[tauri::command]
pub async fn ghost_complete_stream(
    id: String,
    head: String,
    near: String,
    suffix: String,
    path: String,
    on_event: Channel<GhostEvent>,
) -> Result<String, String> {
    let t0 = Instant::now();
    let env_file = read_env_file();
    let provider = pick_provider(&env_file)
        .ok_or_else(|| "ghost: no QWEN_API_KEY or DEEPSEEK_API_KEY in ~/.agent-bus/.env".to_string())?;
    let body = build_stream_request_body(&provider, &head, &near, &suffix, &path).to_string();

    let cancel = register_cancel(&id);
    let outcome = run_stream(&id, &provider, body, &cancel, &on_event, t0).await;
    unregister_cancel(&id);
    outcome
}

async fn run_stream(
    id: &str,
    provider: &Provider,
    body: String,
    cancel: &Arc<AtomicBool>,
    on_event: &Channel<GhostEvent>,
    t0: Instant,
) -> Result<String, String> {
    // No request-level `.timeout()` here: that clock runs to the END of the body, which we abort
    // early by design. The deadline below bounds time-to-first-line instead.
    let client = reqwest::Client::builder()
        .connect_timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("ghost: client: {e}"))?;
    let url = format!("{}/chat/completions", provider.base.trim_end_matches('/'));

    // Bound the connect + header wait to the budget; a stall before any token is a TTL miss.
    let send = client
        .post(&url)
        .bearer_auth(&provider.key)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .body(body)
        .send();
    let res = match tokio::time::timeout(TIMEOUT, send).await {
        Err(_) => {
            trace_stream(t0.elapsed().as_millis(), 0, provider.model, 0, "timeout-headers");
            return Err("ghost: time-to-first-line exceeded before headers".to_string());
        }
        Ok(Err(e)) => {
            trace_stream(t0.elapsed().as_millis(), 0, provider.model, 0, "connect");
            return Err(format!("ghost: request failed: {e}"));
        }
        Ok(Ok(res)) => res,
    };

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        trace_stream(t0.elapsed().as_millis(), 0, provider.model, 0, "http");
        return Err(format!("ghost: http {status}: {}", text.chars().take(200).collect::<String>()));
    }

    let deadline = t0 + TIMEOUT; // the 2 s time-to-first-line budget, measured from t0
    let mut stream = res.bytes_stream();
    let mut buf = String::new();
    let mut acc = GhostAcc::default();
    let mut ttl_ms: Option<u64> = None;

    loop {
        if cancel.load(Ordering::Relaxed) {
            // Dropping `stream` aborts the HTTP stream; we never read the rest.
            trace_stream(t0.elapsed().as_millis(), 0, provider.model, 0, "cancelled");
            return Err("ghost: cancelled".to_string());
        }
        let now = Instant::now();
        if now >= deadline {
            trace_stream(t0.elapsed().as_millis(), 0, provider.model, acc.ghost().chars().count(), "timeout");
            return Err("ghost: time-to-first-line exceeded".to_string());
        }
        match tokio::time::timeout(deadline - now, stream.next()).await {
            Err(_) => {
                trace_stream(t0.elapsed().as_millis(), 0, provider.model, acc.ghost().chars().count(), "timeout");
                return Err("ghost: time-to-first-line exceeded".to_string());
            }
            Ok(None) => break, // stream ended before a newline; show what we have
            Ok(Some(Err(e))) => {
                trace_stream(t0.elapsed().as_millis(), 0, provider.model, 0, "stream");
                return Err(format!("ghost: stream: {e}"));
            }
            Ok(Some(Ok(bytes))) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                let mut stop = false;
                while let Some(pos) = buf.find('\n') {
                    // split_off leaves the line (through the '\n') in `buf`; swap the remainder back.
                    let rest = buf.split_off(pos + 1);
                    let line = std::mem::replace(&mut buf, rest);
                    let line = line.trim_end_matches(['\n', '\r']);
                    let Some(payload) = sse_data(&line) else { continue };
                    let Some(delta) = parse_stream_delta(&payload).filter(|d| !d.is_empty()) else { continue };
                    acc.push(&delta);
                    let _ = on_event.send(GhostEvent::Delta { id: id.to_string(), text: delta });
                    if acc.first_line_done() || acc.token_estimate() >= MAX_TOKENS as usize {
                        if acc.first_line_done() {
                            ttl_ms = Some(t0.elapsed().as_millis() as u64);
                        }
                        stop = true;
                        break;
                    }
                }
                if stop {
                    break;
                }
            }
        }
    }

    let ghost = acc.ghost();
    if ghost.trim().is_empty() {
        trace_stream(t0.elapsed().as_millis(), 0, provider.model, 0, "empty");
        return Err("ghost: empty stream".to_string());
    }
    let ttl = ttl_ms.unwrap_or_else(|| t0.elapsed().as_millis() as u64);
    let reason = if ttl_ms.is_some() { "newline" } else if acc.token_estimate() >= MAX_TOKENS as usize { "tokens" } else { "eof" };
    let _ = on_event.send(GhostEvent::Done {
        id: id.to_string(),
        text: ghost.clone(),
        ttl_ms: ttl,
        reason: reason.to_string(),
    });
    trace_stream(t0.elapsed().as_millis(), ttl, provider.model, ghost.chars().count(), reason);
    Ok(ghost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_handles_comments_quotes_and_export_prefixes() {
        let env = parse_env(
            "# a comment\n\nQWEN_API_KEY=sk-live\nDEEPSEEK_API_KEY=\"sk-deep\"\nexport OTHER='a b'\n",
        );
        assert_eq!(env.get("QWEN_API_KEY").map(String::as_str), Some("sk-live"));
        assert_eq!(env.get("DEEPSEEK_API_KEY").map(String::as_str), Some("sk-deep"));
        assert_eq!(env.get("OTHER").map(String::as_str), Some("a b"));
        assert_eq!(env.len(), 3);
    }

    #[test]
    fn pick_provider_prefers_qwen_and_falls_back_to_deepseek() {
        // SAFETY: these env vars would otherwise leak from the seat into the assertion.
        std::env::remove_var("QWEN_API_KEY");
        std::env::remove_var("DEEPSEEK_API_KEY");

        let qwen_env = parse_env("QWEN_API_KEY=sk-q\nDEEPSEEK_API_KEY=sk-d\n");
        let qwen = pick_provider(&qwen_env).expect("qwen key present");
        assert_eq!(qwen.model, "qwen3.8-flash");
        assert!(qwen.thinking_off);
        assert_eq!(qwen.base, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");

        let deep_env = parse_env("DEEPSEEK_API_KEY=sk-d\n");
        let deep = pick_provider(&deep_env).expect("deepseek fallback");
        assert_eq!(deep.model, "deepseek-v4-flash");
        assert!(!deep.thinking_off);
        assert_eq!(deep.base, "https://api.deepseek.com/v1");

        assert!(pick_provider(&HashMap::new()).is_none());
    }

    #[test]
    fn request_body_shapes_the_chat_call() {
        let p = Provider {
            base: QWEN_BASE, model: QWEN_MODEL, key: "k".into(), thinking_off: true,
        };
        let body = build_request_body(&p, "fn a() {", "}", "src/a.ts");
        assert_eq!(body["model"], "qwen3.8-flash");
        assert_eq!(body["max_tokens"], 32);
        assert_eq!(body["enable_thinking"], false);
        assert_eq!(body["stop"], json!(["\n\n"]));
        let content = body["messages"][0]["content"].as_str().unwrap();
        assert!(content.contains("fn a() {"));   // prefix present
        assert!(content.contains("}"));
        assert!(content.contains("src/a.ts"));
        assert!(content.contains("Do NOT repeat the prefix or the suffix"));
    }

    #[test]
    fn deepseek_body_omits_the_qwen_thinking_flag() {
        let p = Provider {
            base: DEEPSEEK_BASE, model: DEEPSEEK_MODEL, key: "k".into(), thinking_off: false,
        };
        let body = build_request_body(&p, "x", "y", "f.ts");
        assert_eq!(body["model"], "deepseek-v4-flash");
        assert!(body.get("enable_thinking").is_none());
    }

    #[test]
    fn parse_completion_reads_the_first_choice() {
        let raw = r#"{"choices":[{"message":{"content":"\n  const ok = true;\n\n"}}]}"#;
        assert_eq!(parse_completion(raw).unwrap(), "const ok = true;");
        assert!(parse_completion("{}").is_err());
        assert!(parse_completion("not json").is_err());
    }

    // ── #6160 streaming shapes ────────────────────────────────────────────────────────────────

    #[test]
    fn sse_data_extracts_payloads_and_skips_sentinels() {
        assert_eq!(sse_data("data: {\"a\":1}").as_deref(), Some("{\"a\":1}"));
        assert!(sse_data("data:[DONE]").is_none());
        assert!(sse_data("data: [DONE]").is_none());
        assert!(sse_data(": keep-alive").is_none());
        assert!(sse_data("").is_none());
        assert!(sse_data("event: ping").is_none());
    }

    #[test]
    fn parse_stream_delta_reads_chunk_content_and_ignores_metadata_chunks() {
        let with = r#"{"choices":[{"delta":{"content":"  return x;"}}]}"#;
        assert_eq!(parse_stream_delta(with).as_deref(), Some("  return x;"));
        let empty = r#"{"choices":[{"delta":{"content":""}}]}"#;
        assert_eq!(parse_stream_delta(empty).as_deref(), Some(""));
        let role_only = r#"{"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert!(parse_stream_delta(role_only).is_none());
        let finish = r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#;
        assert!(parse_stream_delta(finish).is_none());
        assert!(parse_stream_delta("not json").is_none());
    }

    #[test]
    fn ghost_acc_stops_at_first_line_and_estimates_tokens() {
        let mut acc = GhostAcc::default();
        assert!(!acc.first_line_done());
        acc.push("let a = ");
        assert!(!acc.first_line_done());
        assert_eq!(acc.ghost(), "let a =");
        acc.push("1;\nlet b = 2;");
        assert!(acc.first_line_done());
        assert_eq!(acc.ghost(), "let a = 1;");
        assert_eq!(acc.token_estimate(), 8);
    }

    #[test]
    fn ghost_acc_without_newline_returns_the_whole_stream_trimmed() {
        let mut acc = GhostAcc::default();
        acc.push("return done();  ");
        assert!(!acc.first_line_done());
        assert_eq!(acc.ghost(), "return done();");
    }

    #[test]
    fn stream_prompt_orders_stable_prefix_before_the_volatile_near_lines() {
        let prompt = build_stream_prompt("HEADLINE", "NEARLINE", "SUFFIXLINE", "src/a.ts");
        let file = prompt.find("FILE: src/a.ts").expect("file header present");
        let head = prompt.find("HEADLINE").expect("head present");
        let near = prompt.find("NEARLINE").expect("near present");
        let suffix = prompt.find("SUFFIXLINE").expect("suffix present");
        // The cached-input tier needs the STABLE bytes to lead: header and the context block above
        // the cursor first, the per-keystroke near lines after, and the suffix after those.
        assert!(file < head);
        assert!(head < near);
        assert!(near < suffix);
    }

    #[test]
    fn stream_request_body_streams_and_keeps_the_small_knobs() {
        let p = Provider { base: QWEN_BASE, model: QWEN_MODEL, key: "k".into(), thinking_off: true };
        let body = build_stream_request_body(&p, "head", "near", "suffix", "f.ts");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 32);
        assert_eq!(body["enable_thinking"], false);
        assert_eq!(body["stop"], json!(["\n\n"]));
        let content = body["messages"][0]["content"].as_str().unwrap();
        assert!(content.contains("head\nnear"));
    }

    #[test]
    fn cancel_registry_flips_only_the_named_request() {
        let flag = register_cancel("req-6160");
        assert!(!flag.load(Ordering::Relaxed));
        ghost_cancel("req-6160".to_string()).expect("cancel by id");
        assert!(flag.load(Ordering::Relaxed));
        ghost_cancel("never-existed".to_string()).expect("unknown id is a no-op");
        unregister_cancel("req-6160");
    }

    // ── #5897 latency probe ─────────────────────────────────────────────────────────────────────
    // NOT part of `cargo test`: it makes 80 REAL calls against the live token-plan endpoint and
    // spends the provider key. Run it on purpose:
    //   cargo test ghost_latency_matrix -- --ignored --nocapture
    // It exercises the SAME request builder ghost_complete uses (only max_tokens overridden per
    // case, and a longer timeout so the probe SEES latencies production's 2 s cap would censor),
    // across the four shapes the card asks about — max_tokens 32/64 × 30/60 lines of context —
    // and prints p50/p95 plus a sample first line per shape, so the fastest shape that still
    // returns a useful first line can become the default.
    const RUNS: usize = 20;
    const PROBE_SUFFIX: &str = "}\n";
    /// The TS side splits the before-cursor context so the last ~8 lines (the only part that
    /// changes on every keystroke) ride LAST in the prompt; the probe reproduces that same split.
    const NEAR_LINES: usize = 8;

    fn probe_prefix(lines: usize) -> String {
        let mut s = String::from(
            "import { invoke } from \"@tauri-apps/api/core\";\n\nexport function loadDrafts(project: string) {\n",
        );
        for i in 0..lines {
            s.push_str(&format!("  const row{i} = parseRow(cache.get(\"{i}\"), project);\n"));
        }
        s.push_str("  return rows.filter(Boolean);\n");
        s
    }

    fn percentile(sorted: &[u128], p: f64) -> u128 {
        let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
        sorted[idx.min(sorted.len().saturating_sub(1))]
    }

    #[test]
    #[ignore]
    fn ghost_latency_matrix() {
        // tokio is a dependency without the `macros` feature, so the runtime is hand-rolled.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async {
            let env_file = read_env_file();
            // Every provider whose key is present, best first (the production order): qwen, then
            // the deepseek fallback — the matrix runs for EACH, so one invocation compares them.
            let mut providers: Vec<Provider> = Vec::new();
            if let Some(key) = env_value(&env_file, "QWEN_API_KEY") {
                providers.push(Provider { base: QWEN_BASE, model: QWEN_MODEL, key, thinking_off: true });
            }
            if let Some(key) = env_value(&env_file, "DEEPSEEK_API_KEY") {
                providers.push(Provider { base: DEEPSEEK_BASE, model: DEEPSEEK_MODEL, key, thinking_off: false });
            }
            if providers.is_empty() {
                eprintln!("probe: no QWEN_API_KEY or DEEPSEEK_API_KEY in ~/.agent-bus/.env — nothing to measure");
                return;
            }
            for provider in &providers {
            eprintln!("probe: model={} base={}", provider.model, provider.base);
            let cases: [(&str, u64, String); 4] = [
                ("mt32 ctx30", 32, probe_prefix(30)),
                ("mt32 ctx60", 32, probe_prefix(60)),
                ("mt64 ctx30", 64, probe_prefix(30)),
                ("mt64 ctx60", 64, probe_prefix(60)),
            ];
            for (name, max_tokens, prefix) in &cases {
                let mut latencies: Vec<u128> = Vec::with_capacity(RUNS);
                let mut errors = 0usize;
                let mut first_lines: Vec<String> = Vec::new();
                for _ in 0..RUNS {
                    // The production body, then the one knob this case turns.
                    let mut body = build_request_body(&provider, prefix, PROBE_SUFFIX, "src/features/code/documents.ts");
                    body["max_tokens"] = json!(*max_tokens);
                    let t0 = Instant::now();
                    // Same per-request client as ghost_complete; a longer timeout only so a slow
                    // call is RECORDED, not censored at 2 s.
                    let outcome = async {
                        let client = reqwest::Client::builder()
                            .timeout(Duration::from_secs(15))
                            .build()
                            .map_err(|e| format!("client: {e}"))?;
                        let res = client
                            .post(format!("{}/chat/completions", provider.base.trim_end_matches('/')))
                            .bearer_auth(&provider.key)
                            .header("content-type", "application/json")
                            .body(body.to_string())
                            .send()
                            .await
                            .map_err(|e| format!("send: {e}"))?;
                        let status = res.status();
                        let text = res.text().await.map_err(|e| format!("body: {e}"))?;
                        if !status.is_success() {
                            return Err(format!("http {status}: {}", text.chars().take(120).collect::<String>()));
                        }
                        parse_completion(&text)
                    }
                    .await;
                    match outcome {
                        Ok(completion) => {
                            latencies.push(t0.elapsed().as_millis());
                            let first = completion.lines().next().unwrap_or("").chars().take(70).collect::<String>();
                            if first_lines.len() < 3 {
                                first_lines.push(first);
                            }
                        }
                        Err(e) => {
                            errors += 1;
                            eprintln!("probe[{name}] error: {e}");
                        }
                    }
                }
                latencies.sort_unstable();
                if latencies.is_empty() {
                    eprintln!("probe[{name}] ALL {errors} calls failed");
                    continue;
                }
                eprintln!(
                    "probe[{name}] n={} errors={} p50={}ms p95={}ms min={}ms max={}ms",
                    latencies.len(),
                    errors,
                    percentile(&latencies, 0.50),
                    percentile(&latencies, 0.95),
                    latencies[0],
                    latencies[latencies.len() - 1],
                );
                for (i, line) in first_lines.iter().enumerate() {
                    eprintln!("probe[{name}] sample{i}: {line}");
                }
            }
            }
        });
    }

    // ── #6160 streaming probe ───────────────────────────────────────────────────────────────────
    // The acceptance item for #6160: p50 TIME-TO-FIRST-LINE under 600 ms on qwen3.8-flash. This is
    // the same 20-run harness as ghost_latency_matrix, but it streams: it measures t0 -> the instant
    // the first '\n' of completion content lands (the moment the ghost would paint), NOT the whole
    // response. Run it on purpose (it spends the provider key on 20 REAL streaming calls):
    //   cargo test ghost_stream_latency -- --ignored --nocapture
    // The ceiling is 15 s per call so a slow one is RECORDED (production censors it at 2 s); the
    // numbers decide whether the streaming target is met.
    async fn stream_first_line_ms(provider: &Provider, head: &str, near: &str) -> Result<(u64, String), String> {
        let t0 = Instant::now();
        let body = build_stream_request_body(provider, head, near, PROBE_SUFFIX, "src/features/code/documents.ts");
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("client: {e}"))?;
        let res = client
            .post(format!("{}/chat/completions", provider.base.trim_end_matches('/')))
            .bearer_auth(&provider.key)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("send: {e}"))?;
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(format!("http {status}: {}", text.chars().take(120).collect::<String>()));
        }
        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut acc = GhostAcc::default();
        let ceiling = t0 + Duration::from_secs(15);
        loop {
            match tokio::time::timeout(ceiling.saturating_duration_since(Instant::now()), stream.next()).await {
                Err(_) => return Err("15s ceiling hit before first line".to_string()),
                Ok(None) => break,
                Ok(Some(Err(e))) => return Err(format!("stream: {e}")),
                Ok(Some(Ok(bytes))) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    let mut done = false;
                    while let Some(pos) = buf.find('\n') {
                        let rest = buf.split_off(pos + 1);
                        let line = std::mem::replace(&mut buf, rest);
                        let line = line.trim_end_matches(['\n', '\r']);
                        let Some(payload) = sse_data(&line) else { continue };
                        let Some(delta) = parse_stream_delta(&payload).filter(|d| !d.is_empty()) else { continue };
                        acc.push(&delta);
                        if acc.first_line_done() {
                            done = true;
                            break;
                        }
                    }
                    if done {
                        return Ok((t0.elapsed().as_millis() as u64, acc.ghost()));
                    }
                }
            }
        }
        // The model ended without a newline — the whole reply IS the first line.
        if acc.content.trim().is_empty() {
            return Err("empty stream".to_string());
        }
        Ok((t0.elapsed().as_millis() as u64, acc.ghost()))
    }

    #[test]
    #[ignore]
    fn ghost_stream_latency() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async {
            let env_file = read_env_file();
            let mut providers: Vec<Provider> = Vec::new();
            if let Some(key) = env_value(&env_file, "QWEN_API_KEY") {
                providers.push(Provider { base: QWEN_BASE, model: QWEN_MODEL, key, thinking_off: true });
            }
            if let Some(key) = env_value(&env_file, "DEEPSEEK_API_KEY") {
                providers.push(Provider { base: DEEPSEEK_BASE, model: DEEPSEEK_MODEL, key, thinking_off: false });
            }
            if providers.is_empty() {
                eprintln!("stream-probe: no QWEN_API_KEY or DEEPSEEK_API_KEY in ~/.agent-bus/.env — nothing to measure");
                return;
            }
            // The production prompt shape: 30 lines of context, split the way ghostText.ts does it —
            // a stable head and the volatile last NEAR_LINES right before the cursor.
            let full = probe_prefix(30);
            let lines: Vec<&str> = full.lines().collect();
            let split = lines.len().saturating_sub(NEAR_LINES);
            let head = lines[..split].join("\n");
            let near = lines[split..].join("\n");
            for provider in &providers {
                eprintln!("stream-probe: model={} head={} near={}", provider.model, head.lines().count(), near.lines().count());
                let mut ttl: Vec<u128> = Vec::with_capacity(RUNS);
                let mut errors = 0usize;
                let mut samples: Vec<String> = Vec::new();
                for run in 0..RUNS {
                    match stream_first_line_ms(provider, &head, &near).await {
                        Ok((ms, line)) => {
                            ttl.push(ms as u128);
                            if samples.len() < 3 {
                                samples.push(line.chars().take(70).collect());
                            }
                            eprintln!("stream-probe run{run}: ttl={ms}ms");
                        }
                        Err(e) => {
                            errors += 1;
                            eprintln!("stream-probe run{run} error: {e}");
                        }
                    }
                }
                ttl.sort_unstable();
                if ttl.is_empty() {
                    eprintln!("stream-probe ALL {errors} calls failed");
                    continue;
                }
                eprintln!(
                    "stream-probe n={} errors={} ttl p50={}ms p95={}ms min={}ms max={}ms",
                    ttl.len(), errors, percentile(&ttl, 0.50), percentile(&ttl, 0.95), ttl[0], ttl[ttl.len() - 1],
                );
                for (i, s) in samples.iter().enumerate() {
                    eprintln!("stream-probe sample{i}: {s}");
                }
            }
        });
    }
}
