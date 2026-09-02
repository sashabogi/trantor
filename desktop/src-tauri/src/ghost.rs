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
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
}
