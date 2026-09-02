//! Language servers for the Code lens — one per (root, language), framed with the LSP base
//! protocol (`Content-Length`).
//!
//! This module is the SINGLE owner of language-server lifecycle (SYSTEM-CONTRACT §4): it spawns
//! them, frames their JSON-RPC, and stops them. The TS side sees four thin edges only —
//! `lsp_start` → an id, `lsp_send` to write, `lsp-message:<id>` events back, `lsp_stop` to kill.
//! A server never outlives its lens (the TS effect cleanup calls `lsp_stop`) and app exit stops
//! whatever is left. Detection is a PATH scan on `terminal_path()`; a missing binary is
//! `Err("not installed: <name>")`, never a spinner and never a pretend "ready".

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use serde_json::Value;
use std::time::UNIX_EPOCH;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

use crate::{source_root, terminal_path};

// ── framing (pure, unit-tested) ─────────────────────────────────────────────────────────────

/// Encode one JSON-RPC message with the LSP base-protocol frame: `Content-Length: N\r\n\r\n`,
/// then exactly N bytes of body. The reader half is [`LspDecoder`]; together they are the whole
/// transport, so framing is correct in exactly one place.
pub fn frame(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + 32);
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes());
    out.extend_from_slice(message);
    out
}

/// Incremental decoder for the LSP base protocol. Feed it arbitrary byte chunks; it returns only
/// COMPLETE message bodies, in order — a read split mid-message yields nothing, and two messages
/// arriving in one chunk come out as two bodies.
#[derive(Default)]
pub struct LspDecoder {
    buf: Vec<u8>,
}

impl LspDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let Some((header_len, body_len)) = measure_header(&self.buf) else {
                break;
            };
            if self.buf.len() < header_len + body_len {
                break;
            }
            let body = self.buf[header_len..header_len + body_len].to_vec();
            self.buf.drain(..header_len + body_len);
            out.push(body);
        }
        out
    }
}

/// `(header_len, body_len)` when the buffer holds a complete header with a valid Content-Length;
/// `header_len` includes the blank-line terminator.
fn measure_header(buf: &[u8]) -> Option<(usize, usize)> {
    let header_len = header_end(buf)?;
    let body_len = parse_content_length(&buf[..header_len])?;
    Some((header_len, body_len))
}

/// Byte length of the header section — up to and including the `\r\n\r\n` (or `\n\n`) terminator.
fn header_end(buf: &[u8]) -> Option<usize> {
    if let Some(i) = find_subslice(buf, b"\r\n\r\n") {
        return Some(i + 4);
    }
    find_subslice(buf, b"\n\n").map(|i| i + 2)
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// `Content-Length: N` out of a raw header block. Case-insensitive on the name, tolerant of
/// `\r\n`/`\n` line endings and of other headers (Content-Type) arriving first.
fn parse_content_length(header: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(header);
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r').trim();
        if line.len() >= 15 && line[..15].eq_ignore_ascii_case("content-length:") {
            return line[15..].trim().parse().ok();
        }
    }
    None
}

// ── server registry ──────────────────────────────────────────────────────────────────────────

/// A language server OUTLIVES the editor lens (SYSTEM-CONTRACT §4): it lives until the project
/// switches, it sits idle past the timeout, or the app exits — a lens flip must NOT cold-restart
/// it. `last_activity` is bumped on every `lsp_send` and drives the idle reaper.
struct Server {
    child: Child,
    stdin: ChildStdin,
    project: String,
    workspace_root: String,
    language: String,
    last_activity: Instant,
    /// Set when the client's `initialized` notification crosses the wire (lsp_send peeks at the
    /// method). From then on, another `initialize` on this process is fatal to the server.
    initialized: bool,
}

/// A server nobody has written to for this long is idle and is stopped.
const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// What `lsp_start` hands back: the id the editor keys every later call by, plus TWO roots.
/// `scope_root` is the project dir or seat worktree — the model's absolute URI is
/// `<scope_root>/<path>`. `workspace_root` is the nearest manifest walking up from the file (the
/// crate), which is what the `workspaceFolder`/`rootUri` must name or rust-analyzer loads nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStarted {
    id: u64,
    scope_root: String,
    workspace_root: String,
    /// Whether THIS live server has already been through the LSP handshake. When true, a NEW
    /// monaco client must not `start()` against it — that re-sends `initialize` and rust-analyzer
    /// exits on the spot (rust-1.log: "expected initialized notification, got: Request
    /// initialize", #5857). The frontend respawns a fresh process instead.
    initialized: bool,
}

static SERVERS: Mutex<Option<HashMap<u64, Server>>> = Mutex::new(None);
/// (workspace root, language) → server id: one server per crate, so two crates in one repo get two
/// servers and a reopened file in the same crate reuses the one already running.
static WORKSPACES: Mutex<Option<HashMap<(String, String), u64>>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static REAPER: std::sync::Once = std::sync::Once::new();

/// The binary + args for a language id, plus the honest "how to fix it" lines. Only the four the
/// editor maps to are served; anything else is a name to refuse, not a guess to make.
struct ServerSpec {
    bin: &'static str,
    args: &'static [&'static str],
    /// the "run this to fix it" line, appended to every not-installed error
    install: &'static str,
    /// why a binary that EXISTS but fails its `--version` probe is broken (the rustup-proxy case)
    broken_proxy: &'static str,
}

fn server_spec(language: &str) -> Result<ServerSpec, String> {
    match language {
        "rust" => Ok(ServerSpec {
            bin: "rust-analyzer",
            args: &[],
            install: "run: rustup component add rust-analyzer",
            broken_proxy: "rustup proxy without the component",
        }),
        "typescript" | "typescriptreact" | "javascript" => Ok(ServerSpec {
            bin: "typescript-language-server",
            args: &["--stdio"],
            install: "run: npm install -g typescript-language-server",
            broken_proxy: "the binary failed its startup check",
        }),
        "python" => Ok(ServerSpec {
            bin: "pyright-langserver",
            args: &["--stdio"],
            install: "run: pip install pyright",
            broken_proxy: "the binary failed its startup check",
        }),
        other => Err(format!("no language server for {other}")),
    }
}

/// Resolve a binary on the terminal PATH — the PATH a terminal would have, not the bare one a
/// Finder-launched app inherits. Missing → the honest "not installed" the editor shows as text.
pub fn find_binary(name: &str, install: &str) -> Result<PathBuf, String> {
    for dir in terminal_path().split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!("not installed: {name} — {install}"))
}

// ── workspace-root resolution ────────────────────────────────────────────────────────────────
//
// A language server is keyed by the WORKSPACE it loads, not the checkout: ~/development/trantor
// has no Cargo.toml, the crate does (desktop/src-tauri). rootUri must be that crate, so walk UP
// from the open file to the nearest manifest, bounded by the scope root.

/// Every directory from the file's parent up to (and including) the scope root, nearest first.
fn ancestors(start: &Path, scope_root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut dir = start.to_path_buf();
    loop {
        dirs.push(dir.clone());
        if dir == scope_root {
            break;
        }
        let Some(parent) = dir.parent() else { break };
        dir = parent.to_path_buf();
    }
    dirs
}

/// The workspace root for an open file: the nearest manifest, bounded by the scope root.
pub fn workspace_root(scope_root: &Path, language: &str, file_path: &str) -> PathBuf {
    let file = scope_root.join(file_path);
    let start = file
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| scope_root.to_path_buf());
    match language {
        "rust" => rust_root(&start, scope_root),
        "typescript" | "typescriptreact" | "javascript" => ts_root(&start, scope_root),
        "python" => py_root(&start, scope_root),
        _ => scope_root.to_path_buf(),
    }
}

/// rust: the nearest Cargo.toml — but prefer a `[workspace]` manifest found higher up, else the
/// nearest package. A file under `repo/crate/src/` with a `repo/Cargo.toml [workspace]` loads the
/// workspace, not the crate, so two crates answer against the same index.
fn rust_root(start: &Path, scope_root: &Path) -> PathBuf {
    let mut manifests: Vec<(PathBuf, bool)> = Vec::new();
    for dir in ancestors(start, scope_root) {
        let cargo = dir.join("Cargo.toml");
        if cargo.is_file() {
            let is_ws = std::fs::read_to_string(&cargo)
                .map(|s| s.contains("[workspace]"))
                .unwrap_or(false);
            manifests.push((dir, is_ws));
        }
    }
    if let Some(i) = manifests.iter().rposition(|(_, ws)| *ws) {
        return manifests[i].0.clone();
    }
    manifests
        .into_iter()
        .next()
        .map(|(d, _)| d)
        .unwrap_or_else(|| scope_root.to_path_buf())
}

/// typescript/javascript: the nearest tsconfig.json, else the nearest package.json.
fn ts_root(start: &Path, scope_root: &Path) -> PathBuf {
    for dir in ancestors(start, scope_root) {
        if dir.join("tsconfig.json").is_file() {
            return dir;
        }
    }
    for dir in ancestors(start, scope_root) {
        if dir.join("package.json").is_file() {
            return dir;
        }
    }
    scope_root.to_path_buf()
}

/// python: the nearest pyproject.toml or setup.py.
fn py_root(start: &Path, scope_root: &Path) -> PathBuf {
    for dir in ancestors(start, scope_root) {
        if dir.join("pyproject.toml").is_file() || dir.join("setup.py").is_file() {
            return dir;
        }
    }
    scope_root.to_path_buf()
}
/// Prove a binary actually RUNS before we hand it a child. `is_file()` was not enough: a rustup
/// PROXY is a real file that prints "error: Unknown binary …" and exits when its component is not
/// installed. A `--version` probe with a 5s deadline catches that and any wedged binary, so the
/// lens never opens on a pretend server.
fn probe_binary(path: &Path, name: &str, install: &str, broken_proxy: &str) -> Result<(), String> {
    let mut child = Command::new(path)
        .arg("--version")
        .env("PATH", terminal_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| format!("not installed: {name} — {install}"))?;

    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap_or(None) {
            break s;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err(format!("not installed: {name} — {install}"));
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let mut stderr = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut stderr);
    }
    if !status.success() || stderr.trim_start().starts_with("error:") {
        return Err(format!("not installed: {name} — {broken_proxy}; {install}"));
    }
    Ok(())
}

fn spawn_server(
    app: tauri::AppHandle,
    id: u64,
    bin: &Path,
    args: &[&str],
    cwd: &Path,
    language: &str,
) -> Result<(Child, ChildStdin), String> {
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", bin.display()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("{}: no stdin pipe", bin.display()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{}: no stdout pipe", bin.display()))?;
    let stderr = child.stderr.take();

    // The first stderr line is the reason an early-exiting server gives for why; shared with the
    // reader thread so `lsp-closed` can carry it instead of an empty payload.
    let first_stderr: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // Reader: stdout → LSP frames → `lsp-message:<id>` events. Dies when the pipe closes.
    let event_app = app.clone();
    let language = language.to_string();
    let log_language = language.clone();
    let stderr_reason = first_stderr.clone();
    std::thread::spawn(move || {
        let mut decoder = LspDecoder::new();
        let mut reader = BufReader::new(stdout);
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for body in decoder.push(&chunk[..n]) {
                        let text = String::from_utf8_lossy(&body).to_string();
                        trace_wire(id, &language, "in", &text);
                        let _ = event_app.emit(&format!("lsp-message:{id}"), text);
                    }
                }
            }
        }
        // The server closed stdout (it exited): carry the reason it printed, so the status line
        // can say "error: Unknown binary …" instead of a bare "Unknown reason".
        let reason = stderr_reason.lock().unwrap().clone();
        let _ = event_app.emit(&format!("lsp-closed:{id}"), reason);
    });

    // Stderr drain: capture the FIRST line as the exit reason, and APPEND every line to the
    // per-server log so a server that dies has its reason on disk
    // (~/.agent-bus/lsp/<language>-<id>.log) instead of being silently discarded.
    if let Some(stderr) = stderr {
        let first = first_stderr.clone();
        let log_path = crate::desktop_bus_dir()
            .join("lsp")
            .join(format!("{log_language}-{id}.log"));
        std::thread::spawn(move || {
            if let Some(dir) = log_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let mut log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();
            let mut r = BufReader::new(stderr);
            let mut line = String::new();
            while r.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                let mut guard = first.lock().unwrap();
                if guard.is_none() {
                    *guard = Some(line.trim().to_string());
                }
                if let Some(f) = log.as_mut() {
                    let _ = f.write_all(line.as_bytes());
                }
                line.clear();
            }
        });
    }

    Ok((child, stdin))
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────

/// The reuse half of `lsp_start`, free of the AppHandle so tests can drive it: a LIVE server for
/// this (workspace root, language) is reused WITH its handshake flag; a dead one is reaped and
/// None comes back so the caller spawns fresh.
fn reuse_live_server(
    dedup_key: &(String, String),
    scope_root: &Path,
    workspace_root: &Path,
) -> Option<LspStarted> {
    let id = {
        let workspaces = WORKSPACES.lock().unwrap();
        workspaces.as_ref().and_then(|m| m.get(dedup_key).copied())
    }?;
    if !server_alive(id) {
        // The child has exited: drop the stale entry (logged for the audit trail) and respawn.
        stop_server(id, "respawn dead server");
        return None;
    }
    let initialized = {
        let servers = SERVERS.lock().unwrap();
        servers
            .as_ref()
            .and_then(|m| m.get(&id))
            .map(|s| s.initialized)
            .unwrap_or(false)
    };
    Some(started(id, scope_root, workspace_root, initialized))
}

#[tauri::command]
pub fn lsp_start(
    app: tauri::AppHandle,
    project: String,
    scope: Option<String>,
    language: String,
    path: String,
) -> Result<LspStarted, String> {
    if path.contains("..") {
        return Err("path escapes the project".into());
    }
    let scope_root = source_root(&project, scope.as_deref())?;
    let spec = server_spec(&language)?;
    let workspace_root = workspace_root(&scope_root, &language, &path);

    // One server per (workspace root, language). Reuse a LIVE server; a dead one is reaped and
    // respawned — never re-attach to an id whose process is gone (the 0.3.103 broken-pipe bug).
    let dedup_key = (workspace_root.display().to_string(), language.clone());
    if let Some(reused) = reuse_live_server(&dedup_key, &scope_root, &workspace_root) {
        return Ok(reused);
    }

    let bin_path = find_binary(spec.bin, spec.install)?;
    probe_binary(&bin_path, spec.bin, spec.install, spec.broken_proxy)?;
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (child, stdin) = spawn_server(app, id, &bin_path, spec.args, &workspace_root, &language)?;
    {
        let mut servers = SERVERS.lock().unwrap();
        servers.get_or_insert_with(HashMap::new).insert(
            id,
            Server {
                child,
                stdin,
                project: project.clone(),
                workspace_root: workspace_root.display().to_string(),
                language: language.clone(),
                last_activity: Instant::now(),
                initialized: false,
            },
        );
    }
    {
        let mut workspaces = WORKSPACES.lock().unwrap();
        workspaces.get_or_insert_with(HashMap::new).insert(dedup_key, id);
    }
    start_reaper();
    Ok(started(id, &scope_root, &workspace_root, false))
}

fn started(id: u64, scope_root: &Path, workspace_root: &Path, initialized: bool) -> LspStarted {
    LspStarted {
        id,
        scope_root: scope_root.display().to_string(),
        workspace_root: workspace_root.display().to_string(),
        initialized,
    }
}

#[tauri::command]
pub fn lsp_send(id: u64, message: String) -> Result<(), String> {
    let mut servers = SERVERS.lock().unwrap();
    let Some(map) = servers.as_mut() else {
        return Err(format!("no such language server {id}"));
    };
    let Some(server) = map.get_mut(&id) else {
        return Err(format!("no such language server {id}"));
    };
    server.last_activity = Instant::now();
    // Peek at the method: the client's `initialized` NOTIFICATION is the handshake's last step.
    // After it crosses the wire this process is initialized for life, and a second `initialize`
    // kills it — lsp_start reports the flag so the frontend respawns instead (#5857).
    if !server.initialized {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&message) {
            if v.get("method").and_then(serde_json::Value::as_str) == Some("initialized") {
                server.initialized = true;
            }
        }
    }
    trace_wire(id, &server.language, "out", &message);
    server
        .stdin
        .write_all(&frame(message.as_bytes()))
        .and_then(|_| server.stdin.flush())
        .map_err(|e| format!("write to language server {id} failed: {e}"))
}

/// Append a stop reason to ~/.agent-bus/lsp/stops.log, so every server death has an audit line.
fn log_stop(workspace_root: &str, language: &str, reason: &str) {
    let dir = crate::desktop_bus_dir().join("lsp");
    let _ = std::fs::create_dir_all(&dir);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("stops.log"))
        .ok();
    if let Some(f) = f.as_mut() {
        let _ = writeln!(f, "{language} {workspace_root}: {reason}");
    }
}

/// Whether the server's child is still running. `try_wait` reaps it if it has already exited, so a
/// dead server is detected (and later removed) here rather than re-attached.
fn server_alive(id: u64) -> bool {
    let mut servers = SERVERS.lock().unwrap();
    match servers.as_mut().and_then(|m| m.get_mut(&id)) {
        Some(server) => server.child.try_wait().map(|r| r.is_none()).unwrap_or(false),
        None => false,
    }
}

/// Kill and remove one server, logging why. Returns whether a server was actually stopped.
fn stop_server(id: u64, reason: &str) -> bool {
    let removed = {
        let mut servers = SERVERS.lock().unwrap();
        match servers.as_mut().and_then(|m| m.remove(&id)) {
            Some(mut server) => {
                let _ = server.child.kill();
                Some((server.workspace_root.clone(), server.language.clone()))
            }
            None => None,
        }
    };
    let Some((workspace_root, language)) = removed else {
        return false;
    };
    log_stop(&workspace_root, &language, reason);
    if let Ok(mut workspaces) = WORKSPACES.lock() {
        if let Some(map) = workspaces.as_mut() {
            map.retain(|_, v| *v != id);
        }
    }
    true
}

/// The idle reaper: every minute, stop any server no one has written to in 15 minutes.
fn start_reaper() {
    REAPER.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(60));
            reap_idle();
        });
    });
}

fn reap_idle() {
    let now = Instant::now();
    let mut idle = Vec::new();
    {
        let servers = SERVERS.lock().unwrap();
        if let Some(map) = servers.as_ref() {
            for (id, server) in map {
                if now.duration_since(server.last_activity) > IDLE_TIMEOUT {
                    idle.push(*id);
                }
            }
        }
    }
    for id in idle {
        stop_server(id, "idle timeout");
    }
}

#[tauri::command]
pub fn lsp_stop(id: u64) -> Result<(), String> {
    stop_server(id, "lsp_stop");
    Ok(())
}

/// Stop every server for a project — the editor calls this when the operator switches projects.
#[tauri::command]
pub fn lsp_stop_project(project: String) -> Result<(), String> {
    let ids: Vec<u64> = {
        let servers = SERVERS.lock().unwrap();
        match servers.as_ref() {
            Some(map) => map
                .iter()
                .filter(|(_, s)| s.project == project)
                .map(|(id, _)| *id)
                .collect(),
            None => Vec::new(),
        }
    };
    for id in ids {
        stop_server(id, "project switch");
    }
    Ok(())
}

/// Stop every live server — the app-exit hook.
pub fn stop_all() {
    let ids: Vec<u64> = {
        let servers = SERVERS.lock().unwrap();
        match servers.as_ref() {
            Some(map) => map.keys().copied().collect(),
            None => Vec::new(),
        }
    };
    for id in ids {
        stop_server(id, "app exit");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_emits_content_length_header_then_body() {
        let framed = frame(b"{\"jsonrpc\":\"2.0\"}");
        let text = String::from_utf8(framed.clone()).unwrap();
        assert!(text.starts_with("Content-Length: 17\r\n\r\n"), "{text}");
        assert!(text.ends_with("{\"jsonrpc\":\"2.0\"}"));
    }

    #[test]
    fn decoder_joins_a_message_split_across_reads() {
        let body = br#"{"id":1,"result":"ok"}"#;
        let framed = frame(body);
        let mut dec = LspDecoder::new();
        let split = framed.len() / 2;
        assert!(dec.push(&framed[..split]).is_empty());
        let out = dec.push(&framed[split..]);
        assert_eq!(out, vec![body.to_vec()]);
    }

    #[test]
    fn decoder_returns_two_messages_from_one_chunk() {
        let a = br#"{"id":1}"#;
        let b = br#"{"id":2,"method":"x"}"#;
        let mut chunk = frame(a);
        chunk.extend_from_slice(&frame(b));
        let out = LspDecoder::new().push(&chunk);
        assert_eq!(out, vec![a.to_vec(), b.to_vec()]);
    }

    #[test]
    fn decoder_accepts_crlf_headers_with_other_fields() {
        // Content-Type first, then Content-Length — both CRLF, as real servers send it.
        let mut chunk = b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: 5\r\n\r\n".to_vec();
        chunk.extend_from_slice(b"hello");
        assert_eq!(LspDecoder::new().push(&chunk), vec![b"hello".to_vec()]);
    }

    #[test]
    fn decoder_accepts_lf_only_headers() {
        let mut chunk = b"Content-Length: 3\n\nfoo".to_vec();
        assert_eq!(LspDecoder::new().push(&chunk), vec![b"foo".to_vec()]);
    }

    #[test]
    fn decoder_holds_a_partial_header_until_more_bytes_arrive() {
        let mut dec = LspDecoder::new();
        assert!(dec.push(b"Content-Length:").is_empty());
        let out = dec.push(b" 4\r\n\r\ntest");
        assert_eq!(out, vec![b"test".to_vec()]);
    }

    #[test]
    fn decoder_is_case_insensitive_on_the_header_name() {
        let chunk = b"content-LENGTH: 2\r\n\r\nok".to_vec();
        assert_eq!(LspDecoder::new().push(&chunk), vec![b"ok".to_vec()]);
    }

    #[test]
    fn server_spec_maps_languages_to_binaries_and_refuses_the_rest() {
        assert_eq!(server_spec("rust").unwrap().bin, "rust-analyzer");
        assert_eq!(server_spec("typescriptreact").unwrap().bin, "typescript-language-server");
        assert_eq!(server_spec("javascript").unwrap().bin, "typescript-language-server");
        assert_eq!(server_spec("python").unwrap().bin, "pyright-langserver");
        assert!(server_spec("markdown").is_err());
        assert!(server_spec("json").is_err());
    }

    #[test]
    fn every_spec_names_an_install_line() {
        for lang in ["rust", "typescript", "javascript", "python"] {
            let spec = server_spec(lang).unwrap();
            assert!(spec.install.starts_with("run: "), "{lang}: {}", spec.install);
        }
    }

    #[cfg(unix)]
    #[test]
    fn probe_rejects_a_rustup_proxy_without_the_component() {
        // A rustup proxy is a real, executable file that prints "error: Unknown binary …" to
        // stderr and exits 1 when its component is absent — the exact case a PATH scan alone
        // could not catch, and the reason lsp_start must prove the binary runs.
        let dir = std::env::temp_dir().join("lsp-probe-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("rust-analyzer");
        std::fs::write(
            &script,
            "#!/bin/sh\necho \"error: Unknown binary 'rust-analyzer' in official toolchain\" >&2\nexit 1\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let err = probe_binary(
            &script,
            "rust-analyzer",
            "run: rustup component add rust-analyzer",
            "rustup proxy without the component",
        )
        .unwrap_err();
        assert!(err.starts_with("not installed: rust-analyzer"), "{err}");
        assert!(err.contains("rustup component add rust-analyzer"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn probe_accepts_a_binary_that_reports_a_version() {
        let dir = std::env::temp_dir().join("lsp-probe-ok");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-server");
        std::fs::write(&script, "#!/bin/sh\necho \"fake-server 1.0\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(probe_binary(&script, "fake-server", "run: install", "broken").is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_root_finds_the_nearest_cargo_manifest() {
        let dir = std::env::temp_dir().join("lsp-ws-root-nearest");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("desktop/src-tauri/src")).unwrap();
        std::fs::write(dir.join("desktop/src-tauri/Cargo.toml"), "[package]\nname = \"desktop\"\n").unwrap();
        std::fs::write(dir.join("desktop/src-tauri/src/lib.rs"), "").unwrap();

        let root = workspace_root(&dir, "rust", "desktop/src-tauri/src/lib.rs");
        assert_eq!(root, dir.join("desktop/src-tauri"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_root_prefers_a_workspace_manifest_higher_up() {
        let dir = std::env::temp_dir().join("lsp-ws-root-workspace");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("crate/src")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[workspace]\nmembers = [\"crate\"]\n").unwrap();
        std::fs::write(dir.join("crate/Cargo.toml"), "[package]\nname = \"crate\"\n").unwrap();
        std::fs::write(dir.join("crate/src/lib.rs"), "").unwrap();

        let root = workspace_root(&dir, "rust", "crate/src/lib.rs");
        assert_eq!(root, dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_root_falls_back_to_the_scope_root_without_any_manifest() {
        let dir = std::env::temp_dir().join("lsp-ws-root-fallback");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(dir.join("scripts/x.sh"), "").unwrap();

        let root = workspace_root(&dir, "rust", "scripts/x.sh");
        assert_eq!(root, dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_root_finds_tsconfig_before_package_json() {
        let dir = std::env::temp_dir().join("lsp-ws-root-ts");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("app")).unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join("app/tsconfig.json"), "{}").unwrap();
        std::fs::write(dir.join("app/main.ts"), "").unwrap();

        let root = workspace_root(&dir, "typescript", "app/main.ts");
        assert_eq!(root, dir.join("app"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_server_survives_without_client_writes() {
        // A server is not torn down on lens unmount (there is no detach kill), so with zero
        // writes it must still be alive well below the 15-minute idle timeout.
        let mut child = Command::new("sleep")
            .arg("60")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sleep");
        let stdin = child.stdin.take().expect("stdin");
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        {
            let mut servers = SERVERS.lock().unwrap();
            servers.get_or_insert_with(HashMap::new).insert(
                id,
                Server {
                    child,
                    stdin,
                    project: "test".into(),
                    workspace_root: "/tmp".into(),
                    language: "rust".into(),
                    last_activity: Instant::now(),
                    initialized: false,
                },
            );
        }
        std::thread::sleep(Duration::from_secs(1));
        assert!(server_alive(id), "server must survive with no client writes");
        assert!(stop_server(id, "test cleanup"));
    }
}

#[cfg(test)]
mod initialized_tests {
    use super::*;

    /// A second `lsp_start` for a live server that has already completed the handshake reports
    /// `initialized: true` — the signal the frontend uses to RESPAWN a fresh process instead of
    /// letting a new client send a fatal second `initialize` (#5857, rust-1.log).
    #[test]
    fn second_start_of_an_initialized_server_reports_initialized() {
        // `cat` as a stand-in server: it never exits and accepts everything on stdin, so
        // lsp_send's real write path runs exactly as it does against rust-analyzer.
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn cat");
        let stdin = child.stdin.take().expect("cat stdin");
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        {
            let mut servers = SERVERS.lock().unwrap();
            servers.get_or_insert_with(HashMap::new).insert(
                id,
                Server {
                    child,
                    stdin,
                    project: "test".into(),
                    workspace_root: "/test".into(),
                    language: "rust".into(),
                    last_activity: Instant::now(),
                    initialized: false,
                },
            );
        }
        WORKSPACES
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(("/test".into(), "rust".into()), id);

        // The handshake's last step crosses the wire: `initialized` flips the flag.
        lsp_send(id, r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#.to_string()).unwrap();
        let initialized = {
            let servers = SERVERS.lock().unwrap();
            servers.as_ref().and_then(|m| m.get(&id)).map(|s| s.initialized)
        };
        assert_eq!(initialized, Some(true));

        // A second start REUSES the live server and reports the flag — it must never claim a
        // fresh server here, or the frontend would re-initialize a live process.
        let file = Path::new("/test").join("x.rs");
        let started =
            reuse_live_server(&("/test".into(), "rust".into()), Path::new("/test"), &file).unwrap();
        assert_eq!(started.id, id);
        assert!(started.initialized);

        stop_server(id, "initialized test end");
    }

    /// A fresh spawn reports `initialized: false` — a new process OWES the handshake its new
    /// client is about to send.
    #[test]
    fn fresh_spawn_reports_not_initialized() {
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn cat");
        let stdin = child.stdin.take().expect("cat stdin");
        SERVERS.lock().unwrap().get_or_insert_with(HashMap::new).insert(
            id,
            Server {
                child,
                stdin,
                project: "test".into(),
                workspace_root: "/test-fresh".into(),
                language: "rust".into(),
                last_activity: Instant::now(),
                initialized: false,
            },
        );
        let scope_root = PathBuf::from("/test-fresh");
        let file = scope_root.join("x.rs");
        let ws = workspace_root(&scope_root, "rust", &file.to_string_lossy());
        WORKSPACES
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert((ws.display().to_string(), "rust".into()), id);
        let started =
            reuse_live_server(&(ws.display().to_string(), "rust".into()), &scope_root, &ws).unwrap();
        assert_eq!(started.id, id);
        assert!(!started.initialized);
        stop_server(id, "fresh test end");
    }
}

/// Append one wire-trace line for a server: direction, method/id tag, first 300 chars. The
/// diagnostic record for the re-initialize investigation (#12752): every JSON-RPC message both
/// ways, one file per server — ~/.agent-bus/lsp/<language>-<id>.trace.
fn trace_wire(id: u64, language: &str, direction: &str, text: &str) {
    let (kind, tag) = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => {
            let method = v.get("method").and_then(Value::as_str).unwrap_or("?").to_string();
            match v.get("id") {
                Some(i) => ("req".to_string(), format!("{method}#{i}")),
                None => ("notif".to_string(), method),
            }
        }
        Err(_) => ("raw".to_string(), String::new()),
    };
    let first: String = text.chars().take(300).collect();
    let ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let dir = crate::desktop_bus_dir().join("lsp");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{language}-{id}.trace")))
    {
        let _ = writeln!(f, "{ms} {direction} {kind} {tag} {first}");
    }
}
