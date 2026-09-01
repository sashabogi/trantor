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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

struct Server {
    child: Child,
    stdin: ChildStdin,
}

static SERVERS: Mutex<Option<HashMap<u64, Server>>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

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
fn find_binary(name: &str, install: &str) -> Result<PathBuf, String> {
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

    // Stderr drain: capture the FIRST line as the exit reason, then keep draining so a chatty
    // server cannot fill the pipe buffer and block on its next write.
    if let Some(stderr) = stderr {
        let first = first_stderr.clone();
        std::thread::spawn(move || {
            let mut r = BufReader::new(stderr);
            let mut line = String::new();
            while r.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                let mut guard = first.lock().unwrap();
                if guard.is_none() {
                    *guard = Some(line.trim().to_string());
                }
                line.clear();
            }
        });
    }

    Ok((child, stdin))
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn lsp_start(
    app: tauri::AppHandle,
    project: String,
    scope: Option<String>,
    language: String,
) -> Result<u64, String> {
    let root = source_root(&project, scope.as_deref())?;
    let spec = server_spec(&language)?;
    let path = find_binary(spec.bin, spec.install)?;
    probe_binary(&path, spec.bin, spec.install, spec.broken_proxy)?;
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (child, stdin) = spawn_server(app, id, &path, spec.args, &root)?;
    let mut servers = SERVERS.lock().unwrap();
    servers.get_or_insert_with(HashMap::new).insert(id, Server { child, stdin });
    Ok(id)
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
    server
        .stdin
        .write_all(&frame(message.as_bytes()))
        .and_then(|_| server.stdin.flush())
        .map_err(|e| format!("write to language server {id} failed: {e}"))
}

#[tauri::command]
pub fn lsp_stop(id: u64) -> Result<(), String> {
    let mut servers = SERVERS.lock().unwrap();
    let Some(map) = servers.as_mut() else {
        return Ok(());
    };
    if let Some(mut server) = map.remove(&id) {
        let _ = server.child.kill();
    }
    Ok(())
}

/// Stop every live server — the app-exit hook and the belt to the lens-unmount suspenders.
pub fn stop_all() {
    let mut servers = SERVERS.lock().unwrap();
    if let Some(map) = servers.as_mut() {
        for (_, mut server) in map.drain() {
            let _ = server.child.kill();
        }
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
}
