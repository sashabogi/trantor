//! The headless definition of done for #5857's language servers: drive the SAME lsp code path —
//! `workspace_root` + `frame`/`LspDecoder` — against a real rust-analyzer, end to end
//! (initialize → didOpen → indexing done → completion), and assert `std::` completes to
//! `collections` and `io`. No screenshot. `#[ignore]`d so `cargo test` stays green without
//! rust-analyzer; run with `cargo test -- --ignored lsp_completion`.

use std::io::{BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use desktop_lib::lsp::{find_binary, frame, workspace_root, LspDecoder};

fn send(stdin: &mut impl Write, msg: &serde_json::Value) {
    let body = serde_json::to_vec(msg).expect("serialize");
    stdin.write_all(&frame(&body)).expect("frame write");
    stdin.flush().expect("flush");
}

#[test]
#[ignore = "needs rust-analyzer on PATH; run with: cargo test -- --ignored lsp_completion"]
fn completion_returns_collections_and_io() {
    let bin = match find_binary("rust-analyzer", "run: rustup component add rust-analyzer") {
        Ok(b) => b,
        Err(e) => {
            eprintln!("SKIP: {e}");
            return;
        }
    };

    // The scope root is the repo checkout (this test runs inside a seat worktree, so it is the
    // worktree root); the open file is desktop/src-tauri/src/lib.rs relative to it.
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")); // desktop/src-tauri
    let scope_root = manifest
        .parent()
        .and_then(|p| p.parent())
        .expect("repo root")
        .to_path_buf();

    let workspace = workspace_root(&scope_root, "rust", "desktop/src-tauri/src/lib.rs");
    assert_eq!(
        workspace, manifest,
        "workspace root must be the crate dir, got {}",
        workspace.display()
    );
    eprintln!("workspace root: {}", workspace.display());

    let root_uri = format!("file://{}", workspace.display());
    let file_uri = format!("file://{}/src/lib.rs", workspace.display());

    let mut child = Command::new(&bin)
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rust-analyzer");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");

    // Capture the server's stderr so a dead server has its reason printed, not lost.
    let server_err: std::sync::Arc<std::sync::Mutex<Vec<u8>>> = Default::default();
    let err_cap = server_err.clone();
    std::thread::spawn(move || {
        let mut r = BufReader::new(stderr);
        let mut buf = [0u8; 4096];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => err_cap.lock().unwrap().extend_from_slice(&buf[..n]),
            }
        }
    });

    let started = Instant::now();

    send(&mut stdin, &serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": "trantor" }],
            "capabilities": { "window": { "workDoneProgress": true } }
        }
    }));
    send(&mut stdin, &serde_json::json!({
        "jsonrpc": "2.0", "method": "initialized", "params": {}
    }));

    // didOpen the real lib.rs with a `std::` probe appended on its own line.
    let original = std::fs::read_to_string(workspace.join("src/lib.rs")).expect("read lib.rs");
    let text = format!("{original}\n\nfn __lsp_drill() {{\n    std::\n}}\n");
    let line = text.split('\n').position(|l| l == "    std::").expect("probe line") as u32;
    let character = "    std::".len() as u32;
    send(&mut stdin, &serde_json::json!({
        "jsonrpc": "2.0", "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": file_uri, "languageId": "rust", "version": 1, "text": text
            }
        }
    }));

    // Reader thread: framed stdout → JSON values on a channel.
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    std::thread::spawn(move || {
        let mut decoder = LspDecoder::new();
        let mut reader = BufReader::new(stdout);
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for body in decoder.push(&buf[..n]) {
                        let text = String::from_utf8_lossy(&body).to_string();
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                            let _ = tx.send(v);
                        }
                    }
                }
            }
        }
    });

    let cap = started + Duration::from_secs(120);
    let mut indexing_done = false;
    let mut completion_sent = false;
    let mut labels: Vec<String> = Vec::new();

    while Instant::now() < cap {
        let msg = match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(m) => m,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        // A REQUEST the client must answer (create-progress, diagnostic refresh, …): answer it so
        // the server does not wait on us.
        if msg["method"].as_str().is_some() && !msg["id"].is_null() {
            let id = msg["id"].clone();
            send(&mut stdin, &serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null }));
            continue;
        }

        // Indexing progress: rust-analyzer 1.94 has NO "Indexing" token — the phases are
        // Fetching → Building CrateGraph → Roots Scanned → Loading proc-macros → cachePriming,
        // and cachePriming's `end` is the "analysis is primed and ready" signal. Match that (and
        // keep /index/i for older rust-analyzer that did name an Indexing phase).
        if msg["method"].as_str() == Some("$/progress") {
            let kind = msg["params"]["value"]["kind"].as_str().unwrap_or("");
            let token = msg["params"]["token"].to_string();
            if kind == "end" {
                let lower = token.to_lowercase();
                if lower.contains("priming") || lower.contains("index") {
                    indexing_done = true;
                    eprintln!("analysis ready at {:?} (token {token})", started.elapsed());
                }
            }
        }

        // Once indexed, ask for completions at `std::`.
        if indexing_done && !completion_sent {
            completion_sent = true;
            send(&mut stdin, &serde_json::json!({
                "jsonrpc": "2.0", "id": 2, "method": "textDocument/completion",
                "params": {
                    "textDocument": { "uri": file_uri },
                    "position": { "line": line, "character": character }
                }
            }));
        }

        // The completion response: result is a CompletionList ({ items: [...] }) from rust-analyzer,
        // or a bare array from older servers.
        if msg["id"].as_i64() == Some(2) {
            let items = msg["result"]["items"]
                .as_array()
                .or_else(|| msg["result"].as_array());
            if let Some(items) = items {
                for item in items {
                    if let Some(label) = item["label"].as_str() {
                        labels.push(label.to_string());
                    }
                }
            }
            break;
        }
    }

    let _ = child.kill();
    eprintln!(
        "elapsed: {:?}, completion items: {}",
        started.elapsed(),
        labels.len()
    );
    eprintln!(
        "server stderr: {}",
        String::from_utf8_lossy(&server_err.lock().unwrap())
    );

    let joined = labels.join(" ");
    assert!(!labels.is_empty(), "no completion items returned");
    assert!(
        labels.iter().any(|l| l.contains("collections")),
        "missing 'collections'; got: {joined}"
    );
    assert!(
        labels.iter().any(|l| l.contains("io")),
        "missing 'io'; got: {joined}"
    );
    eprintln!("completion OK: {joined}");
}
