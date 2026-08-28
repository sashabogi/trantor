pub mod identity;
mod terminal;

use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// The identity this app signs as. Configurable so a second machine or a test can use another key.
fn owner_identity() -> String {
    std::env::var("TRANTOR_IDENTITY").unwrap_or_else(|_| "sasha@mac".to_string())
}

#[tauri::command]
fn sign_request(
    method: String,
    path: String,
    body: Option<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    identity::sign(&owner_identity(), &method, &path, body.as_deref())
}

/// The name this app SIGNS as. The hub rejects any /send whose `from` does not match the signer,
/// so the web side has to know it rather than assume "sasha@mac" — TRANTOR_IDENTITY can change it,
/// and a hardcoded copy would 403 the moment it did.
#[tauri::command]
fn identity_name() -> String {
    owner_identity()
}

#[tauri::command]
fn hub_for_project(project: String) -> String {
    identity::hub_for_project(&project)
}

#[tauri::command]
fn known_projects() -> Vec<String> {
    identity::known_projects()
}

#[derive(serde::Serialize)]
pub struct HubResponse {
    pub status: u16,
    pub body: String,
}

#[tauri::command]
async fn hub_request(
    base: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<HubResponse, String> {
    let (status, body) = identity::request(&owner_identity(), &base, &method, &path, body).await?;
    Ok(HubResponse { status, body })
}

/// Streams already running, keyed by hub base URL.
///
/// Without this, every subscriber spawns its OWN connection: BOARD and FEED both subscribe, so each
/// event arrived twice and was rendered twice. One stream per hub, fanned out to all listeners by
/// Tauri's event bus — which is what the event bus is for.
static STREAMS: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

#[tauri::command]
async fn start_stream(app: tauri::AppHandle, base: String) {
    use tauri::Emitter;
    {
        let mut g = STREAMS.lock().unwrap();
        let set = g.get_or_insert_with(std::collections::HashSet::new);
        if !set.insert(base.clone()) {
            return;
        } // already streaming this hub
    }
    tauri::async_runtime::spawn(async move {
        identity::stream(&owner_identity(), &base, move |data| {
            let _ = app.emit("hub-event", data);
        })
        .await;
    });
}

/// The PATH a terminal would have. A Finder-launched app inherits only /usr/bin:/bin:/usr/sbin:/sbin,
/// so every brew/npm/cargo-installed CLI is invisible to anything we spawn. Fixing `node` alone was
/// not enough: the doctor probes each seat with `command -v`, so it reported a machine with no crew
/// CLIs at all while the same command in a terminal found six.
///
/// Ask the user's login shell first (it knows about the install dirs we can't guess, e.g. kimi's
/// ~/.kimi-code/bin), then union the usual roots, then whatever we inherited. Order is preserved and
/// duplicates dropped, so the shell's own precedence wins.
fn terminal_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        for p in raw.split(':') {
            let p = p.trim();
            if !p.is_empty() && !parts.iter().any(|q| q == p) {
                parts.push(p.to_string());
            }
        }
    };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // -lic so rc files that set PATH are read. Take the LAST line: a noisy profile may print a
    // banner first, and a banner silently swallowing the PATH is exactly this bug again.
    if let Ok(out) = std::process::Command::new(&shell)
        .arg("-lic")
        .arg("printf '%s' \"$PATH\"")
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = text.lines().filter(|l| l.contains('/')).next_back() {
                push(line);
            }
        }
    }
    for p in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        &format!("{home}/.local/bin"),
        &format!("{home}/.bun/bin"),
        &format!("{home}/.cargo/bin"),
        &format!("{home}/.volta/bin"),
    ] {
        push(p);
    }
    push(&std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_string()));
    parts.join(":")
}

/// Run the EXISTING doctor engine and hand back its JSON. Deliberately shelling out rather than
/// re-implementing detection in Rust: two detectors would drift, and then the CLI and the app would
/// disagree about whether a seat is wired with no way to tell which is right.
#[tauri::command]
async fn doctor() -> Result<String, String> {
    let root = std::env::var("TRANTOR_ROOT").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/development/trantor")
    });
    // Finder-launched apps get the bare system PATH (no /opt/homebrew/bin), so "node" alone
    // fails outside a terminal. Probe the usual install locations before falling back to PATH.
    let node = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    .iter()
    .find(|p| std::path::Path::new(p).exists())
    .map(|p| p.to_string())
    .unwrap_or_else(|| "node".to_string());
    let out = tokio::process::Command::new(node)
        .arg(format!("{root}/bin/doctor.mjs"))
        .arg("--json")
        .env("PATH", terminal_path())
        .output()
        .await
        .map_err(|e| format!("doctor: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(text)
}

/// Where a project's code lives on THIS machine. Convention first (~/development/<project>),
/// TRANTOR_DEV_ROOT to relocate. Returns None when the repo simply isn't here — a card can
/// reference code on another operator's machine and the UI degrades to text.
fn project_dir(project: &str) -> Option<std::path::PathBuf> {
    let root = std::env::var("TRANTOR_DEV_ROOT")
        .unwrap_or_else(|_| format!("{}/development", std::env::var("HOME").unwrap_or_default()));
    let dir = std::path::Path::new(&root).join(project);
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// One entry in the project's file tree. `status` carries git's porcelain code for the file, which
/// is the whole point of showing a tree here: a legacy developer wants to watch WHICH files the
/// agents are touching, not just that a repo exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct FileEntry {
    name: String,
    /// path relative to the project root, so the front end can ask for a subtree by the same key
    path: String,
    dir: bool,
    /// "" when unchanged, else git's two-letter porcelain code trimmed ("M", "A", "??", "D")
    status: String,
}

/// Directories that are output or vendored. Walking them is how a file tree turns into a hang: a
/// single `node_modules` dwarfs the source it sits next to, and none of it is work an agent did.
const TREE_SKIP: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    "__pycache__",
    ".venv",
];

/// git status for the whole repo, as a map of relative path -> code. Read ONCE per tree request
/// rather than per entry: `git status` on a large repo is the expensive part, and asking per file
/// would make an O(n) tree into O(n) subprocesses.
fn git_status_map(dir: &Path) -> std::collections::HashMap<String, String> {
    let map = std::collections::HashMap::new();
    let out = match std::process::Command::new("git")
        .args(["status", "--porcelain=v1", "--untracked-files=normal"])
        .current_dir(dir)
        .output()
    {
        Ok(o) => o,
        Err(_) => return map,
    };
    parse_status_porcelain(&String::from_utf8_lossy(&out.stdout))
}

fn parse_status_porcelain(raw: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in raw.lines() {
        if line.len() < 4 {
            continue;
        }
        let code = line[..2].trim().to_string();
        let path = line[3..].trim();
        // a rename reads "old -> new"; the new name is the one on disk
        let path = path.rsplit(" -> ").next().unwrap_or(path).trim_matches('"');
        // Mark every ancestor too, or a closed folder gives no hint that something inside it moved.
        let mut acc = String::new();
        for part in path.split('/') {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            map.entry(acc.clone()).or_insert_with(|| code.clone());
        }
    }
    map
}

/// The tree and the viewer read from ONE of two places, and leaving that implicit is why "which
/// files is the crew touching" had two different answers at once: the project checkout, or a
/// seat's worktree. Callers name which they mean.
fn source_root(project: &str, seat: Option<&str>) -> Result<std::path::PathBuf, String> {
    if project.contains("..") || project.contains('/') {
        return Err("project is invalid".into());
    }
    match seat {
        None => project_dir(project).ok_or_else(|| format!("no local checkout for {project}")),
        Some(agent) => {
            if agent.contains("..") || agent.contains('/') {
                return Err("seat is invalid".into());
            }
            let wt = desktop_bus_dir()
                .join("worktrees")
                .join(project)
                .join(agent);
            if wt.is_dir() {
                Ok(wt)
            } else {
                Err(format!("{agent} has no worktree yet"))
            }
        }
    }
}

/// A file's text, for the viewer. Guarded on two axes because a file tree will eventually be
/// pointed at something that is neither small nor text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct FileBody {
    text: String,
    /// set when the file was cut at the cap, so the UI can say so instead of implying it is whole
    truncated: bool,
    bytes: u64,
}

const FILE_VIEW_CAP: u64 = 512 * 1024;

#[tauri::command]
fn read_file(project: String, path: String, seat: Option<String>) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    if path.contains("..") {
        return Err("path escapes the project".into());
    }
    let full = root.join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("cannot read {path}: {e}"))?;
    if meta.is_dir() {
        return Err("that is a directory".into());
    }
    let bytes = meta.len();
    let raw = std::fs::read(&full).map_err(|e| format!("cannot read {path}: {e}"))?;
    // A NUL in the head is the same cheap binary test `grep` uses; rendering a binary as text
    // produces a screen of noise the operator then has to diagnose.
    if raw.iter().take(8192).any(|b| *b == 0) {
        return Err("binary file".into());
    }
    let truncated = bytes > FILE_VIEW_CAP;
    let slice = if truncated {
        &raw[..FILE_VIEW_CAP as usize]
    } else {
        &raw[..]
    };
    let body = FileBody {
        text: String::from_utf8_lossy(slice).to_string(),
        truncated,
        bytes,
    };
    serde_json::to_string(&body).map_err(|e| e.to_string())
}

/// This file as HEAD has it. A real side-by-side diff needs the two DOCUMENTS, not a patch: a
/// unified patch is a description of a change, and rendering it as text is what made the diff view
/// a wall of plus signs rather than something you can read code in.
#[tauri::command]
fn read_file_at_head(
    project: String,
    path: String,
    seat: Option<String>,
) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    if path.contains("..") {
        return Err("path escapes the project".into());
    }
    let out = std::process::Command::new("git")
        .args(["show", &format!("HEAD:{path}")])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git show failed: {e}"))?;
    // A file git has never seen has no HEAD version, and that is not an error: it means the whole
    // file is new, so the base side of the diff is simply empty.
    if !out.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// A single file's diff against its base. The viewer needs this so "read the code, then decide if
/// you like it" happens in ONE place — sending the operator to another lens to see whether the
/// file they are looking at changed is the kind of dead end this tree already had once.
#[tauri::command]
fn file_diff(project: String, path: String, seat: Option<String>) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    if path.contains("..") {
        return Err("path escapes the project".into());
    }
    // HEAD, not the seat's branch point: the question the viewer answers is "what is different
    // about this file right now", which is what an uncommitted edit means.
    let out = std::process::Command::new("git")
        .args(["diff", "HEAD", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git diff failed: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if !text.trim().is_empty() {
        return Ok(text);
    }
    // Untracked: git diff says nothing about a file it has never seen, but the operator still
    // wants to read it as "all new" rather than be told there is no diff.
    let untracked = std::process::Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git ls-files failed: {e}"))?;
    if String::from_utf8_lossy(&untracked.stdout).trim().is_empty() {
        return Ok(String::new());
    }
    let no_index = std::process::Command::new("git")
        .args(["diff", "--no-index", "--", "/dev/null", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git diff failed: {e}"))?;
    Ok(String::from_utf8_lossy(&no_index.stdout).to_string())
}

/// Paths matching a query, for the composer's @-reference menu.
///
/// A flat search rather than the lazy tree: autocomplete needs to reach a file three folders deep
/// from four typed characters, which a per-directory reader cannot do. Bounded on both sides —
/// depth and result count — because this runs on every keystroke.
#[tauri::command]
fn search_files(project: String, query: String, seat: Option<String>) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    let q = query.to_lowercase();
    let mut hits: Vec<String> = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, String, usize)> = vec![(root, String::new(), 0)];
    while let Some((dir, rel, depth)) = stack.pop() {
        if depth > 8 || hits.len() >= 40 {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir && TREE_SKIP.contains(&name.as_str()) {
                continue;
            }
            let path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if is_dir {
                stack.push((entry.path(), path, depth + 1));
            } else if q.is_empty() || path.to_lowercase().contains(&q) {
                hits.push(path);
                if hits.len() >= 40 {
                    break;
                }
            }
        }
    }
    // Shallower paths first: a query matching both README.md and a file buried six deep almost
    // always means the shallow one.
    hits.sort_by_key(|p| (p.matches('/').count(), p.len()));
    hits.truncate(20);
    serde_json::to_string(&hits).map_err(|e| e.to_string())
}

/// One level of the project's tree. Lazy by design: the front end asks for a subtree when a folder
/// opens, so a repo with thousands of files costs only what is actually expanded.
#[tauri::command]
fn project_files(
    project: String,
    sub: Option<String>,
    seat: Option<String>,
) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    let rel = sub.unwrap_or_default();
    // Refuse to escape the project root: `sub` comes from the front end and a "../" would walk out.
    if rel.contains("..") {
        return Err("path escapes the project".into());
    }
    let dir = if rel.is_empty() {
        root.clone()
    } else {
        root.join(&rel)
    };
    let status = git_status_map(&root);
    let mut out: Vec<FileEntry> = Vec::new();
    for entry in
        std::fs::read_dir(&dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".github" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && TREE_SKIP.contains(&name.as_str()) {
            continue;
        }
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let st = status.get(&path).cloned().unwrap_or_default();
        out.push(FileEntry {
            name,
            path,
            dir: is_dir,
            status: st,
        });
    }
    // folders first, then alphabetical — the order every file explorer uses
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// The orchestrator's conversation, as chat.
///
/// The session runs in a terminal, but a terminal is a bad place to READ a conversation: escape
/// codes, reflowed wrapping, and no structure to render against. Claude writes every turn to a
/// JSONL transcript, and `trantor open` now chooses the session id, so that file is addressable
/// rather than guessed at. This reads it.
///
/// `after` is a line offset, not a timestamp: the transcript is append-only, so the count of lines
/// already seen is the cheapest correct cursor and survives a restart.
/// The session id `trantor open` chose for this project. Recorded rather than discovered, which is
/// the only reason the transcript is addressable at all.
fn orch_session_id(project: &str) -> Option<String> {
    let p = desktop_bus_dir().join("orch-sessions.txt");
    let raw = std::fs::read_to_string(p).ok()?;
    for line in raw.lines() {
        let mut it = line.split('\t');
        if it.next()? == project {
            let sid = it.next()?.trim();
            if !sid.is_empty() {
                return Some(sid.to_string());
            }
        }
    }
    None
}

/// One renderable piece of a turn. Decoded from what a Claude transcript ACTUALLY contains, which
/// was checked against a real file rather than assumed:
///
///   assistant::text · assistant::thinking · assistant::tool_use
///   user::text · user::tool_result · user::image
///
/// Note what is NOT there: permission prompts and the agent's questions live in the TUI and never
/// reach the transcript, so this cannot render approval cards. Building one would mean inventing a
/// signal we do not have.
#[derive(Debug, Clone, Serialize)]
struct ChatBlock {
    /// "text" | "thinking" | "tool" | "image"
    kind: String,
    text: String,
    /// tool blocks only
    tool: Option<String>,
    tool_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ChatTurn {
    role: String,
    blocks: Vec<ChatBlock>,
}

/// A tool's outcome, keyed by the call it answers. Returned SEPARATELY from the turns because a
/// result usually arrives in a later batch than the call that produced it: the front end holds the
/// rendered turns and fills each card in when its answer shows up, rather than the reader having to
/// re-parse the whole file to pair them.
/// What the agent IS, taken from the transcript rather than asserted. Every field here is what
/// Orca would call `reported`: the session itself wrote it, so it is evidence. Nothing is guessed,
/// and an empty field renders as absent rather than as a default that looks like knowledge.
#[derive(Debug, Clone, Default, Serialize)]
struct ChatMeta {
    model: String,
    version: String,
    branch: String,
    context: ChatContext,
}

#[derive(Debug, Clone, Default, Serialize)]
struct ChatContext {
    tokens: Option<u64>,
    window: u64,
    frac: Option<f64>,
}

/// Text the HARNESS injected into the conversation, wearing the user's role.
///
/// Hook output, interruption notices and reminders all arrive as ordinary user turns, so without
/// this a 6,849-character stop-hook dump renders as though the operator typed it — which is exactly
/// what it did before this list existed. A closed list of known prefixes rather than a heuristic on
/// length: a long message from a person is still a message from a person.
fn is_harness_injection(t: &str) -> bool {
    const MARKERS: &[&str] = &[
        "Stop hook feedback:",
        "[Request interrupted",
        "PostToolUse:",
        "PreToolUse:",
        "SessionStart:",
        "Caveat: The messages below",
        "<system-reminder",
        "<command-name>",
        "This session is being continued from a previous conversation",
    ];
    let t = t.trim_start();
    t.starts_with('<') || MARKERS.iter().any(|m| t.starts_with(m)) || t.contains("system-reminder")
}

fn chat_context(tokens: Option<u64>, window: u64) -> ChatContext {
    ChatContext {
        tokens,
        window,
        frac: tokens.and_then(|t| {
            if window > 0 {
                Some(t as f64 / window as f64)
            } else {
                None
            }
        }),
    }
}

fn read_context_window() -> u64 {
    let path = desktop_bus_dir().join("config.json");
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return 0,
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v.get("contextWindow").and_then(|w| w.as_u64()).unwrap_or(0),
        Err(_) => 0,
    }
}

fn assistant_usage_tokens(v: &serde_json::Value) -> Option<u64> {
    let usage = v.get("message")?.get("usage")?;
    let mut seen = false;
    let total = [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .filter_map(|k| {
        let n = usage.get(*k).and_then(|v| v.as_u64());
        if n.is_some() {
            seen = true;
        }
        n
    })
    .sum();
    if seen {
        Some(total)
    } else {
        None
    }
}

fn text_content(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|b| match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => b.get("text").and_then(|t| t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn bookkeeping_divider_text(v: &serde_json::Value, content: &serde_json::Value) -> Option<String> {
    if v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
        let text = text_content(content);
        return if text.trim().is_empty() {
            None
        } else {
            Some(text)
        };
    }
    let serde_json::Value::String(s) = content else {
        return None;
    };
    if is_slash_command(s)
        || s.starts_with("<local-command-caveat>")
        || s.starts_with("<local-command-stdout>")
    {
        Some(s.clone())
    } else {
        None
    }
}

/// A slash-COMMAND record, not merely text starting with "/". A command's first token is one
/// bare name — "/compact", "/model opus", "/trantor:handoff" — while an absolute path has more
/// slashes inside its first token. The distinction is load-bearing: the first live file-drop
/// ("/Users/…/shot.jpg  here is the screen shot") matched a bare starts_with('/'), rendered as
/// bookkeeping, vanished from user turns, and the delivery receipt declared a delivered message
/// lost (2026-08-28).
fn is_slash_command(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('/') else {
        return false;
    };
    let token = rest.split_whitespace().next().unwrap_or("");
    !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
}

fn merge_chat_meta(current: &mut ChatMeta, next: ChatMeta) {
    if !next.model.is_empty() {
        current.model = next.model;
    }
    if !next.version.is_empty() {
        current.version = next.version;
    }
    if !next.branch.is_empty() {
        current.branch = next.branch;
    }
    current.context.window = next.context.window;
    if next.context.tokens.is_some() {
        current.context = next.context;
    } else {
        current.context.frac = current.context.tokens.and_then(|t| {
            if current.context.window > 0 {
                Some(t as f64 / current.context.window as f64)
            } else {
                None
            }
        });
    }
}

#[derive(Debug, Clone, Serialize)]
struct ChatToolResult {
    tool_id: String,
    ok: bool,
    preview: String,
}

#[derive(Debug, Clone, Serialize)]
struct ChatSnapshot {
    turns: Vec<ChatTurn>,
    results: Vec<ChatToolResult>,
    total: usize,
    meta: ChatMeta,
}

#[derive(Debug, Clone, Serialize)]
struct ChatRowsPayload {
    project: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    after: usize,
    total: usize,
    turns: Vec<ChatTurn>,
    results: Vec<ChatToolResult>,
    meta: ChatMeta,
}

#[derive(Debug, Clone, Serialize)]
struct ChatSessionChangedPayload {
    project: String,
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Debug, Default)]
struct TranscriptTail {
    byte_offset: u64,
    line_offset: usize,
    pending: String,
}

impl TranscriptTail {
    fn reset(&mut self) {
        self.byte_offset = 0;
        self.line_offset = 0;
        self.pending.clear();
    }

    fn seed_from_raw(&mut self, raw: &str) {
        self.byte_offset = raw.len() as u64;
        let (complete, pending) = complete_line_count(raw);
        self.line_offset = complete;
        self.pending = pending;
    }

    fn push_chunk(&mut self, chunk: &str) -> (usize, Vec<String>, usize) {
        let after = self.line_offset;
        if chunk.is_empty() {
            return (after, Vec::new(), self.line_offset);
        }
        let mut text = String::new();
        if !self.pending.is_empty() {
            text.push_str(&self.pending);
            self.pending.clear();
        }
        text.push_str(chunk);

        let complete = text.ends_with('\n');
        let mut parts: Vec<&str> = text.split('\n').collect();
        if !complete {
            self.pending = parts
                .pop()
                .unwrap_or_default()
                .trim_end_matches('\r')
                .to_string();
        } else if parts.last() == Some(&"") {
            parts.pop();
        }
        let lines = parts
            .into_iter()
            .map(|s| s.trim_end_matches('\r').to_string())
            .collect::<Vec<_>>();
        self.line_offset += lines.len();
        (after, lines, self.line_offset)
    }

    fn read_new_lines(&mut self, path: &Path) -> std::io::Result<(usize, Vec<String>, usize)> {
        let mut f = std::fs::File::open(path)?;
        let len = f.metadata()?.len();
        if len < self.byte_offset {
            self.reset();
        }
        f.seek(SeekFrom::Start(self.byte_offset))?;
        let mut chunk = String::new();
        f.read_to_string(&mut chunk)?;
        self.byte_offset = f.stream_position()?;
        Ok(self.push_chunk(&chunk))
    }
}

fn complete_line_count(raw: &str) -> (usize, String) {
    if raw.is_empty() || raw.ends_with('\n') {
        return (raw.lines().count(), String::new());
    }
    let mut parts: Vec<&str> = raw.split('\n').collect();
    let pending = parts
        .pop()
        .unwrap_or_default()
        .trim_end_matches('\r')
        .to_string();
    (parts.len(), pending)
}

fn complete_lines(raw: &str) -> Vec<&str> {
    if raw.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<&str> = raw.split('\n').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    } else {
        parts.pop();
    }
    parts
        .into_iter()
        .map(|s| s.trim_end_matches('\r'))
        .collect()
}

fn orchestrator_transcript_path(project: &str, sid: &str) -> Result<PathBuf, String> {
    let dir = project_dir(project).ok_or_else(|| format!("no local checkout for {project}"))?;
    let slug: String = dir
        .to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    let home = std::env::var("HOME").unwrap_or_default();
    Ok(std::path::Path::new(&home)
        .join(".claude/projects")
        .join(&slug)
        .join(format!("{sid}.jsonl")))
}

/// Tool inputs are objects of wildly different shapes. The one-line summary is the field a person
/// would recognise, and everything else is noise in a chat.
fn tool_summary(name: &str, input: &serde_json::Value) -> String {
    let pick = |k: &str| {
        input
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let s = match name {
        "Bash" => pick("command"),
        "Read" | "Write" | "Edit" | "NotebookEdit" => pick("file_path"),
        "Glob" | "Grep" => {
            let p = pick("pattern");
            let path = pick("path");
            if path.is_empty() {
                p
            } else {
                format!("{p}  in {path}")
            }
        }
        "WebFetch" => pick("url"),
        "Task" | "Agent" => pick("description"),
        _ => {
            // An unknown tool gets its first string field rather than a guess at which key matters.
            input
                .as_object()
                .and_then(|o| o.values().find_map(|v| v.as_str()))
                .unwrap_or("")
                .to_string()
        }
    };
    let s = s.replace('\n', " ");
    if s.chars().count() > 160 {
        s.chars().take(160).collect::<String>() + "…"
    } else {
        s
    }
}

fn preview_of(v: &serde_json::Value) -> String {
    let raw = match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(a) => a
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    let raw = raw.trim();
    if raw.chars().count() > 2000 {
        raw.chars().take(2000).collect::<String>() + "\n…"
    } else {
        raw.to_string()
    }
}

fn decode_chat_lines<I, S>(lines: I, total: usize) -> ChatSnapshot
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    decode_chat_lines_with_context_window(lines, total, read_context_window())
}

fn decode_chat_lines_with_context_window<I, S>(
    lines: I,
    total: usize,
    context_window: u64,
) -> ChatSnapshot
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut turns: Vec<ChatTurn> = Vec::new();
    let mut results: Vec<ChatToolResult> = Vec::new();
    let mut meta = ChatMeta {
        context: chat_context(None, context_window),
        ..ChatMeta::default()
    };

    for line in lines {
        let v: serde_json::Value = match serde_json::from_str(line.as_ref()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let role = match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            // `system` entries are hook summaries and harness notices addressed to the machinery.
            _ => continue,
        };
        // Identity comes from the LAST assistant entry seen, so a model switch mid-session shows
        // the model that is actually answering rather than the one that started.
        if role == "assistant" {
            if let Some(m) = v
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
            {
                meta.model = m.to_string();
            }
            if let Some(tokens) = assistant_usage_tokens(&v) {
                meta.context = chat_context(Some(tokens), context_window);
            }
        }
        if let Some(x) = v.get("version").and_then(|x| x.as_str()) {
            meta.version = x.to_string();
        }
        if let Some(x) = v.get("gitBranch").and_then(|x| x.as_str()) {
            meta.branch = x.to_string();
        }

        let content = match v.get("message").and_then(|m| m.get("content")) {
            Some(c) => c,
            None => continue,
        };
        if role == "user" {
            if let Some(text) = bookkeeping_divider_text(&v, content) {
                turns.push(ChatTurn {
                    role: "system".into(),
                    blocks: vec![ChatBlock {
                        kind: "divider".into(),
                        text,
                        tool: None,
                        tool_id: None,
                    }],
                });
                continue;
            }
        }
        let mut blocks: Vec<ChatBlock> = Vec::new();
        match content {
            // A typed message is a plain string — and so is every hook injection, which is why
            // this branch has to filter exactly like the array branch does.
            serde_json::Value::String(s) if !s.trim().is_empty() && !is_harness_injection(s) => {
                blocks.push(ChatBlock {
                    kind: "text".into(),
                    text: s.trim().to_string(),
                    tool: None,
                    tool_id: None,
                })
            }
            serde_json::Value::Array(items) => {
                for b in items {
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            let t = b.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
                            // Injected context is addressed to the model, not the reader, and it
                            // dwarfs what the person actually typed.
                            if t.is_empty() || is_harness_injection(t) {
                                continue;
                            }
                            blocks.push(ChatBlock {
                                kind: "text".into(),
                                text: t.to_string(),
                                tool: None,
                                tool_id: None,
                            });
                        }
                        Some("thinking") => {
                            let t = b
                                .get("thinking")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .trim();
                            if t.is_empty() {
                                continue;
                            }
                            blocks.push(ChatBlock {
                                kind: "thinking".into(),
                                text: t.to_string(),
                                tool: None,
                                tool_id: None,
                            });
                        }
                        Some("tool_use") => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            let empty = serde_json::Value::Null;
                            let input = b.get("input").unwrap_or(&empty);
                            blocks.push(ChatBlock {
                                kind: "tool".into(),
                                text: tool_summary(name, input),
                                tool: Some(name.to_string()),
                                tool_id: b.get("id").and_then(|i| i.as_str()).map(String::from),
                            });
                        }
                        Some("tool_result") => {
                            if let Some(id) = b.get("tool_use_id").and_then(|i| i.as_str()) {
                                let empty = serde_json::Value::Null;
                                results.push(ChatToolResult {
                                    tool_id: id.to_string(),
                                    ok: !b
                                        .get("is_error")
                                        .and_then(|e| e.as_bool())
                                        .unwrap_or(false),
                                    preview: preview_of(b.get("content").unwrap_or(&empty)),
                                });
                            }
                        }
                        Some("image") => blocks.push(ChatBlock {
                            kind: "image".into(),
                            text: "image".into(),
                            tool: None,
                            tool_id: None,
                        }),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        if blocks.is_empty() {
            continue;
        }
        turns.push(ChatTurn {
            role: role.to_string(),
            blocks,
        });
    }
    ChatSnapshot {
        turns,
        results,
        total,
        meta,
    }
}

fn read_chat_snapshot(project: &str, after: usize) -> Result<ChatSnapshot, String> {
    let sid = orch_session_id(project)
        .ok_or_else(|| "no orchestrator session for this project yet".to_string())?;
    let path = orchestrator_transcript_path(project, &sid)?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => {
            return Ok(ChatSnapshot {
                turns: Vec::new(),
                results: Vec::new(),
                total: 0,
                meta: ChatMeta::default(),
            })
        }
    };
    let lines = complete_lines(&raw);
    let total = lines.len();
    let context_window = read_context_window();
    let full_meta =
        decode_chat_lines_with_context_window(lines.iter().copied(), total, context_window).meta;
    let mut snap =
        decode_chat_lines_with_context_window(lines.into_iter().skip(after), total, context_window);
    snap.meta = full_meta;
    Ok(snap)
}

#[tauri::command]
fn orchestrator_chat(project: String, after: usize) -> Result<String, String> {
    let snap = read_chat_snapshot(&project, after)?;
    serde_json::to_string(&(snap.turns, snap.results, snap.total, snap.meta))
        .map_err(|e| e.to_string())
}

static CHAT_WATCHERS: std::sync::Mutex<Option<std::collections::HashMap<String, Arc<AtomicBool>>>> =
    std::sync::Mutex::new(None);

fn seed_tail(path: &Path) -> (TranscriptTail, u64, ChatMeta) {
    let mut tail = TranscriptTail::default();
    let mut meta = ChatMeta {
        context: chat_context(None, read_context_window()),
        ..ChatMeta::default()
    };
    if let Ok(raw) = std::fs::read_to_string(path) {
        tail.seed_from_raw(&raw);
        meta = decode_chat_lines(complete_lines(&raw), tail.line_offset).meta;
    }
    let total = tail.line_offset as u64;
    (tail, total, meta)
}

fn forget_chat_watcher(project: &str, stop: &Arc<AtomicBool>) {
    let mut g = CHAT_WATCHERS.lock().unwrap();
    if let Some(map) = g.as_mut() {
        if map.get(project).is_some_and(|live| Arc::ptr_eq(live, stop)) {
            map.remove(project);
        }
    }
}

fn spawn_chat_watcher(
    window: tauri::Window,
    project: String,
    initial_session_id: String,
    mut tail: TranscriptTail,
    mut meta: ChatMeta,
    stop: Arc<AtomicBool>,
) {
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        let mut session_id = initial_session_id;
        let mut path = orchestrator_transcript_path(&project, &session_id).ok();
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }

            if let Some(next_session_id) = orch_session_id(&project) {
                if next_session_id != session_id {
                    session_id = next_session_id;
                    tail.reset();
                    meta = ChatMeta {
                        context: chat_context(None, read_context_window()),
                        ..ChatMeta::default()
                    };
                    path = orchestrator_transcript_path(&project, &session_id).ok();
                    let payload = ChatSessionChangedPayload {
                        project: project.clone(),
                        session_id: session_id.clone(),
                    };
                    if window.emit("chat-session-changed", payload).is_err() {
                        break;
                    }
                }
            }

            if let Some(p) = path.as_deref() {
                match tail.read_new_lines(p) {
                    Ok((after, lines, total)) if !lines.is_empty() => {
                        let snap = decode_chat_lines(lines, total);
                        merge_chat_meta(&mut meta, snap.meta.clone());
                        let payload = ChatRowsPayload {
                            project: project.clone(),
                            session_id: session_id.clone(),
                            after,
                            total,
                            turns: snap.turns,
                            results: snap.results,
                            meta: meta.clone(),
                        };
                        if window.emit("chat-rows", payload).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => {}
                }
            }

            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        stop.store(true, Ordering::SeqCst);
        forget_chat_watcher(&project, &stop);
    });
}

#[tauri::command]
fn chat_watch(window: tauri::Window, project: String) -> Result<u64, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    let sid = orch_session_id(&project)
        .ok_or_else(|| "no orchestrator session for this project yet".to_string())?;
    let path = orchestrator_transcript_path(&project, &sid)?;
    let (tail, current, meta) = seed_tail(&path);
    let stop = Arc::new(AtomicBool::new(false));

    {
        let mut g = CHAT_WATCHERS.lock().unwrap();
        let map = g.get_or_insert_with(std::collections::HashMap::new);
        if map.contains_key(&project) {
            return Ok(current);
        }
        map.insert(project.clone(), Arc::clone(&stop));
    }

    spawn_chat_watcher(window, project, sid, tail, meta, stop);
    Ok(current)
}

#[tauri::command]
fn chat_unwatch(project: String) {
    let project = project.trim();
    if project.is_empty() {
        return;
    }
    let stop = {
        let mut g = CHAT_WATCHERS.lock().unwrap();
        g.as_mut().and_then(|map| map.remove(project))
    };
    if let Some(stop) = stop {
        stop.store(true, Ordering::SeqCst);
    }
}

/// Is the orchestrator mid-turn? Resolved by PANE id rather than by agent label, because "claude"
/// is not unique — a crew could run one as a seat. The pane is.
#[tauri::command]
fn orchestrator_status(project: String) -> Result<String, String> {
    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let pane = rows
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() >= 4 && f[0] == project && f[1] == "orch" {
                Some(f[3].to_string())
            } else {
                None
            }
        })
        .next_back();
    let pane = match pane {
        Some(p) => p,
        None => return Ok("none".into()),
    };
    let out = std::process::Command::new("herdr")
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
fn pane_keys(target: String, keys: String) -> Result<(), String> {
    // Closed list. This runs a subprocess, so an arbitrary string would be an injection surface,
    // and there is no reason the front end should be able to press anything it likes.
    const ALLOWED: &[&str] = &["Escape", "Enter", "C-c"];
    if !ALLOWED.contains(&keys.as_str()) {
        return Err(format!("key '{keys}' is not offered"));
    }
    if target.trim().is_empty() {
        return Err("no pane".into());
    }
    let out = std::process::Command::new("herdr")
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

/// Send a line to a herdr pane, the way a person would type it.
///
/// The input line is SHARED: the CLI stages its own commands there (2026-08-28, a resumed session
/// had "/compact" pre-filled — the operator's dictation fused onto it and their first message was
/// eaten). So an IDLE pane gets its input cleared first: esc esc clears staged text, and the third
/// esc cancels the rewind picker the second one opens when the input was already empty — all three
/// proven against a live claude TUI. A WORKING pane is left alone: Escape there would interrupt
/// the running turn, and text sent mid-turn queues correctly (proven by a mid-turn probe).
#[tauri::command]
fn pane_send(target: String, text: String) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("no pane".into());
    }
    let run = |args: Vec<&str>| -> Result<(), String> {
        let out = std::process::Command::new("herdr")
            .args(args)
            .env("PATH", terminal_path())
            .output()
            .map_err(|e| format!("herdr: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    };
    // Clear ONLY on a positive "idle". "working" → Escape would interrupt the running turn;
    // "blocked" → Escape would dismiss the permission dialog the operator is being asked about;
    // "unknown" → could be either, so the clear is skipped rather than risked.
    if pane_agent_status(&target) == "idle" {
        run(vec!["pane", "send-keys", &target, "esc", "esc", "esc"])?;
    }
    run(vec!["pane", "send-text", &target, &text])?;
    // Enter is a separate call: send-text is literal, so a newline inside it would be typed rather
    // than submitted.
    run(vec!["pane", "send-keys", &target, "Enter"])
}

/// The agent state herdr reports for one pane ("working" | "idle" | "blocked" | …), "unknown" on
/// any failure. The caller clears the input line only on a positive "idle", so "unknown" is the
/// safe answer for every failure: a wrongly-skipped clear risks contamination, a wrongly-sent
/// Escape risks interrupting a live turn or dismissing a permission dialog — the worse trade.
fn pane_agent_status(pane: &str) -> String {
    let out = match std::process::Command::new("herdr")
        .args(["agent", "list"])
        .env("PATH", terminal_path())
        .output()
    {
        Ok(o) => o,
        Err(_) => return "unknown".into(),
    };
    let v: serde_json::Value =
        match serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim()) {
            Ok(v) => v,
            Err(_) => return "unknown".into(),
        };
    for a in v
        .get("result")
        .and_then(|r| r.get("agents"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default()
    {
        if a.get("pane_id").and_then(|p| p.as_str()) == Some(pane) {
            return a
                .get("agent_status")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown")
                .to_string();
        }
    }
    "unknown".into()
}

/// Is this seat writing to its worktree right now?
///
/// ONE owner for this answer. herdr is asked, because crew-runner reports the seat's state to it at
/// every turn boundary and that reflects the process actually running. The UI used to guess from
/// the seat's bus status instead, which is a second truth about the same fact — and this one
/// decides whether a human edit is allowed, so it cannot be a guess.
#[tauri::command]
fn seat_state(agent: String) -> Result<String, String> {
    if agent.trim().is_empty() {
        return Ok("unknown".into());
    }
    let out = std::process::Command::new("herdr")
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

/// Save an edit, and COMMIT it as the operator.
///
/// Committing on save is not a convenience. `trantor integrate` commits a seat's dirty worktree AS
/// THAT SEAT, so a human tweak left sitting uncommitted in glm's worktree would be attributed to
/// glm the next time integration ran, and the record would be permanently wrong about who wrote
/// it. Committing here closes that window, and git blame stays the durable answer.
///
/// Refused outright while the seat is working: editing a file an agent is part way through writing
/// loses one of the two edits with no undo.
#[tauri::command]
fn write_file(
    project: String,
    path: String,
    seat: Option<String>,
    text: String,
) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    if path.contains("..") {
        return Err("path escapes the project".into());
    }
    if let Some(agent) = seat.as_deref() {
        if seat_state(agent.to_string())? == "working" {
            return Err(format!(
                "{agent} is working in this worktree right now — edit it once the seat lands"
            ));
        }
    }
    let full = root.join(&path);
    if !full.is_file() {
        return Err("that file does not exist".into());
    }
    std::fs::write(&full, text).map_err(|e| format!("cannot write {path}: {e}"))?;

    // Authorship comes from the repo's own git config, which IS the human. Nothing is overridden
    // here on purpose: a seat's commits set an author explicitly, so leaving this alone is exactly
    // what keeps the two distinguishable.
    let add = std::process::Command::new("git")
        .args(["add", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git add failed: {e}"))?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    let msg = format!("edit {path} in the app");
    let commit = std::process::Command::new("git")
        .args(["commit", "-q", "-m", &msg, "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git commit failed: {e}"))?;
    if !commit.status.success() {
        let err = String::from_utf8_lossy(&commit.stdout).to_string()
            + &String::from_utf8_lossy(&commit.stderr);
        // "nothing to commit" means the text was identical — saving an unchanged file is not an
        // error, it just did not need a commit.
        if err.contains("nothing to commit") || err.contains("no changes added") {
            return Ok(String::new());
        }
        return Err(err.trim().to_string());
    }
    let sha = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git rev-parse failed: {e}"))?;
    Ok(String::from_utf8_lossy(&sha.stdout).trim().to_string())
}

/// The autonomy dials, read and written through the CLI rather than by parsing autonomy.json here.
///
/// The dependency rules between dials (push implies commit, deploy implies push) live in
/// lib/autonomy.mjs. A second implementation in Rust would drift from it the first time either
/// side changed, and the thing that drifts would be the one deciding whether we push to a remote.
#[tauri::command]
fn autonomy_get(project: Option<String>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("trantor");
    cmd.arg("autonomy").arg("json");
    match project.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            cmd.arg("--project").arg(p);
        }
        _ => {
            cmd.arg("--global");
        }
    }
    let out = cmd
        .env("PATH", terminal_path())
        .output()
        .map_err(|e| format!("trantor autonomy: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
fn autonomy_set(project: Option<String>, dial: String, value: String) -> Result<String, String> {
    // The dial name and value are the only things the front end may choose, and both are checked
    // against a fixed list here as well as in the CLI: this command runs a subprocess, so an
    // unvalidated string would be an argument-injection surface rather than a typo.
    // No "seats" here on purpose: what a crew agent may do unattended is the overseer's level,
    // per project, on the hub. This command must not offer a second way to set it.
    const DIALS: &[&str] = &[
        "harness",
        "commit",
        "push",
        "deploy",
        "swapDeadSeat",
        "retryFailedTurn",
    ];
    const VALUES: &[&str] = &["on", "off", "prompt", "bypass"];
    if !DIALS.contains(&dial.as_str()) {
        return Err(format!("unknown dial '{dial}'"));
    }
    if !VALUES.contains(&value.as_str()) {
        return Err(format!("unknown value '{value}'"));
    }
    let mut cmd = std::process::Command::new("trantor");
    cmd.arg("autonomy").arg("set").arg(&dial).arg(&value);
    match project.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            cmd.arg("--project").arg(p);
        }
        _ => {
            cmd.arg("--global");
        }
    }
    let out = cmd
        .env("PATH", terminal_path())
        .output()
        .map_err(|e| format!("trantor autonomy set: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    // Hand back the resolved state, because the dependencies may have refused what was just asked.
    autonomy_get(project)
}

/// Candidate icon paths, best first. This is a FIXED list rather than a directory walk on purpose:
/// a walk of a repo the size of `flutter` or `crm-platform` would hit node_modules and cost more
/// than the row it decorates. Order encodes quality, not just likelihood — a purpose-built app icon
/// beats a 16px favicon.ico scaled up into a blurry smear, so .ico is deliberately LAST.
const ICON_CANDIDATES: &[&str] = &[
    // purpose-built app icons (Next.js app router, Tauri, plain assets)
    "src/app/icon.png",
    "public/icon.png",
    "assets/icon.png",
    "src-tauri/icons/128x128@2x.png",
    "src-tauri/icons/128x128.png",
    "src-tauri/icons/icon.png",
    // touch icons are ≥120px by spec — always better than a favicon
    "public/apple-touch-icon.png",
    "apple-touch-icon.png",
    "assets/web/apple-touch-icon.png",
    // brand logos
    "public/logo.png",
    "assets/logo.png",
    "assets/web/logo.png",
    ".github/assets/logo.png",
    "public/logo.svg",
    "logo.svg",
    "logo.png",
    // favicons — png before ico, ico last (16px, and WKWebView renders it poorly)
    "public/favicon.png",
    "assets/favicon.png",
    "src/app/favicon.ico",
    "public/favicon.ico",
    "favicon.ico",
];

/// Monorepo layouts put the web app one level down. Checked only after the top-level list misses,
/// and only for a bounded set of parent dirs — `apps/web/public/favicon.ico` (crm-platform) and
/// `web/app/favicon.ico` (polymarket-playground) are both real cases on this machine.
/// …and a desktop shell is very often its own subpackage — Trantor's own mark lives at
/// `desktop/src-tauri/icons/`, so without this the app is the one project that cannot show its face.
const ICON_SUBROOTS: &[&str] = &[
    "apps/web",
    "apps/app",
    "web",
    "packages/web",
    "src",
    "desktop",
];

fn mime_for(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// A project's own icon as a `data:` URI, read from the repo on THIS machine.
///
/// Repos live here and hubs do not — the same reason `card_code` runs locally. Returns null rather
/// than erroring whenever there is nothing good to show (no repo, no art, unreadable, or absurdly
/// large): roughly 60% of the projects on this machine ship no icon at all, so "none" is the normal
/// path and the caller falls back to a monogram. A hard error here would blank a sidebar row.
#[tauri::command]
fn project_icon(project: String) -> Option<String> {
    // Never let a hub-supplied project name walk the filesystem.
    if project.is_empty() || project.contains('/') || project.contains("..") {
        return None;
    }
    let dir = project_dir(&project)?;

    let mut roots: Vec<std::path::PathBuf> = vec![dir.clone()];
    for sub in ICON_SUBROOTS {
        roots.push(dir.join(sub));
    }

    for root in roots {
        for cand in ICON_CANDIDATES {
            let p = root.join(cand);
            if !p.is_file() {
                continue;
            }
            let Some(mime) = mime_for(&p) else { continue };
            // 512KB ceiling: this is a 20px sidebar glyph. Anything larger is a source asset
            // (crebral-desktop-lite ships a 512@2x App Store icon) and inlining it would bloat
            // every render for no visible gain.
            match std::fs::metadata(&p) {
                Ok(m) if m.len() > 0 && m.len() <= 512 * 1024 => {}
                _ => continue,
            }
            let Ok(bytes) = std::fs::read(&p) else {
                continue;
            };
            return Some(format!("data:{};base64,{}", mime, b64(&bytes)));
        }
    }
    None
}

/// Minimal base64. Pulling a crate in for one call site that runs a few dozen times at startup
/// would be a heavier dependency than the seven lines it replaces.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

// ── local session truth ────────────────────────────────────────────────────────────────────────
// Sasha's ruling on what ACTIVE means (2026-08-13): "any project that has a terminal window open
// and is registered." Hub heartbeats cannot answer that — they ride hook fires, so an idle session
// goes dark after 5 quiet minutes and its project fell out of ACTIVE NOW while its window sat
// right there. Same quiet≠dead trap the delivery fix hit; same cure: consult PROCESS truth.
// Heartbeats keep the one job they are good at — "actually mid-turn right now" (the blink).

/// Parse `lsof -Fn` field output (p<pid> / fcwd / n<path>) into cwd paths.
fn lsof_cwds(out: &str) -> Vec<String> {
    out.lines()
        .filter(|l| l.starts_with('n'))
        .map(|l| l[1..].to_string())
        .collect()
}

/// A cwd is a project when it sits DIRECTLY under the dev root (or IS a project dir): the project
/// is the first path component after the root, so a session deep in a monorepo still maps to it.
fn project_of_cwd(cwd: &str, root: &str) -> Option<String> {
    let rel = cwd.strip_prefix(root)?.trim_start_matches('/');
    let first = rel.split('/').next()?.trim();
    if first.is_empty() || first.starts_with('.') {
        return None;
    }
    Some(first.to_string())
}

/// Projects with a live session process on THIS machine: interactive `claude` windows (cwd under
/// the dev root) plus crew-runner seats (project dir is argv[2]; ~/.agent-bus/fleet → "fleet").
#[tauri::command]
fn local_sessions() -> Vec<String> {
    let root = std::env::var("TRANTOR_DEV_ROOT")
        .unwrap_or_else(|_| format!("{}/development", std::env::var("HOME").unwrap_or_default()));
    let sh = |bin: &str, args: &[&str]| -> String {
        std::process::Command::new(bin)
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    };
    let mut out: Vec<String> = Vec::new();

    // interactive claude windows
    let pids: Vec<String> = sh("/usr/bin/pgrep", &["-x", "claude"])
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if !pids.is_empty() {
        let list = pids.join(",");
        for cwd in lsof_cwds(&sh(
            "/usr/sbin/lsof",
            &["-a", "-d", "cwd", "-p", &list, "-Fn"],
        )) {
            if let Some(p) = project_of_cwd(&cwd, &root) {
                out.push(p);
            }
        }
    }

    // crew seats: `node …/crew-runner.mjs <agent> <projectDir>`
    for line in sh("/usr/bin/pgrep", &["-fl", "crew-runner.mjs"]).lines() {
        if let Some(dir) = line.split_whitespace().last() {
            if let Some(name) = std::path::Path::new(dir)
                .file_name()
                .and_then(|n| n.to_str())
            {
                if !name.is_empty() && !name.starts_with('.') {
                    out.push(name.to_string());
                }
            }
        }
    }

    out.sort();
    out.dedup();
    out
}

// ── herdr bridge ───────────────────────────────────────────────────────────────────────────────

fn desktop_bus_dir() -> PathBuf {
    std::env::var("AGENT_BUS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_default();
            PathBuf::from(home).join(".agent-bus")
        })
}

fn find_herdr_binary() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let local = PathBuf::from(&home).join(".local/bin/herdr");
    if local.is_file() {
        return Some(local);
    }
    for dir in terminal_path().split(':') {
        if dir.is_empty() {
            continue;
        }
        let p = Path::new(dir).join("herdr");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[tauri::command]
async fn herdr_pane_read(pane_id: String) -> Result<String, String> {
    let id = pane_id.trim();
    if id.is_empty() || id.contains('\0') {
        return Err("herdr pane id is empty or invalid".into());
    }
    let Some(bin) = find_herdr_binary() else {
        return Err("herdr is not installed".into());
    };
    let out = tokio::process::Command::new(bin)
        .args(["pane", "read", id, "--source", "recent-unwrapped"])
        .env("PATH", terminal_path())
        .output()
        .await
        .map_err(|e| format!("herdr pane read could not start: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let err = String::from_utf8_lossy(if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    })
    .trim()
    .to_string();
    Err(if err.is_empty() {
        "herdr pane read failed".into()
    } else {
        format!("herdr pane read failed: {err}")
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct HerdrSeat {
    project: String,
    agent: String,
    surface: String,
    /// "herdr" for a crew seat, "orch" for the operator's own orchestrator pane. The pane strip
    /// needs the difference: an orchestrator is the person's session, not a worker to supervise.
    kind: String,
}

fn parse_herdr_seats(raw: &str) -> Vec<HerdrSeat> {
    let mut by_seat: BTreeMap<(String, String), HerdrSeat> = BTreeMap::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 4 {
            continue;
        }
        let project = fields[0].trim();
        let kind = fields[1].trim();
        let agent = fields[2].trim();
        let surface = fields[3].trim();
        // `orch` rides the same file as the crew seats (crew.sh records both). Dropping it here is
        // what made `trantor open` land a live pane the app could never show.
        if (kind != "herdr" && kind != "orch")
            || project.is_empty()
            || agent.is_empty()
            || surface.is_empty()
        {
            continue;
        }
        // crew.sh writes the orchestrator's agent column as the literal `__orch__` placeholder;
        // nobody should have to read that in a tab.
        let agent = if kind == "orch" {
            "orchestrator"
        } else {
            agent
        };
        by_seat.insert(
            (project.to_string(), agent.to_string()),
            HerdrSeat {
                project: project.to_string(),
                agent: agent.to_string(),
                surface: surface.to_string(),
                kind: kind.to_string(),
            },
        );
    }
    by_seat.into_values().collect()
}

#[tauri::command]
fn herdr_seats() -> Result<String, String> {
    // One state file, one recorder: crew.sh records herdr seats into the SAME crew-windows.txt as
    // every other mux (kind column = "herdr"). The original contract named a separate file, which was
    // drift waiting to happen — verified live 2026-08-27 when the mapping came back empty.
    let path = desktop_bus_dir().join("crew-windows.txt");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("could not read herdr seat map: {e}")),
    };
    serde_json::to_string(&parse_herdr_seats(&raw)).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SeatDiffFile {
    path: String,
    plus: Option<u64>,
    minus: Option<u64>,
    untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SeatDiff {
    branch: String,
    base: String,
    files: Vec<SeatDiffFile>,
    patch: String,
    truncated: bool,
}

fn parse_numstat(raw: &str) -> Vec<SeatDiffFile> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let Some(plus) = parts.next() else { continue };
        let Some(minus) = parts.next() else { continue };
        let Some(path) = parts.next() else { continue };
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        out.push(SeatDiffFile {
            path: path.to_string(),
            plus: plus.parse::<u64>().ok(),
            minus: minus.parse::<u64>().ok(),
            untracked: false,
        });
    }
    out
}

fn parse_untracked_porcelain(raw: &str) -> Vec<SeatDiffFile> {
    raw.lines()
        .filter_map(|line| {
            let path = line.strip_prefix("?? ")?.trim();
            if path.is_empty() {
                return None;
            }
            Some(SeatDiffFile {
                path: path.to_string(),
                plus: None,
                minus: None,
                untracked: true,
            })
        })
        .collect()
}

fn run_git_text(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git could not start: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let err = String::from_utf8_lossy(if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    })
    .trim()
    .to_string();
    Err(if err.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        format!("git {} failed: {err}", args.join(" "))
    })
}

fn merge_base(dir: &Path) -> Result<String, String> {
    for branch in ["main", "master", "origin/main", "origin/master"] {
        if let Ok(base) = run_git_text(dir, &["merge-base", "HEAD", branch]) {
            let base = base.trim().to_string();
            if !base.is_empty() {
                return Ok(base);
            }
        }
    }
    Err("could not find a merge base with main or master".into())
}

fn cap_patch(bytes: &[u8]) -> (String, bool) {
    const PATCH_LIMIT: usize = 400_000;
    if bytes.len() <= PATCH_LIMIT {
        return (String::from_utf8_lossy(bytes).to_string(), false);
    }
    (
        String::from_utf8_lossy(&bytes[..PATCH_LIMIT]).to_string(),
        true,
    )
}

fn seat_diff_from_bus_dir(bus: &Path, project: &str, agent: &str) -> Result<SeatDiff, String> {
    if project.trim().is_empty()
        || agent.trim().is_empty()
        || project.contains("..")
        || agent.contains("..")
        || project.contains('/')
        || agent.contains('/')
    {
        return Err("project or agent is invalid".into());
    }
    let worktree = bus.join("worktrees").join(project).join(agent);
    if !worktree.is_dir() {
        return Err("seat worktree does not exist".into());
    }
    let branch = run_git_text(&worktree, &["branch", "--show-current"])?
        .trim()
        .to_string();
    let base = merge_base(&worktree)?;

    let mut files = parse_numstat(&run_git_text(&worktree, &["diff", "--numstat", &base])?);
    let untracked =
        parse_untracked_porcelain(&run_git_text(&worktree, &["status", "--porcelain"])?);
    for f in untracked {
        if !files.iter().any(|existing| existing.path == f.path) {
            files.push(f);
        }
    }

    let patch_out = std::process::Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["diff", &base])
        .output()
        .map_err(|e| format!("git diff could not start: {e}"))?;
    if !patch_out.status.success() {
        let err = String::from_utf8_lossy(&patch_out.stderr)
            .trim()
            .to_string();
        return Err(if err.is_empty() {
            "git diff failed".into()
        } else {
            format!("git diff failed: {err}")
        });
    }
    let (patch, truncated) = cap_patch(&patch_out.stdout);
    Ok(SeatDiff {
        branch,
        base,
        files,
        patch,
        truncated,
    })
}

#[tauri::command]
fn seat_diff(project: String, agent: String) -> Result<String, String> {
    serde_json::to_string(&seat_diff_from_bus_dir(
        &desktop_bus_dir(),
        &project,
        &agent,
    )?)
    .map_err(|e| e.to_string())
}

// ── self-update ────────────────────────────────────────────────────────────────────────────────
// The app used to have NO idea a newer release existed: the only update path was someone typing
// `trantor app update` by hand, so a teammate's install stayed stale silently forever. These two
// commands close the loop — same release discovery as bin/app.mjs (any release carrying a
// Trantor_*.dmg is an app release, newest wins), same install steps, but runs in-process so it
// needs no CLI on PATH (a Finder-launched app gets a bare PATH — the 0.3.3 doctor bug).

const RELEASES_URL: &str = "https://api.github.com/repos/sashabogi/trantor/releases?per_page=30";
const APP_PATH: &str = "/Applications/Trantor.app";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    pub current: String,
    pub latest: String,
    pub tag: String,
    pub asset_name: String,
    pub url: String,
    pub size: u64,
    pub update_available: bool,
}

/// "0.3.4" < "0.3.10" (numeric per part, not lexicographic — the whole reason this isn't a string
/// compare). Unparseable parts count as 0 so a weird tag never panics.
fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim()
            .trim_start_matches('v')
            .split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (l, c) = (parse(latest), parse(current));
    for i in 0..l.len().max(c.len()) {
        let (a, b) = (*l.get(i).unwrap_or(&0), *c.get(i).unwrap_or(&0));
        if a != b {
            return a > b;
        }
    }
    false
}

/// Version out of an asset name: "Trantor_0.3.4_aarch64.dmg" → "0.3.4". Falls back to the tag with
/// its app-v/v prefix stripped — mirrors bin/app.mjs exactly, the two must agree on what "latest" is.
fn asset_version(asset_name: &str, tag: &str) -> String {
    // the version is the digits-and-dots run BETWEEN separators: _0.3.4_ in Trantor_0.3.4_aarch64.dmg
    for (i, _) in asset_name.match_indices(|c| c == '_' || c == '-') {
        let rest = &asset_name[i + 1..];
        let num: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let followed_by_sep = rest
            .as_bytes()
            .get(num.len())
            .is_some_and(|c| *c == b'_' || *c == b'-');
        if num.contains('.') && followed_by_sep {
            return num;
        }
    }
    tag.trim_start_matches("app-v")
        .trim_start_matches('v')
        .to_string()
}

#[tauri::command]
async fn app_update_check(app: tauri::AppHandle) -> Result<AppUpdate, String> {
    let current = app.package_info().version.to_string();
    // no-cache: GitHub's shared ~60s API cache can hide a release published seconds ago — the
    // exact bug that made `app update` reinstall the PREVIOUS version on the 0.2.0 release.
    let client = reqwest::Client::new();
    let r = client
        .get(RELEASES_URL)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "trantor-desktop")
        .header("cache-control", "no-cache")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("GitHub unreachable: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("GitHub API {}", r.status()));
    }
    // reqwest here is built without its `json` feature (rustls+stream only) — parse via text
    let body = r.text().await.map_err(|e| e.to_string())?;
    let releases: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    let empty: Vec<serde_json::Value> = Vec::new();
    for rel in releases.as_array().unwrap_or(&empty) {
        let assets = rel["assets"].as_array().unwrap_or(&empty);
        let dmgs: Vec<&serde_json::Value> = assets
            .iter()
            .filter(|a| {
                let n = a["name"].as_str().unwrap_or("");
                n.starts_with("Trantor") && n.ends_with(".dmg")
            })
            .collect();
        if dmgs.is_empty() {
            continue;
        }
        let asset: &serde_json::Value = dmgs
            .iter()
            .find(|a| a["name"].as_str().unwrap_or("").contains("_aarch64"))
            .copied()
            .unwrap_or(dmgs[0]);
        let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
        let asset_name = asset["name"].as_str().unwrap_or("").to_string();
        let latest = asset_version(&asset_name, &tag);
        return Ok(AppUpdate {
            update_available: version_newer(&latest, &current),
            url: asset["browser_download_url"]
                .as_str()
                .unwrap_or("")
                .to_string(),
            size: asset["size"].as_u64().unwrap_or(0),
            current,
            latest,
            tag,
            asset_name,
        });
    }
    Err("no release with a Trantor DMG asset found".into())
}

/// Download the DMG, swap /Applications/Trantor.app, relaunch. On success this process EXITS —
/// the caller never sees the Ok. Every binary is an absolute path on purpose: Finder launches
/// apps with a bare PATH, and this must work from exactly such a launch.
#[tauri::command]
async fn app_update_install(url: String, asset_name: String) -> Result<(), String> {
    if !asset_name.starts_with("Trantor")
        || !asset_name.ends_with(".dmg")
        || asset_name.contains('/')
    {
        return Err("refusing unexpected asset name".into());
    }
    if !url.starts_with("https://github.com/")
        && !url.starts_with("https://objects.githubusercontent.com/")
    {
        return Err("refusing non-GitHub download URL".into());
    }
    let dmg = std::env::temp_dir().join(&asset_name);
    let bytes = reqwest::Client::new()
        .get(&url)
        .header("user-agent", "trantor-desktop")
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    std::fs::write(&dmg, &bytes).map_err(|e| format!("could not write DMG: {e}"))?;

    let run = |bin: &str, args: &[&str]| -> Result<String, String> {
        let out = std::process::Command::new(bin)
            .args(args)
            .output()
            .map_err(|e| format!("{bin}: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "{bin} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    };

    let attach = run(
        "/usr/bin/hdiutil",
        &[
            "attach",
            "-nobrowse",
            "-readonly",
            dmg.to_str().unwrap_or_default(),
        ],
    )?;
    let mount = attach
        .trim()
        .lines()
        .last()
        .unwrap_or("")
        .split('\t')
        .last()
        .unwrap_or("")
        .trim()
        .to_string();
    let result = (|| -> Result<(), String> {
        let src = std::path::Path::new(&mount).join("Trantor.app");
        if !mount.starts_with("/Volumes/") || !src.is_dir() {
            return Err(format!(
                "unexpected DMG layout (mount: {})",
                if mount.is_empty() { "none" } else { &mount }
            ));
        }
        if std::path::Path::new(APP_PATH).exists() {
            std::fs::remove_dir_all(APP_PATH)
                .map_err(|e| format!("could not remove old app: {e}"))?;
        }
        run(
            "/usr/bin/ditto",
            &[src.to_str().unwrap_or_default(), APP_PATH],
        )?;
        // the download carries quarantine; the user explicitly clicked Update — clear it so
        // Gatekeeper doesn't refuse the unsigned build on relaunch
        let _ = run("/usr/bin/xattr", &["-dr", "com.apple.quarantine", APP_PATH]);
        Ok(())
    })();
    let _ = run("/usr/bin/hdiutil", &["detach", &mount, "-quiet"]);
    let _ = std::fs::remove_file(&dmg);
    result?;

    // -n: a fresh instance of the NEW bundle even though this (old) one is still alive for a
    // few more milliseconds. Then exit — the overlap is the handoff.
    let _ = std::process::Command::new("/usr/bin/open")
        .args(["-n", APP_PATH])
        .spawn();
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
}

/// The card→code link: which of the thread's file mentions exist in the repo, and which commits
/// touch the card (by "#id" in the message, or failing that, by the card's own files). Runs git
/// HERE because the hub cannot: repos live on operator machines, hubs do not have them.
#[tauri::command]
async fn card_code(
    project: String,
    card_id: i64,
    candidates: Vec<String>,
) -> Result<String, String> {
    let Some(dir) = project_dir(&project) else {
        return Ok(String::from(
            "{\"dir\":null,\"files\":[],\"commits\":[],\"origin\":null}",
        ));
    };
    // files: resolve each cited path against the repo. Direct join first; then git's own index
    // with a suffix pathspec — a monorepo crew cites paths relative to ITS app root
    // ("lib/marketing/x.ts") while the file lives at apps/web/src/lib/marketing/x.ts, and
    // `git ls-files '*<cited>'` finds it wherever it is (wildmatch spans directories).
    let mut files: Vec<String> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    for c in candidates.iter().take(40) {
        if c.contains("..") {
            continue;
        }
        let rel = c.trim_start_matches('/');
        if dir.join(rel).is_file() {
            if files.len() < 20 && !files.contains(&rel.to_string()) {
                files.push(rel.to_string());
            }
        } else {
            unresolved.push(rel.to_string());
        }
    }
    if !unresolved.is_empty() {
        let mut args: Vec<String> = vec!["ls-files".into(), "--".into()];
        for u in unresolved.iter().take(30) {
            args.push(format!("*{u}"));
        }
        let out = tokio::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(&args)
            .output()
            .await
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        for line in out.lines() {
            let f = line.trim().to_string();
            if !f.is_empty() && files.len() < 20 && !files.contains(&f) {
                files.push(f);
            }
        }
    }
    let git = |args: Vec<String>| {
        let dir = dir.clone();
        async move {
            tokio::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .output()
                .await
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default()
        }
    };
    // commits citing the card id, then commits touching the card's files — dedup, id-cites first
    let mut commits: Vec<(String, String)> = Vec::new();
    let push_lines = |out: String, commits: &mut Vec<(String, String)>| {
        for line in out.lines().take(8) {
            if let Some((sha, subject)) = line.split_once(' ') {
                if commits.iter().any(|(s, _)| s == sha) {
                    continue;
                }
                if commits.len() >= 8 {
                    break;
                }
                commits.push((sha.to_string(), subject.to_string()));
            }
        }
    };
    let by_id = git(vec![
        "log".into(),
        "--all".into(),
        "-n".into(),
        "8".into(),
        "--oneline".into(),
        format!("--grep=#{}", card_id),
    ])
    .await;
    push_lines(by_id, &mut commits);
    if !files.is_empty() {
        let mut args: Vec<String> = vec![
            "log".into(),
            "-n".into(),
            "6".into(),
            "--oneline".into(),
            "--".into(),
        ];
        args.extend(files.iter().cloned());
        let by_files = git(args).await;
        push_lines(by_files, &mut commits);
    }
    // origin → a clickable commit URL when the repo is on GitHub
    let origin_raw = git(vec!["remote".into(), "get-url".into(), "origin".into()]).await;
    let origin = origin_raw.trim();
    let web = if origin.contains("github.com") {
        let o = origin
            .trim_end_matches(".git")
            .replace("git@github.com:", "https://github.com/");
        Some(o)
    } else {
        None
    };
    let json = serde_json::json!({
        "dir": dir.to_string_lossy(),
        "files": files,
        "commits": commits.iter().map(|(sha, subject)| serde_json::json!({"sha": sha, "subject": subject})).collect::<Vec<_>>(),
        "origin": web,
    });
    Ok(json.to_string())
}

/// Open code where the operator wants it. Shelled `open` on purpose: macOS routes editor URL
/// schemes (vscode://, cursor://, zed://) without plugin scope ceremony, and `open -R` reveals.
#[tauri::command]
async fn open_code(target: String, kind: String) -> Result<(), String> {
    let mut c = tokio::process::Command::new("open");
    if kind == "reveal" {
        c.arg("-R");
    }
    c.arg(&target);
    let st = c.status().await.map_err(|e| format!("open: {e}"))?;
    if st.success() {
        Ok(())
    } else {
        Err(format!("open failed for {target}"))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(terminal::TerminalManager::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            sign_request,
            identity_name,
            hub_for_project,
            known_projects,
            hub_request,
            start_stream,
            doctor,
            card_code,
            open_code,
            project_icon,
            local_sessions,
            herdr_pane_read,
            herdr_seats,
            seat_diff,
            project_files,
            search_files,
            read_file,
            file_diff,
            read_file_at_head,
            seat_state,
            orchestrator_chat,
            chat_watch,
            chat_unwatch,
            pane_send,
            pane_keys,
            orchestrator_status,
            write_file,
            autonomy_get,
            autonomy_set,
            app_update_check,
            app_update_install,
            terminal::orchestrator_open,
            terminal::term_attach,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_detach
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod herdr_tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("trantor-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn herdr_seat_rows_keep_only_last_modern_herdr_entry() {
        let rows = [
            "legacy-agent\tterminal-1",
            "trantor\therdr\tcodex\tpane-old",
            "trantor\tcmux\tglm\tsurface-no",
            "trantor\therdr\tcodex\tpane-new",
            "other\therdr\tkimi\tpane-k",
        ]
        .join("\n");
        let seats = parse_herdr_seats(&rows);
        assert_eq!(
            seats,
            vec![
                HerdrSeat {
                    project: "other".into(),
                    agent: "kimi".into(),
                    surface: "pane-k".into(),
                    kind: "herdr".into()
                },
                HerdrSeat {
                    project: "trantor".into(),
                    agent: "codex".into(),
                    surface: "pane-new".into(),
                    kind: "herdr".into()
                },
            ]
        );
    }

    #[test]
    fn herdr_seat_rows_carry_the_orchestrator_pane() {
        // `trantor open` records kind `orch` into the same file as the crew seats. Dropping it was
        // why a live orchestrator pane existed on disk and in herdr but never in the app.
        let rows = [
            "trantor\therdr\tcodex\tw2:p1",
            "trantor\torch\t__orch__\tw2:p5",
        ]
        .join("\n");
        let seats = parse_herdr_seats(&rows);
        assert_eq!(
            seats,
            vec![
                HerdrSeat {
                    project: "trantor".into(),
                    agent: "codex".into(),
                    surface: "w2:p1".into(),
                    kind: "herdr".into()
                },
                HerdrSeat {
                    project: "trantor".into(),
                    agent: "orchestrator".into(),
                    surface: "w2:p5".into(),
                    kind: "orch".into()
                },
            ]
        );
    }

    #[test]
    fn herdr_seat_rows_still_drop_other_muxes() {
        let rows = [
            "trantor\tcmux\tglm\tsurface-no",
            "trantor\therdrws\t__ws__\tw2",
        ]
        .join("\n");
        assert_eq!(parse_herdr_seats(&rows), vec![]);
    }

    #[test]
    fn harness_injections_never_wear_the_operator_role() {
        // Every one of these arrives as an ordinary user turn. Rendering them as the person
        // speaking is what put a 6,849-character hook dump in the chat under "YOU".
        assert!(is_harness_injection(
            "Stop hook feedback:\nYou have 29 unread DIRECT message(s)"
        ));
        assert!(is_harness_injection("[Request interrupted by user]"));
        assert!(is_harness_injection(
            "<system-reminder>read this</system-reminder>"
        ));
        assert!(is_harness_injection(
            "PostToolUse:Bash hook additional context: <trantor-inbox>"
        ));
        assert!(is_harness_injection(
            "This session is being continued from a previous conversation"
        ));
    }

    #[test]
    fn assistant_usage_sets_context_tokens_and_fraction() {
        let rows = [
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "model": "claude-opus",
                    "usage": {
                        "input_tokens": 400,
                        "cache_read_input_tokens": 50,
                        "cache_creation_input_tokens": 25
                    },
                    "content": [{"type": "text", "text": "done"}]
                }
            })
            .to_string(),
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "model": "claude-opus",
                    "usage": {
                        "input_tokens": 800,
                        "cache_read_input_tokens": 100,
                        "cache_creation_input_tokens": 100
                    },
                    "content": [{"type": "text", "text": "again"}]
                }
            })
            .to_string(),
        ];
        let snap = decode_chat_lines_with_context_window(rows.iter(), rows.len(), 2_000);
        assert_eq!(snap.meta.context.tokens, Some(1_000));
        assert_eq!(snap.meta.context.window, 2_000);
        assert_eq!(snap.meta.context.frac, Some(0.5));
    }

    #[test]
    fn context_tokens_stay_null_until_assistant_usage_exists() {
        let rows = [serde_json::json!({
            "type": "assistant",
            "message": {
                "model": "claude-opus",
                "content": [{"type": "text", "text": "no usage yet"}]
            }
        })
        .to_string()];
        let snap = decode_chat_lines_with_context_window(rows.iter(), rows.len(), 200_000);
        assert_eq!(snap.meta.context.tokens, None);
        assert_eq!(snap.meta.context.window, 200_000);
        assert_eq!(snap.meta.context.frac, None);
    }

    #[test]
    fn slash_command_record_renders_as_system_divider() {
        let row = serde_json::json!({
            "type": "user",
            "message": { "content": "/compact fused words stay here" }
        })
        .to_string();
        let snap = decode_chat_lines_with_context_window([row], 1, 0);
        assert_eq!(snap.turns.len(), 1);
        assert_eq!(snap.turns[0].role, "system");
        assert_eq!(snap.turns[0].blocks[0].kind, "divider");
        assert_eq!(
            snap.turns[0].blocks[0].text,
            "/compact fused words stay here"
        );
    }

    #[test]
    fn local_command_blocks_render_as_system_dividers() {
        for text in [
            "<local-command-caveat>do not show this as user speech</local-command-caveat>",
            "<local-command-stdout>cargo test output</local-command-stdout>",
        ] {
            let row = serde_json::json!({
                "type": "user",
                "message": { "content": text }
            })
            .to_string();
            let snap = decode_chat_lines_with_context_window([row], 1, 0);
            assert_eq!(snap.turns.len(), 1);
            assert_eq!(snap.turns[0].role, "system");
            assert_eq!(snap.turns[0].blocks[0].kind, "divider");
            assert_eq!(snap.turns[0].blocks[0].text, text);
        }
    }

    #[test]
    fn is_meta_user_entry_renders_as_system_divider() {
        let row = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": { "content": [{ "type": "text", "text": "bookkeeping note" }] }
        })
        .to_string();
        let snap = decode_chat_lines_with_context_window([row], 1, 0);
        assert_eq!(snap.turns.len(), 1);
        assert_eq!(snap.turns[0].role, "system");
        assert_eq!(snap.turns[0].blocks[0].kind, "divider");
        assert_eq!(snap.turns[0].blocks[0].text, "bookkeeping note");
    }

    #[test]
    fn a_message_starting_with_an_absolute_path_stays_user_speech() {
        // The first live file-drop regression: "/Users/…" matched a bare starts_with('/'),
        // rendered as bookkeeping, and the delivery receipt declared a delivered message lost.
        let row = serde_json::json!({
            "type": "user",
            "message": { "content": "/Users/sasha/Desktop/CleanShot 2026-08-28 at 12.14.58.jpg  here is the screen shot" }
        })
        .to_string();
        let snap = decode_chat_lines_with_context_window([row], 1, 0);
        assert_eq!(snap.turns[0].role, "user");
        assert_eq!(snap.turns[0].blocks[0].kind, "text");
    }

    #[test]
    fn slash_command_gate_takes_commands_and_refuses_paths() {
        assert!(is_slash_command("/compact"));
        assert!(is_slash_command("/compact with trailing words"));
        assert!(is_slash_command("/model opus"));
        assert!(is_slash_command("/trantor:handoff"));
        assert!(!is_slash_command("/Users/sasha/x.jpg here"));
        assert!(!is_slash_command("/tmp/scratch.txt"));
        assert!(!is_slash_command("plain words"));
        assert!(!is_slash_command("/"));
    }

    #[test]
    fn plain_user_message_stays_user_speech() {
        let row = serde_json::json!({
            "type": "user",
            "message": { "content": "please /compact later, not now" }
        })
        .to_string();
        let snap = decode_chat_lines_with_context_window([row], 1, 0);
        assert_eq!(snap.turns.len(), 1);
        assert_eq!(snap.turns[0].role, "user");
        assert_eq!(snap.turns[0].blocks[0].kind, "text");
        assert_eq!(
            snap.turns[0].blocks[0].text,
            "please /compact later, not now"
        );
    }

    #[test]
    fn chat_meta_merge_keeps_last_known_context_across_batches() {
        let mut meta = decode_chat_lines_with_context_window(
            [serde_json::json!({
                "type": "assistant",
                "message": {
                    "usage": { "input_tokens": 80, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 10 },
                    "content": [{"type": "text", "text": "first"}]
                }
            })
            .to_string()],
            1,
            1_000,
        )
        .meta;
        let next = decode_chat_lines_with_context_window(
            [serde_json::json!({
                "type": "user",
                "message": { "content": "next" }
            })
            .to_string()],
            2,
            1_000,
        )
        .meta;
        merge_chat_meta(&mut meta, next);
        assert_eq!(meta.context.tokens, Some(100));
        assert_eq!(meta.context.frac, Some(0.1));
    }

    #[test]
    fn a_real_message_is_never_mistaken_for_machinery() {
        assert!(!is_harness_injection("hi"));
        assert!(!is_harness_injection("say only: PERSIST_OK"));
        // Length is not the signal. A long message from a person is still from a person.
        assert!(!is_harness_injection(
            &"read docs/PRD.md and plan the build. ".repeat(300)
        ));
        // The word appearing mid-sentence in a discussion ABOUT hooks is the trap a naive
        // "contains" check falls into, so markers must anchor at the start.
        assert!(!is_harness_injection(
            "can you look at why the Stop hook feedback fires twice?"
        ));
    }

    #[test]
    fn tool_summary_shows_the_field_a_person_would_recognise() {
        let bash = serde_json::json!({ "command": "npm test", "description": "run the suite" });
        assert_eq!(tool_summary("Bash", &bash), "npm test");
        let read = serde_json::json!({ "file_path": "bin/crew.sh", "limit": 40 });
        assert_eq!(tool_summary("Read", &read), "bin/crew.sh");
        let grep = serde_json::json!({ "pattern": "orch", "path": "bin" });
        assert_eq!(tool_summary("Grep", &grep), "orch  in bin");
    }

    #[test]
    fn tool_summary_falls_back_rather_than_guessing_a_key() {
        // An unknown tool takes its first string field. Guessing at "the important key" would be
        // confidently wrong on every tool nobody thought of.
        let unknown = serde_json::json!({ "target": "w2:p1", "n": 3 });
        assert_eq!(tool_summary("herdr_thing", &unknown), "w2:p1");
        assert_eq!(tool_summary("empty", &serde_json::json!({})), "");
    }

    #[test]
    fn tool_summary_stays_one_line_and_bounded() {
        let long = serde_json::json!({ "command": "x\ny".to_string() + &"z".repeat(400) });
        let out = tool_summary("Bash", &long);
        assert!(
            !out.contains('\n'),
            "newlines would break the one-line card"
        );
        assert!(out.chars().count() <= 161, "{}", out.chars().count());
        assert!(out.ends_with('…'));
    }

    #[test]
    fn tool_result_preview_handles_both_shapes_git_actually_writes() {
        assert_eq!(preview_of(&serde_json::json!("done")), "done");
        let blocks = serde_json::json!([{ "type": "text", "text": "line one" }, { "type": "text", "text": "line two" }]);
        assert_eq!(preview_of(&blocks), "line one\nline two");
        assert_eq!(preview_of(&serde_json::Value::Null), "");
    }

    #[test]
    fn transcript_tail_buffers_partial_line_until_newline() {
        let mut tail = TranscriptTail::default();
        let (after, lines, total) = tail.push_chunk(r#"{"type":"assistant""#);
        assert_eq!(after, 0);
        assert!(lines.is_empty());
        assert_eq!(total, 0);

        let (after, lines, total) = tail.push_chunk(r#","message":{"content":[]}}"#);
        assert_eq!(after, 0);
        assert!(lines.is_empty());
        assert_eq!(total, 0);

        let (after, lines, total) = tail.push_chunk("\n");
        assert_eq!(after, 0);
        assert_eq!(
            lines,
            vec![r#"{"type":"assistant","message":{"content":[]}}"#.to_string()]
        );
        assert_eq!(total, 1);
    }

    #[test]
    fn transcript_tail_reports_cursor_continuity_by_complete_line() {
        let mut tail = TranscriptTail::default();
        let (after, lines, total) = tail.push_chunk("one\n");
        assert_eq!(after, 0);
        assert_eq!(lines, vec!["one".to_string()]);
        assert_eq!(total, 1);

        let (after, lines, total) = tail.push_chunk("two\nthree\n");
        assert_eq!(after, 1);
        assert_eq!(lines, vec!["two".to_string(), "three".to_string()]);
        assert_eq!(total, 3);
    }

    #[test]
    fn transcript_tail_seeds_existing_partial_without_marking_it_seen() {
        let mut tail = TranscriptTail::default();
        tail.seed_from_raw("one\ntwo");
        assert_eq!(tail.line_offset, 1);

        let (after, lines, total) = tail.push_chunk("\n");
        assert_eq!(after, 1);
        assert_eq!(lines, vec!["two".to_string()]);
        assert_eq!(total, 2);
    }

    #[test]
    fn transcript_tail_rotation_restarts_from_line_zero() {
        let root = temp_dir("tail-rotation");
        let path = root.join("session.jsonl");
        fs::write(&path, "one\ntwo\n").unwrap();
        let mut tail = TranscriptTail::default();

        let (after, lines, total) = tail.read_new_lines(&path).unwrap();
        assert_eq!(after, 0);
        assert_eq!(lines, vec!["one".to_string(), "two".to_string()]);
        assert_eq!(total, 2);

        fs::write(&path, "new\n").unwrap();
        let (after, lines, total) = tail.read_new_lines(&path).unwrap();
        assert_eq!(after, 0);
        assert_eq!(lines, vec!["new".to_string()]);
        assert_eq!(total, 1);
    }

    #[test]
    fn file_tree_status_marks_the_file_and_every_folder_above_it() {
        let m =
            parse_status_porcelain(" M bin/crew.sh\n?? desktop/src/features/workspace/new.tsx\n");
        assert_eq!(m.get("bin/crew.sh"), Some(&"M".to_string()));
        // a closed folder must still show that something inside it changed
        assert_eq!(m.get("bin"), Some(&"M".to_string()));
        assert_eq!(
            m.get("desktop/src/features/workspace"),
            Some(&"??".to_string())
        );
        assert_eq!(m.get("README.md"), None);
    }

    #[test]
    fn file_tree_status_follows_a_rename_to_its_new_name() {
        let m = parse_status_porcelain("R  old/a.ts -> src/b.ts\n");
        assert_eq!(m.get("src/b.ts"), Some(&"R".to_string()));
        assert_eq!(m.get("old/a.ts"), None);
    }

    #[test]
    fn seat_diff_parses_numstat_and_untracked_porcelain() {
        let files = parse_numstat("12\t3\tsrc/lib.rs\n-\t-\tassets/icon.png\n");
        assert_eq!(
            files[0],
            SeatDiffFile {
                path: "src/lib.rs".into(),
                plus: Some(12),
                minus: Some(3),
                untracked: false
            }
        );
        assert_eq!(
            files[1],
            SeatDiffFile {
                path: "assets/icon.png".into(),
                plus: None,
                minus: None,
                untracked: false
            }
        );
        assert_eq!(
            parse_untracked_porcelain(" M src/lib.rs\n?? new-file.txt\n?? nested/path.rs\n"),
            vec![
                SeatDiffFile {
                    path: "new-file.txt".into(),
                    plus: None,
                    minus: None,
                    untracked: true
                },
                SeatDiffFile {
                    path: "nested/path.rs".into(),
                    plus: None,
                    minus: None,
                    untracked: true
                },
            ]
        );
    }

    #[test]
    fn seat_diff_reports_branch_base_files_patch_and_truncation() {
        let root = temp_dir("seat-diff");
        let source = root.join("repo");
        fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "-q", "-b", "main"]);
        git(&source, &["config", "user.email", "trantor@example.test"]);
        git(&source, &["config", "user.name", "Trantor Test"]);
        fs::write(source.join("tracked.txt"), "one\n").unwrap();
        fs::write(source.join("binary.bin"), [0u8, 1, 2, 3]).unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-q", "-m", "base"]);

        let bus = root.join("bus");
        let wt = bus.join("worktrees/demo/codex");
        fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(
            &source,
            &[
                "worktree",
                "add",
                "-q",
                "-B",
                "seat/codex",
                wt.to_str().unwrap(),
                "HEAD",
            ],
        );
        fs::write(wt.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(wt.join("new.txt"), "new\n").unwrap();
        let diff = seat_diff_from_bus_dir(&bus, "demo", "codex").unwrap();

        assert_eq!(diff.branch, "seat/codex");
        assert_eq!(diff.base.len(), 40);
        assert!(diff.files.contains(&SeatDiffFile {
            path: "tracked.txt".into(),
            plus: Some(2),
            minus: Some(0),
            untracked: false
        }));
        assert!(diff.files.contains(&SeatDiffFile {
            path: "new.txt".into(),
            plus: None,
            minus: None,
            untracked: true
        }));
        assert!(diff.patch.contains("two"));
        assert!(!diff.truncated);

        let huge = vec![b'x'; 400_010];
        let (patch, truncated) = cap_patch(&huge);
        assert_eq!(patch.len(), 400_000);
        assert!(truncated);
    }
}

#[cfg(test)]
mod icon_tests {
    use super::*;

    // Hand-rolled base64 is exactly the kind of code that looks right and is wrong on the last
    // chunk, which is where every padding bug lives — so all three remainders are covered.
    #[test]
    fn base64_matches_the_reference_vectors() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foob"), "Zm9vYg==");
        assert_eq!(b64(b"fooba"), "Zm9vYmE=");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_handles_high_bytes() {
        // PNG magic — the real payload starts with bytes that are not valid UTF-8.
        assert_eq!(b64(&[0x89, 0x50, 0x4E, 0x47]), "iVBORw==");
        assert_eq!(b64(&[0xFF, 0xFF, 0xFF]), "////");
    }

    #[test]
    fn a_project_name_cannot_escape_the_dev_root() {
        assert_eq!(project_icon("../../etc".into()), None);
        assert_eq!(project_icon("a/b".into()), None);
        assert_eq!(project_icon("".into()), None);
    }

    #[test]
    fn mime_is_resolved_by_extension_and_rejects_the_rest() {
        use std::path::Path;
        assert_eq!(mime_for(Path::new("a/icon.png")), Some("image/png"));
        assert_eq!(mime_for(Path::new("a/logo.SVG")), Some("image/svg+xml"));
        assert_eq!(mime_for(Path::new("a/favicon.ico")), Some("image/x-icon"));
        assert_eq!(mime_for(Path::new("a/readme.md")), None);
        assert_eq!(mime_for(Path::new("a/noext")), None);
    }

    // .ico last is a deliberate quality ordering, not an accident — a 16px favicon scaled into a
    // 20px slot is the blurry result this whole change exists to avoid.
    #[test]
    fn purpose_built_icons_outrank_favicons() {
        let pos = |s: &str| ICON_CANDIDATES.iter().position(|c| *c == s).expect(s);
        assert!(pos("public/icon.png") < pos("public/favicon.ico"));
        assert!(pos("public/apple-touch-icon.png") < pos("public/favicon.ico"));
        assert!(pos("public/favicon.png") < pos("public/favicon.ico"));
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn lsof_field_output_yields_only_paths() {
        let out = "p31023\nfcwd\nn/Users/s/development/crebral-scribe\np33890\nfcwd\nn/Users/s/development/crebral-health\n";
        assert_eq!(
            lsof_cwds(out),
            vec![
                "/Users/s/development/crebral-scribe",
                "/Users/s/development/crebral-health"
            ]
        );
        assert!(lsof_cwds("").is_empty());
    }

    // a session deep inside a monorepo still belongs to its project, and a shell sitting AT the
    // dev root belongs to nothing
    #[test]
    fn cwd_maps_to_the_first_component_under_the_root() {
        let r = "/Users/s/development";
        assert_eq!(
            project_of_cwd("/Users/s/development/crebral-health", r),
            Some("crebral-health".into())
        );
        assert_eq!(
            project_of_cwd("/Users/s/development/crm-platform/apps/web", r),
            Some("crm-platform".into())
        );
        assert_eq!(project_of_cwd("/Users/s/development", r), None);
        assert_eq!(project_of_cwd("/Users/s/development/.hidden", r), None);
        assert_eq!(project_of_cwd("/Users/s/elsewhere/thing", r), None);
    }
}

#[cfg(test)]
mod update_tests {
    use super::*;

    // numeric-per-part is the whole point: a string compare calls "0.3.10" OLDER than "0.3.9"
    #[test]
    fn version_compare_is_numeric_not_lexicographic() {
        assert!(version_newer("0.3.10", "0.3.9"));
        assert!(version_newer("0.4.0", "0.3.9"));
        assert!(version_newer("1.0.0", "0.99.99"));
        assert!(!version_newer("0.3.4", "0.3.4"));
        assert!(!version_newer("0.3.3", "0.3.4"));
        // downgrade must never be offered as an update
        assert!(!version_newer("0.3.3", "0.3.10"));
    }

    #[test]
    fn version_compare_survives_junk() {
        assert!(version_newer("v0.4", "0.3.9"));
        assert!(version_newer("0.3.4", "0.3"));
        assert!(!version_newer("garbage", "0.0.1"));
    }

    // must agree with bin/app.mjs's regex [_-]([0-9.]+)[_-] — the CLI and the app answering
    // "what's latest" differently would be its own bug
    #[test]
    fn asset_version_matches_the_cli_parse() {
        assert_eq!(
            asset_version("Trantor_0.3.4_aarch64.dmg", "app-v0.3.4"),
            "0.3.4"
        );
        assert_eq!(
            asset_version("Trantor-0.10.0-x64.dmg", "app-v0.10.0"),
            "0.10.0"
        );
        // no embedded version → tag with prefixes stripped
        assert_eq!(asset_version("Trantor.dmg", "app-v0.2.0"), "0.2.0");
        assert_eq!(asset_version("Trantor.dmg", "v1.2.3"), "1.2.3");
    }

    #[test]
    fn install_refuses_off_github_urls_and_odd_names() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = |u: &str, n: &str| {
            rt.block_on(app_update_install(u.into(), n.into()))
                .unwrap_err()
        };
        assert!(
            err("https://evil.example/x.dmg", "Trantor_0.3.4_aarch64.dmg").contains("non-GitHub")
        );
        assert!(err("https://github.com/x/y.dmg", "NotTrantor.dmg").contains("unexpected asset"));
        assert!(
            err("https://github.com/x/y.dmg", "Trantor_../../x.dmg").contains("unexpected asset")
        );
    }
}
