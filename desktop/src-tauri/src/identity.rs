// trantor desktop — request signing, in RUST so the private key never reaches the webview.
//
// This MUST produce byte-identical signatures to lib/identity.mjs. The canonical string is a fixed
// six-field, newline-joined block; any divergence (field order, a trailing newline, hex casing)
// yields a signature the hub rejects with a generic 401, which is miserable to debug from the JS side.
//
//   trantor-v1
//   <METHOD>
//   <PATH+QUERY>
//   <sha256(body) hex, or "" when there is no body>
//   <unix ms>
//   <16 random bytes, hex>
//
// Keys are the same files the CLI and hooks already use: ~/.agent-bus/keys/<safe-name>.json, holding
// the RAW 32-byte scalars as hex. We never write them, only read.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

pub const SCHEME: &str = "trantor-v1";

#[derive(Deserialize)]
struct KeyFile { pubkey: String, privkey: String }

fn bus_dir() -> PathBuf {
    std::env::var("AGENT_BUS_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".agent-bus")
    })
}

/// Mirrors safe() in lib/identity.mjs: collapse dot-runs FIRST (so no `..` can survive even in
/// principle), then reduce to the safe charset. Relying on separator-stripping alone would put
/// traversal one regex edit away.
fn safe_name(name: &str) -> String {
    let mut s = String::with_capacity(name.len());
    let mut dots = 0usize;
    for c in name.chars() {
        if c == '.' { dots += 1; continue; }
        if dots > 0 { s.push(if dots >= 2 { '_' } else { '.' }); dots = 0; }
        s.push(if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' });
    }
    if dots > 0 { s.push(if dots >= 2 { '_' } else { '.' }); }
    s
}

fn load_key(name: &str) -> Result<(SigningKey, String), String> {
    let path = bus_dir().join("keys").join(format!("{}.json", safe_name(name)));
    let raw = fs::read_to_string(&path).map_err(|e| format!("no key for {name}: {e}"))?;
    let kf: KeyFile = serde_json::from_str(&raw).map_err(|e| format!("bad key file: {e}"))?;
    let bytes = hex_to_32(&kf.privkey).ok_or("privkey is not 32 bytes of hex")?;
    Ok((SigningKey::from_bytes(&bytes), kf.pubkey))
}

fn hex_to_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 { return None; }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn canonical(method: &str, path: &str, body_hash: &str, ts: u128, nonce: &str) -> String {
    format!("{}\n{}\n{}\n{}\n{}\n{}", SCHEME, method.to_uppercase(), path, body_hash, ts, nonce)
}

/// Returns the four headers for one request. `body` must be the EXACT bytes sent — sign what is sent,
/// never a re-serialisation, or the hub's hash will not match ours.
pub fn sign(identity: &str, method: &str, path: &str, body: Option<&str>) -> Result<HashMap<String, String>, String> {
    let (key, pubkey) = load_key(identity)?;
    let body_hash = match body {
        Some(b) if !b.is_empty() => hex(&Sha256::digest(b.as_bytes())),
        _ => String::new(),
    };
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let mut nb = [0u8; 16];
    rand::rng().fill_bytes(&mut nb);
    let nonce = hex(&nb);
    let msg = canonical(method, path, &body_hash, ts, &nonce);
    let sig = key.sign(msg.as_bytes());

    let mut h = HashMap::new();
    h.insert("x-trantor-pubkey".into(), pubkey);
    h.insert("x-trantor-sig".into(), B64.encode(sig.to_bytes()));
    h.insert("x-trantor-ts".into(), ts.to_string());
    h.insert("x-trantor-nonce".into(), nonce);
    Ok(h)
}

/// Per-project hub routing (TDD §12.1): a project lives on exactly ONE hub. Same precedence the JS
/// resolveHub() uses — env, then the per-project pin, then the global default.
pub fn hub_for_project(project: &str) -> String {
    if let Ok(u) = std::env::var("RELAY_URL") { if !u.is_empty() { return u; } }
    let cfg_path = bus_dir().join("config.json");
    if let Ok(raw) = fs::read_to_string(cfg_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(u) = v.get("hubs").and_then(|h| h.get(project)).and_then(|u| u.as_str()) {
                return u.trim_end_matches('/').to_string();
            }
            if let Some(u) = v.get("url").and_then(|u| u.as_str()) {
                return u.trim_end_matches('/').to_string();
            }
        }
    }
    "http://127.0.0.1:4477".into()
}

/// A project is something you can actually OPEN: a hub you pinned, or a checkout on this machine.
///
/// It is deliberately NOT "any project name the bus has ever mentioned". Sessions register with
/// whatever string they resolved, and a path slug or an agent id is not a project — that is how the
/// sidebar ended up listing `-Users-sashabogojevic-…` and `agent-a52823753451c…` beside real work.
/// A positive rule beats blocklisting name shapes, which only ever catches the junk you have
/// already seen.
pub fn known_projects() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(raw) = fs::read_to_string(bus_dir().join("config.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(h) = v.get("hubs").and_then(|h| h.as_object()) {
                out.extend(h.keys().cloned());
            }
        }
    }
    // Every checkout in the dev root, whether or not it was ever pinned. This is the list the
    // operator means when they say "all of the projects are in the development folder".
    let root = std::env::var("TRANTOR_DEV_ROOT")
        .unwrap_or_else(|_| format!("{}/development", std::env::var("HOME").unwrap_or_default()));
    if let Ok(rd) = fs::read_dir(&root) {
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with('_') {
                continue;
            }
            // A directory is a project when it is a repo. A scratch folder is not.
            if e.path().join(".git").exists() {
                out.push(name);
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_matches_the_js_shape() {
        let c = canonical("post", "/send?x=1", "abc", 123, "nnn");
        assert_eq!(c, "trantor-v1\nPOST\n/send?x=1\nabc\n123\nnnn");
        assert!(!c.ends_with('\n'), "a trailing newline would break signature parity with JS");
    }
    #[test]
    fn safe_name_cannot_traverse() {
        assert!(!safe_name("../../etc/passwd").contains(".."));
        assert_eq!(safe_name("MacBook-Pro-M1:trantor"), "MacBook-Pro-M1_trantor");
        assert_eq!(safe_name("builtbetter.ai"), "builtbetter.ai");
    }
}

#[cfg(test)]
mod parity {
    use super::safe_name;
    #[test]
    fn matches_js_safe_name_for_the_owner_identity() {
        // JS: String(s).replace(/\.{2,}/g,"_").replace(/[^A-Za-z0-9_.-]/g,"_")
        assert_eq!(safe_name("sasha@mac"), "sasha_mac");
        assert_eq!(safe_name("codex:reddit-weekly"), "codex_reddit-weekly");
    }
}

/// Perform a SIGNED request to a hub, from Rust.
///
/// Why not fetch() in the webview: macOS App Transport Security blocks cleartext HTTP from WKWebView,
/// so a hub on http://100.79.242.104:4477 fails with a bare "Load failed" that CSP cannot fix. Doing
/// it here sidesteps ATS entirely AND keeps the private key on this side of the boundary — the
/// webview never sees a key or a signature, only JSON.
pub async fn request(identity: &str, base: &str, method: &str, path: &str, body: Option<String>)
    -> Result<(u16, String), String>
{
    let headers = sign(identity, method, path, body.as_deref())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build().map_err(|e| e.to_string())?;
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(m, &url);
    for (k, v) in headers { req = req.header(k, v); }
    if let Some(b) = body { req = req.header("content-type", "application/json").body(b); }
    let res = req.send().await.map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

/// Open the hub's SSE stream and hand each event to `on_event`.
///
/// In Rust rather than the webview for the same reason as request(): macOS ATS blocks cleartext HTTP
/// from WKWebView. It also means EventSource's absence costs us nothing — we were already parsing
/// frames by hand because EventSource cannot send auth headers.
///
/// Reconnect is ours to own: backoff capped so a hub restart recovers fast while a dead network does
/// not spin, and `since` resumes from the last id so a reconnect never drops events.
pub async fn stream(identity: &str, base: &str, mut on_event: impl FnMut(String)) {
    use futures_util::StreamExt;
    let mut last_id: u64 = 0;
    let mut backoff = 1u64;
    loop {
        let path = if last_id > 0 { format!("/stream?events=1&since={last_id}") } else { "/stream?events=1".into() };
        let headers = match sign(identity, "GET", &path, None) { Ok(h) => h, Err(_) => return };
        let client = match reqwest::Client::builder().build() { Ok(c) => c, Err(_) => return };
        let mut req = client.get(format!("{}{}", base.trim_end_matches('/'), path));
        for (k, v) in headers { req = req.header(k, v); }

        match req.send().await {
            Ok(res) if res.status().is_success() => {
                backoff = 1;
                let mut buf = String::new();
                let mut body = res.bytes_stream();
                while let Some(chunk) = body.next().await {
                    let Ok(bytes) = chunk else { break };
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    // A chunk can split a frame, so only consume complete blank-line-delimited blocks.
                    while let Some(sep) = buf.find("\n\n") {
                        let frame: String = buf.drain(..sep + 2).collect();
                        let (mut name, mut data) = (String::new(), String::new());
                        for line in frame.lines() {
                            if let Some(v) = line.strip_prefix("event:") { name = v.trim().to_string(); }
                            else if let Some(v) = line.strip_prefix("data:") { data.push_str(v.trim()); }
                            else if let Some(v) = line.strip_prefix("id:") {
                                if let Ok(n) = v.trim().parse::<u64>() { last_id = n; }
                            }
                        }
                        // The hub emits a NAMED `ev` channel; anything else is keepalive or legacy.
                        if name == "ev" && !data.is_empty() { on_event(data); }
                    }
                }
            }
            _ => {}
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(15);
    }
}
