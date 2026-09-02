mod herdr;
pub mod identity;
pub mod lsp;
mod sessions;
mod terminal;

use notify::Watcher;
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime};

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
pub(crate) fn terminal_path() -> String {
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
    /// +N/−N vs HEAD (numstat) — the tree row's change-size chip. null for untracked and
    /// binary files: git has no count for either, and a fake zero would be a lie (#5811).
    plus: Option<u64>,
    minus: Option<u64>,
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

/// +N/−N per path vs HEAD, parsed once per call from `git diff --numstat HEAD` — the working
/// tree against the last commit, which is what a tree row or an SCM row means by "changed".
/// Untracked files produce no numstat row and binary files count as "- -"; both map to nothing,
/// because a fake zero would read as "known small" (#5811). Read ONCE per tree/panel request,
/// same one-subprocess discipline as git_status_map.
fn git_numstat_vs_head(dir: &Path) -> std::collections::HashMap<String, (u64, u64)> {
    let mut map = std::collections::HashMap::new();
    let out = match std::process::Command::new("git")
        .args(["diff", "--numstat", "HEAD"])
        .current_dir(dir)
        .output()
    {
        Ok(o) if o.status.success() => o,
        // A repo with no commits yet has no HEAD to diff against; the tree still renders.
        _ => return map,
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split('\t');
        let plus = it.next().unwrap_or("");
        let minus = it.next().unwrap_or("");
        let path = it.next().unwrap_or("");
        if path.is_empty() || plus == "-" || minus == "-" {
            continue;
        }
        if let (Ok(p), Ok(m)) = (plus.parse::<u64>(), minus.parse::<u64>()) {
            // a rename reads "old -> new"; the new name is the one on disk
            let path = path.rsplit(" -> ").next().unwrap_or(path).to_string();
            map.insert(path, (p, m));
        }
    }
    map
}

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
pub(crate) fn source_root(project: &str, seat: Option<&str>) -> Result<std::path::PathBuf, String> {
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

/// A file's stat on disk, for the live viewer's polling loop. Modified time + size are the cheap
/// signal that a file changed under the operator: reading the whole body every tick is how a viewer
/// turns into a re-download loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct FileStat {
    /// modified time in milliseconds since the Unix epoch, 0 when the OS could not say
    mtime_ms: u64,
    bytes: u64,
}

#[tauri::command]
fn file_stat(project: String, path: String, seat: Option<String>) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    if path.contains("..") {
        return Err("path escapes the project".into());
    }
    let full = root.join(&path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("cannot stat {path}: {e}"))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let stat = FileStat {
        mtime_ms,
        bytes: meta.len(),
    };
    serde_json::to_string(&stat).map_err(|e| e.to_string())
}

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
    let counts = git_numstat_vs_head(&root);
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
        let (plus, minus) = match counts.get(&path) {
            Some(c) => (Some(c.0), Some(c.1)),
            None => (None, None),
        };
        out.push(FileEntry {
            name,
            path,
            dir: is_dir,
            status: st,
            plus,
            minus,
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
/// The session id of this project's orchestrator conversation.
///
/// Resolution order is the SYSTEM-CONTRACT §4 identity row, not a preference:
/// 1. The pane's own report — Claude Code's herdr integration reports the session id at
///    SessionStart (`agent_session`, source "herdr:claude"), so it is correct the moment a
///    handoff successor boots, before the map file catches up.
/// 2. `orch-sessions.txt`, the durable map — the cold-start fallback, and the only answer for
///    sessions that are not in a herdr pane (a Terminal-window conversation being read here).
/// Never "the newest transcript": guessing between conversations is the adopt PICKER's job,
/// in front of the operator.
fn orch_session_id(project: &str) -> Option<String> {
    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    if let Some(pane) = orch_pane_from_rows(&rows, project) {
        // The herdr leg is CACHED (3s): the chat watcher calls this every 300ms, and paying a
        // socket round-trip per tick let a load-slowed herdr stall the transcript tail — the
        // operator watched their own message take ~34s to echo (2026-08-30). Identity moves at
        // handoff speed, not tick speed; 3 seconds of staleness is invisible, a blocked tail
        // is not. The query itself also carries a 1.5s budget now (herdr.rs), so even a cache
        // miss against a wedged server costs one bounded beat, once per 3 seconds.
        static HERDR_SID: std::sync::Mutex<Option<(String, Instant, Option<String>)>> =
            std::sync::Mutex::new(None);
        let cached: Option<Option<String>> = {
            let g = HERDR_SID.lock().unwrap();
            g.as_ref()
                .filter(|(p, at, _)| p == &pane && at.elapsed() < Duration::from_secs(3))
                .map(|(_, _, sid)| sid.clone())
        };
        let reported = match cached {
            Some(sid) => sid,
            None => {
                let sid = herdr::reported_session(&pane);
                *HERDR_SID.lock().unwrap() = Some((pane.clone(), Instant::now(), sid.clone()));
                sid
            }
        };
        if let Some(sid) = reported {
            // A pane report can be POISONED by an ephemeral claude run in the same pane —
            // `claude plugin update` (observed live 2026-08-31) registers a session-start with
            // herdr, its sid has no transcript, and the app then reads a file that does not
            // exist: empty chat, no meta, no context gauge, "history lost" on every restart.
            // The report only wins when its transcript actually exists on disk; otherwise the
            // durable map below is the truth.
            let plausible = orchestrator_transcript_path(project, &sid)
                .map(|p| p.exists())
                .unwrap_or(false);
            if plausible {
                return Some(sid);
            }
        }
    }
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
    /// A message the operator sent while the agent was mid-turn: recorded, but NOT yet seen by
    /// the session. Rendering it as an ordinary turn made the chat claim "read" while the
    /// terminal's queue said otherwise (2026-08-28) — three states exist (sent, queued, seen)
    /// and the middle one must show. Cleared by the queue's `remove` row via a dequeue marker
    /// the front-end reducer consumes.
    #[serde(skip_serializing_if = "Option::is_none")]
    queued: Option<bool>,
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
    #[serde(skip)]
    guard: ContextGuard,
}

/// The context gauge's poison guard (#5572, Phase 4A — SYSTEM-CONTRACT §4 "context %").
///
/// Within one session file, real context never collapses: across 1,839 usage rows in the two
/// long incident-era transcripts (77b17edd, 52109744), zero drops below 40% of the running max
/// were observed. So one row far below the session's max is an artifact — the recent maximum
/// is reported instead — while a SUSTAINED new level (five consecutive low rows) is accepted
/// and re-baselines the guard, so any future legitimate collapse (context editing, in-place
/// compaction) heals on its own instead of pinning the gauge high forever.
///
/// The same rule, from the same fixture manifest, lives in hooks/lib/handoff.mjs — the baton
/// reads what the gauge reads, or the banner and the heartbeat disagree (the #5572 disease).
#[derive(Debug, Clone, Default)]
struct ContextGuard {
    max: u64,
    recent: Vec<u64>,
}

impl ContextGuard {
    const RING: usize = 5;
    const FLOOR_FRAC: f64 = 0.4;

    fn push(&mut self, tokens: u64) {
        if tokens == 0 {
            return;
        }
        self.recent.push(tokens);
        if self.recent.len() > Self::RING {
            self.recent.remove(0);
        }
        if tokens > self.max {
            self.max = tokens;
        }
    }

    fn absorb(&mut self, other: &ContextGuard) {
        for t in &other.recent {
            self.push(*t);
        }
        if other.max > self.max {
            self.max = other.max;
        }
    }

    fn report(&mut self) -> Option<u64> {
        let last = *self.recent.last()?;
        let floor = (self.max as f64 * Self::FLOOR_FRAC) as u64;
        if last >= floor {
            return Some(last);
        }
        if self.recent.len() == Self::RING && self.recent.iter().all(|r| *r < floor) {
            // Five in a row agree: reality changed. Re-baseline so the guard follows it.
            self.max = *self.recent.iter().max().unwrap();
            return Some(last);
        }
        // A transient artifact: report the best recent evidence, never the poisoned row.
        Some(*self.recent.iter().max().unwrap())
    }
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
        "[SYSTEM NOTIFICATION",
        "This session is being continued from a previous conversation",
        // The crew boot prompt (bin/crew-runner.mjs kicks every seat off with it). Matched as a
        // SHORT PREFIX on purpose: transcript stores truncate it at various lengths, and the full
        // sentence marker let the truncated tail leak into Sessions titles (#5842).
        "You just joined (your arrival was",
        "NEW BUS MESSAGE for you:",
        "NEW BUS MESSAGES for you:",
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
    // Usage rows fold through the persistent guard (#5572): a batch is often ONE row, so the
    // poison filter must live across batches, in the meta the watcher carries — never in the
    // stateless per-batch decode alone.
    current.guard.absorb(&next.guard);
    let tokens = current.guard.report().or(current.context.tokens);
    current.context = chat_context(tokens, current.context.window);
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
    /// RAW text of every user-role row, UNFILTERED (receipts read the record, not the display —
    /// five delivery false-alarms came from matching against harness-filtered turns; a
    /// bang-command's <bash-input> row, a /compact record, an isMeta row all vanish from
    /// display but all PROVE arrival).
    receipt_texts: Vec<String>,
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
    #[serde(rename = "receiptTexts")]
    receipt_texts: Vec<String>,
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
    let mut receipt_texts: Vec<String> = Vec::new();
    let mut meta = ChatMeta {
        context: chat_context(None, context_window),
        ..ChatMeta::default()
    };

    for line in lines {
        let v: serde_json::Value = match serde_json::from_str(line.as_ref()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // The receipt channel: RAW arrival truth, before display filtering. Plain user rows
        // and queue enqueues both prove a send arrived, whatever the display decides to show.
        match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => {
                if let Some(c) = v.get("message").and_then(|m| m.get("content")) {
                    let t = text_content(c);
                    if !t.trim().is_empty() {
                        receipt_texts.push(t);
                    }
                }
            }
            Some("queue-operation") => {
                if let Some(t) = v.get("content").and_then(|c| c.as_str()) {
                    if !t.trim().is_empty() {
                        receipt_texts.push(t.to_string());
                    }
                }
            }
            _ => {}
        }
        let role = match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            // A message sent while the agent is MID-TURN never becomes a `user` row: the CLI
            // records an enqueue and folds the words into the running turn. The enqueue IS the
            // operator speaking — without this branch their message neither rendered in the
            // thread nor satisfied its delivery receipt, which then cried "not delivered" about
            // a message that arrived (2026-08-28, third false alarm of the day). `remove` is the
            // queue's own bookkeeping and stays invisible.
            Some("queue-operation") => {
                let op = v.get("operation").and_then(|o| o.as_str());
                // `remove` = the session consumed the queued message. Emitted as a marker the
                // front-end reducer uses to clear the matching turn's queued flag, then drops —
                // it never renders.
                if op == Some("remove") {
                    if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                        if !text.trim().is_empty() && !is_harness_injection(text) {
                            turns.push(ChatTurn {
                                role: "system".into(),
                                blocks: vec![ChatBlock {
                                    kind: "dequeue".into(),
                                    text: text.to_string(),
                                    tool: None,
                                    tool_id: None,
                                }],
                                queued: None,
                            });
                        }
                    }
                    continue;
                }
                if op == Some("enqueue") {
                    if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                        // The queue carries the HARNESS too: task-notifications and system
                        // notices are enqueued exactly like operator messages (2026-08-28, a
                        // build-completion notice rendered as "YOU" hours after this branch
                        // was added). Same filter as every other user-shaped row.
                        if !text.trim().is_empty() && !is_harness_injection(text) {
                            turns.push(ChatTurn {
                                role: "user".into(),
                                blocks: vec![ChatBlock {
                                    kind: "text".into(),
                                    text: text.to_string(),
                                    tool: None,
                                    tool_id: None,
                                }],
                                queued: Some(true),
                            });
                        }
                    }
                }
                continue;
            }
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
                meta.guard.push(tokens);
                meta.context = chat_context(meta.guard.report(), context_window);
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
                    queued: None,
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
            queued: None,
        });
    }
    ChatSnapshot {
        turns,
        results,
        total,
        meta,
        receipt_texts,
    }
}

fn read_chat_snapshot(project: &str, after: usize, session_id: Option<&str>) -> Result<ChatSnapshot, String> {
    let path = match session_id {
        Some(id) => sessions::claude_transcript_path(project, id)?,
        None => {
            let sid = orch_session_id(project)
                .ok_or_else(|| "no orchestrator session for this project yet".to_string())?;
            orchestrator_transcript_path(project, &sid)?
        }
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => {
            return Ok(ChatSnapshot {
                turns: Vec::new(),
                results: Vec::new(),
                total: 0,
                meta: ChatMeta::default(),
                receipt_texts: Vec::new(),
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
fn orchestrator_chat(project: String, after: usize, session_id: Option<String>) -> Result<String, String> {
    let snap = read_chat_snapshot(&project, after, session_id.as_deref())?;
    serde_json::to_string(&(
        snap.turns,
        snap.results,
        snap.total,
        snap.meta,
        snap.receipt_texts,
    ))
    .map_err(|e| e.to_string())
}

static CHAT_WATCHERS: std::sync::Mutex<Option<std::collections::HashMap<String, Arc<AtomicBool>>>> =
    std::sync::Mutex::new(None);

static FILE_WATCHERS: std::sync::Mutex<Option<std::collections::HashMap<String, Arc<AtomicBool>>>> =
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

fn chat_watcher_key(project: &str, session_id: Option<&str>) -> String {
    format!("{project}:{}", session_id.unwrap_or("orchestrator"))
}

fn forget_chat_watcher(key: &str, stop: &Arc<AtomicBool>) {
    let mut g = CHAT_WATCHERS.lock().unwrap();
    if let Some(map) = g.as_mut() {
        if map.get(key).is_some_and(|live| Arc::ptr_eq(live, stop)) {
            map.remove(key);
        }
    }
}

fn spawn_chat_watcher(
    window: tauri::Window,
    project: String,
    initial_session_id: String,
    initial_path: PathBuf,
    pinned: bool,
    watcher_key: String,
    mut tail: TranscriptTail,
    mut meta: ChatMeta,
    stop: Arc<AtomicBool>,
) {
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        let mut session_id = initial_session_id;
        let mut path = Some(initial_path);
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }

            if !pinned {
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
                            receipt_texts: snap.receipt_texts,
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
        forget_chat_watcher(&watcher_key, &stop);
    });
}

/// Re-query the providers NOW, through their owner (SYSTEM-CONTRACT §4: balances belong to
/// lib/balances.mjs → the local hub snapshot; the app never calls a provider itself). The CLI
/// run fetches every configured provider and dual-pushes the snapshot; the strip re-reads it
/// on completion. Without this, the footer only moved when a session started — the operator
/// sat at a real 44% while the bar said 38% ("unless it's live or semi-live, it's useless").
#[tauri::command]
fn balances_refresh() -> Result<(), String> {
    let out = std::process::Command::new("trantor")
        .args(["balances", "--json"])
        .env("PATH", terminal_path())
        .output()
        .map_err(|e| format!("trantor balances: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
struct OrchStatusPayload {
    project: String,
    pane: String,
    status: String,
}

/// Push the orchestrator's lifecycle state instead of polling for it (Phase 3).
///
/// Replaces the 3-second `orchestrator_status` poll — which spawned a `herdr agent list`
/// subprocess forever, per open chat — with one per-pane `pane.agent_status_changed`
/// subscription. The stream's quiet read-timeout tick doubles as the health loop: it
/// re-checks the pane mapping (a `trantor open` can mint a new pane) and re-seeds the
/// status via one socket query, healing any missed frame. Reconnects with a short pause
/// when herdr drops the stream — documented behavior across server replacement.
fn spawn_status_watcher(window: tauri::Window, project: String, stop: Arc<AtomicBool>) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut last = String::new();
        let emit = |status: &str, pane: &str, last: &mut String| -> bool {
            if *last == status {
                return true;
            }
            *last = status.to_string();
            window
                .emit(
                    "orch-status",
                    OrchStatusPayload {
                        project: project.clone(),
                        pane: pane.to_string(),
                        status: status.to_string(),
                    },
                )
                .is_ok()
        };
        let orch_pane = |project: &str| -> Option<String> {
            let rows = std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt"))
                .unwrap_or_default();
            orch_pane_from_rows(&rows, project)
        };
        let nap = |stop: &AtomicBool, ticks: u32| -> bool {
            for _ in 0..ticks {
                if stop.load(Ordering::SeqCst) {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            true
        };
        while !stop.load(Ordering::SeqCst) {
            let Some(pane) = orch_pane(&project) else {
                if !emit("none", "", &mut last) {
                    return;
                }
                if !nap(&stop, 10) {
                    return;
                }
                continue;
            };
            let seeded = herdr::agent_status(&pane).unwrap_or_else(|| "unknown".to_string());
            if !emit(&seeded, &pane, &mut last) {
                return;
            }
            match herdr::subscribe_status(&pane, Duration::from_secs(15)) {
                Ok(mut stream) => loop {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    match stream.next_line() {
                        Ok(Some(line)) => {
                            if let Some(st) = herdr::status_from_frame(&line, &pane) {
                                if !emit(&st, &pane, &mut last) {
                                    return;
                                }
                            }
                        }
                        Ok(None) => {
                            // Quiet tick: is this still the orch pane, and did we miss a frame?
                            if orch_pane(&project).as_deref() != Some(pane.as_str()) {
                                break;
                            }
                            if let Some(st) = herdr::agent_status(&pane) {
                                if !emit(&st, &pane, &mut last) {
                                    return;
                                }
                            }
                        }
                        Err(_) => break,
                    }
                },
                Err(_) => {
                    if !nap(&stop, 6) {
                        return;
                    }
                }
            }
        }
    });
}

#[tauri::command]
fn chat_watch(window: tauri::Window, project: String, session_id: Option<String>) -> Result<u64, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    let pinned = session_id.is_some();
    let sid = match session_id.as_deref() {
        Some(id) => id.to_string(),
        None => orch_session_id(&project)
            .ok_or_else(|| "no orchestrator session for this project yet".to_string())?,
    };
    let path = match session_id.as_deref() {
        Some(id) => sessions::claude_transcript_path(&project, id)?,
        None => orchestrator_transcript_path(&project, &sid)?,
    };
    let (tail, current, meta) = seed_tail(&path);
    let stop = Arc::new(AtomicBool::new(false));
    let watcher_key = chat_watcher_key(&project, session_id.as_deref());

    {
        let mut g = CHAT_WATCHERS.lock().unwrap();
        let map = g.get_or_insert_with(std::collections::HashMap::new);
        if map.contains_key(&watcher_key) {
            return Ok(current);
        }
        map.insert(watcher_key.clone(), Arc::clone(&stop));
    }

    if !pinned {
        spawn_status_watcher(window.clone(), project.clone(), Arc::clone(&stop));
    }
    spawn_chat_watcher(window, project, sid, path, pinned, watcher_key, tail, meta, stop);
    Ok(current)
}

#[tauri::command]
fn chat_unwatch(project: String, session_id: Option<String>) {
    let project = project.trim();
    if project.is_empty() {
        return;
    }
    let key = chat_watcher_key(project, session_id.as_deref());
    let stop = {
        let mut g = CHAT_WATCHERS.lock().unwrap();
        g.as_mut().and_then(|map| map.remove(&key))
    };
    if let Some(stop) = stop {
        stop.store(true, Ordering::SeqCst);
    }
}

fn forget_file_watcher(project: &str, stop: &Arc<AtomicBool>) {
    let mut g = FILE_WATCHERS.lock().unwrap();
    if let Some(map) = g.as_mut() {
        if let Some(existing) = map.get(project) {
            if Arc::ptr_eq(existing, stop) {
                map.remove(project);
            }
        }
    }
}

fn is_ignored(path: &Path, ignore_list: &[&str]) -> bool {
    path.components().any(|c| ignore_list.contains(&c.as_os_str().to_string_lossy().as_ref()))
}

#[tauri::command]
fn file_watch(window: tauri::Window, project: String) -> Result<(), String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    let root = project_dir(&project).ok_or_else(|| format!("no local checkout for {project}"))?;

    {
        let g = FILE_WATCHERS.lock().unwrap();
        if let Some(map) = g.as_ref() {
            if map.contains_key(&project) {
                return Ok(());
            }
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);

    {
        let mut g = FILE_WATCHERS.lock().unwrap();
        let map = g.get_or_insert_with(std::collections::HashMap::new);
        map.insert(project.clone(), Arc::clone(&stop));
    }

    let (tx, rx) = std::sync::mpsc::channel();

    let mut watcher = notify::recommended_watcher(
        move |res| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        },
    )
    .map_err(|e| format!("failed to create watcher: {e}"))?;

    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {project}: {e}"))?;

    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let mut batch: Vec<String> = Vec::new();
        let mut last_emit = Instant::now();
        let ignore_list = TREE_SKIP;

        loop {
            if stop_clone.load(Ordering::SeqCst) {
                break;
            }

            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(event) => {
                    for path in event.paths {
                        let rel = path.strip_prefix(&root).unwrap_or(&path);
                        let rel_str = rel.to_string_lossy().to_string();
                        if !rel_str.is_empty() && !is_ignored(rel, ignore_list) {
                            batch.push(rel_str);
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }

            if last_emit.elapsed() >= Duration::from_millis(200) && !batch.is_empty() {
                let paths = std::mem::take(&mut batch);
                last_emit = Instant::now();
                let payload = serde_json::json!({ "project": project, "paths": paths });
                if window.emit("file-changed", payload).is_err() {
                    break;
                }
            }
        }

        if !batch.is_empty() {
            let payload = serde_json::json!({ "project": project, "paths": batch });
            let _ = window.emit("file-changed", payload);
        }

        stop_clone.store(true, Ordering::SeqCst);
        forget_file_watcher(&project, &stop_clone);
    });

    Ok(())
}

#[tauri::command]
fn file_unwatch(project: String) {
    let project = project.trim();
    if project.is_empty() {
        return;
    }
    let stop = {
        let mut g = FILE_WATCHERS.lock().unwrap();
        g.as_mut().and_then(|map| map.remove(project))
    };
    if let Some(stop) = stop {
        stop.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn ghost_complete(prefix: String, suffix: String, path: String) -> Result<String, String> {
    let prompt = format!(
        "Complete the following code snippet. Return ONLY the completion text, nothing else.\n\nPrefix:\n{}\n\nSuffix:\n{}\n\nFile: {}",
        prefix, suffix, path
    );

    let scrooge = std::env::var("SCROOGE_BIN")
        .unwrap_or_else(|_| "scrooge".to_string());

    let output = std::process::Command::new(&scrooge)
        .args(["-t", "code", "--difficulty", "easy", "--json", "--max-tokens", "64"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("scrooge failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("scrooge exited {}: {stderr}", output.status));
    }

    let stdout = String::from_utf8(output.stdout).map_err(|e| format!("scrooge output not utf8: {e}"))?;
    let result: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("scrooge output not json: {e}"))?;

    let completion = result.get("result")
        .or_else(|| result.get("completion"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Ok(completion.to_string())
}

fn orch_pane_from_rows(raw: &str, project: &str) -> Option<String> {
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
fn orchestrator_status(project: String) -> Result<String, String> {
    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let pane = match orch_pane_from_rows(&rows, &project) {
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

/// Deliver the operator's message to the agent in a pane — through herdr's agent surface,
/// never as keystrokes.
///
/// This command spent August 2026 as hand-rolled terminal typing and collected the scars to
/// prove it (bracketed-paste wrapping after newlines submitted fragments; an esc-esc-esc input
/// clear that interrupted live turns and was reverted the same day). `agent.prompt` makes all
/// of that herdr's job: it honors the pane's live paste mode, encodes Enter itself, refuses a
/// blocked agent BEFORE any bytes land, and reports a stall instead of typing into the void.
/// Delivery TRUTH is unchanged: the transcript receipt decides what the operator is told —
/// this call's outcome only shapes the fast-path error states.
#[tauri::command]
fn pane_send(target: String, text: String) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("no pane".into());
    }
    match herdr::prompt(&target, &text)? {
        herdr::PromptOutcome::Delivered => Ok(()),
        herdr::PromptOutcome::Blocked => Err(
            "The agent is waiting on an approval or question in its terminal — answer it there \
             (Terminal tray), then send again. Nothing was typed."
                .into(),
        ),
        herdr::PromptOutcome::NotReady => {
            Err("The agent is still starting up — try again in a moment. Nothing was typed.".into())
        }
        herdr::PromptOutcome::Stalled => Err(
            "The send didn't register with the agent — no lifecycle change was observed. \
             Try again."
                .into(),
        ),
        herdr::PromptOutcome::NoAgent => {
            Err("No agent is running in this pane — reopen the session first.".into())
        }
    }
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

/// Save an edit, PLAINLY.
///
/// The v3 Code lens (#5809) follows Orca's save anatomy (RESEARCH-orca-renderer.md §6.2): a
/// save is a file write and nothing else — no staging, no commit. Dirty work stays visible in
/// the Changes view until an explicit stage/commit, so the record of who wrote what is made
/// when the operator commits, not smuggled in by a keystroke. The seat-working guard stays: a
/// file an agent is part way through writing must not take a concurrent human write.
#[tauri::command]
fn file_write_plain(
    project: String,
    path: String,
    seat: Option<String>,
    text: String,
) -> Result<(), String> {
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
    Ok(())
}

/// Create a new file at `path` with the given `text`. Parent directories are
/// created automatically. The path must stay inside the project root.
#[tauri::command]
fn create_file(
    project: String,
    path: String,
    seat: Option<String>,
    text: String,
) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    if path.contains("..") || path.starts_with('/') || path.starts_with(".git/") || path == ".git" {
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
    if !full.starts_with(&root) {
        return Err("path escapes the project".into());
    }
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create parent directories: {e}"))?;
    }
    std::fs::write(&full, text).map_err(|e| format!("cannot create {path}: {e}"))?;
    let add = std::process::Command::new("git")
        .args(["add", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git add failed: {e}"))?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    let msg = format!("create {path} in the app");
    let commit = std::process::Command::new("git")
        .args(["commit", "-q", "-m", &msg, "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git commit failed: {e}"))?;
    if !commit.status.success() {
        let err = String::from_utf8_lossy(&commit.stdout).to_string()
            + &String::from_utf8_lossy(&commit.stderr);
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

/// Delete the file at `path`. The path must stay inside the project root.
#[tauri::command]
fn delete_file(project: String, path: String, seat: Option<String>) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    if path.contains("..") || path.starts_with('/') || path.starts_with(".git/") || path == ".git" {
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
    if !full.starts_with(&root) {
        return Err("path escapes the project".into());
    }
    if !full.is_file() {
        return Err("that file does not exist".into());
    }
    std::fs::remove_file(&full).map_err(|e| format!("cannot delete {path}: {e}"))?;
    let add = std::process::Command::new("git")
        .args(["add", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git add failed: {e}"))?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    let msg = format!("delete {path} in the app");
    let commit = std::process::Command::new("git")
        .args(["commit", "-q", "-m", &msg, "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git commit failed: {e}"))?;
    if !commit.status.success() {
        let err = String::from_utf8_lossy(&commit.stdout).to_string()
            + &String::from_utf8_lossy(&commit.stderr);
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

/// Rename (or move) a file from `old_path` to `new_path`. Both paths must stay
/// inside the project root and must be in the same directory.
#[tauri::command]
fn rename_file(
    project: String,
    old_path: String,
    new_path: String,
    seat: Option<String>,
) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    if old_path.contains("..") || old_path.starts_with('/')
        || old_path.starts_with(".git/") || old_path == ".git"
        || new_path.contains("..") || new_path.starts_with('/')
        || new_path.starts_with(".git/") || new_path == ".git"
    {
        return Err("path escapes the project".into());
    }
    if let Some(agent) = seat.as_deref() {
        if seat_state(agent.to_string())? == "working" {
            return Err(format!(
                "{agent} is working in this worktree right now — edit it once the seat lands"
            ));
        }
    }
    let old_full = root.join(&old_path);
    let new_full = root.join(&new_path);
    if !old_full.starts_with(&root) || !new_full.starts_with(&root) {
        return Err("path escapes the project".into());
    }
    if !old_full.is_file() {
        return Err("the source file does not exist".into());
    }
    if new_full.exists() {
        return Err("the destination already exists".into());
    }
    if let Some(new_parent) = new_full.parent() {
        std::fs::create_dir_all(new_parent)
            .map_err(|e| format!("cannot create parent directories: {e}"))?;
    }
    std::fs::rename(&old_full, &new_full)
        .map_err(|e| format!("cannot rename {old_path} to {new_path}: {e}"))?;
    let add_old = std::process::Command::new("git")
        .args(["add", "--", &old_path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git add failed: {e}"))?;
    if !add_old.status.success() {
        return Err(String::from_utf8_lossy(&add_old.stderr).trim().to_string());
    }
    let add_new = std::process::Command::new("git")
        .args(["add", "--", &new_path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git add failed: {e}"))?;
    if !add_new.status.success() {
        return Err(String::from_utf8_lossy(&add_new.stderr).trim().to_string());
    }
    let msg = format!("rename {old_path} to {new_path} in the app");
    let commit = std::process::Command::new("git")
        .args(["commit", "-q", "-m", &msg, "--", &old_path, "--", &new_path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git commit failed: {e}"))?;
    if !commit.status.success() {
        let err = String::from_utf8_lossy(&commit.stdout).to_string()
            + &String::from_utf8_lossy(&commit.stderr);
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
    // The CLI owns the json AND the validation: the dial/value whitelist lives in one place
    // (bin/autonomy.mjs + lib/autonomy.mjs), and a parallel copy here would drift the first time
    // either side changes — exactly what happened when the `baton` dial landed (the Rust list was
    // stale for a week before this comment was written). An unknown dial or value makes the CLI
    // exit non-zero with a specific message, which is surfaced verbatim; nothing unvalidated ever
    // reaches the autonomy.json file because the CLI is the only writer of it.
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

fn policy_project_arg(project: &str) -> Result<String, String> {
    let p = project.trim();
    if p.is_empty() {
        return Err("project is required".into());
    }
    if p.chars().any(|c| c.is_control()) {
        return Err("project contains a control character".into());
    }
    Ok(p.to_string())
}

fn policy_projects_arg(projects: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for p in projects.iter().take(4) {
        let p = policy_project_arg(p)?;
        if !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    }
    if out.len() < 2 {
        return Err("at least two projects are required".into());
    }
    Ok(out)
}

fn trantor_policy_args(
    cmd: &str,
    projects: &[String],
    level: Option<u8>,
    reason: Option<&str>,
) -> Result<Vec<String>, String> {
    match cmd {
        "set" => {
            let p = projects
                .first()
                .ok_or_else(|| "project is required".to_string())?;
            let level = level.ok_or_else(|| "level is required".to_string())?;
            if !(1..=4).contains(&level) {
                return Err("level must be 1-4".into());
            }
            Ok(vec![
                "policy".into(),
                "set".into(),
                policy_project_arg(p)?,
                level.to_string(),
            ])
        }
        "link" => {
            let ps = policy_projects_arg(projects)?;
            let reason = reason.unwrap_or("").trim();
            if reason.is_empty() {
                return Err("reason is required".into());
            }
            let mut args = vec!["policy".into(), "link".into()];
            args.extend(ps);
            args.push("--reason".into());
            args.push(reason.to_string());
            Ok(args)
        }
        "unlink" => {
            let ps = policy_projects_arg(projects)?;
            let mut args = vec!["policy".into(), "unlink".into()];
            args.extend(ps);
            Ok(args)
        }
        _ => Err("unknown policy command".into()),
    }
}

async fn trantor_cli(args: Vec<String>, label: &str) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("trantor");
    cmd.args(&args).env("PATH", terminal_path());
    let (stdout, stderr) = run_command_output(cmd, label).await?;
    if stdout.is_empty() {
        Ok(stderr)
    } else {
        Ok(stdout)
    }
}

#[tauri::command]
async fn duty_start() -> Result<String, String> {
    trantor_cli(vec!["duty".into(), "up".into()], "trantor duty up").await
}

#[tauri::command]
async fn duty_stop() -> Result<String, String> {
    trantor_cli(vec!["duty".into(), "down".into()], "trantor duty down").await
}

#[tauri::command]
async fn duty_log_path() -> Result<String, String> {
    Ok(desktop_bus_dir()
        .join("duty.log")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
async fn policy_set_level(project: String, level: u8) -> Result<String, String> {
    trantor_cli(
        trantor_policy_args("set", &[project], Some(level), None)?,
        "trantor policy set",
    )
    .await
}

#[tauri::command]
async fn policy_link_projects(projects: Vec<String>, reason: String) -> Result<String, String> {
    trantor_cli(
        trantor_policy_args("link", &projects, None, Some(&reason))?,
        "trantor policy link",
    )
    .await
}

#[tauri::command]
async fn policy_unlink_projects(projects: Vec<String>) -> Result<String, String> {
    trantor_cli(
        trantor_policy_args("unlink", &projects, None, None)?,
        "trantor policy unlink",
    )
    .await
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct TranscriptCandidate {
    session_id: String,
    active_ago_sec: u64,
    transcript: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ProjectSessionRow {
    kind: String,
    pid: Option<u32>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    state: Option<String>,
    #[serde(rename = "activeAgoSec")]
    active_ago_sec: Option<u64>,
    transcript: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ProjectSessionsPayload {
    sessions: Vec<ProjectSessionRow>,
}

fn orch_session_id_from_rows(raw: &str, project: &str) -> Option<String> {
    raw.lines()
        .filter_map(|line| {
            let mut it = line.split('\t');
            if it.next()?.trim() != project {
                return None;
            }
            let sid = it.next()?.trim();
            if sid.is_empty() {
                None
            } else {
                Some(sid.to_string())
            }
        })
        .next_back()
}

fn pane_state_from_agent_list(raw: &str, pane: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    for a in v
        .get("result")
        .and_then(|r| r.get("agents"))
        .and_then(|a| a.as_array())?
    {
        if a.get("pane_id").and_then(|p| p.as_str()) == Some(pane) {
            return Some(
                a.get("agent_status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
            );
        }
    }
    None
}

fn parse_lsof_pid_cwds(raw: &str) -> Vec<(u32, String)> {
    let mut pid: Option<u32> = None;
    let mut out = Vec::new();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.trim().parse::<u32>().ok();
        } else if let (Some(rest), Some(current_pid)) = (line.strip_prefix('n'), pid) {
            out.push((current_pid, rest.to_string()));
        }
    }
    out
}

fn parse_crew_runner_pids(raw: &str, project: &str) -> Vec<u32> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next().and_then(|p| p.parse::<u32>().ok()) else {
            continue;
        };
        let Some(dir) = line.split_whitespace().last() else {
            continue;
        };
        if std::path::Path::new(dir)
            .file_name()
            .and_then(|n| n.to_str())
            == Some(project)
        {
            out.push(pid);
        }
    }
    out.sort();
    out.dedup();
    out
}

fn transcript_dir_for_project_dir(dir: &Path) -> PathBuf {
    let slug: String = dir
        .to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join(".claude/projects").join(slug)
}

fn recent_transcript_candidates(dir: &Path) -> Vec<TranscriptCandidate> {
    const RECENT: Duration = Duration::from_secs(60 * 60);
    let tdir = transcript_dir_for_project_dir(dir);
    let now = SystemTime::now();
    let Ok(entries) = std::fs::read_dir(&tdir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        let Ok(age) = now.duration_since(mtime) else {
            continue;
        };
        if age > RECENT {
            continue;
        }
        let Some(session_id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
        else {
            continue;
        };
        out.push(TranscriptCandidate {
            session_id,
            active_ago_sec: age.as_secs(),
            transcript: path.to_string_lossy().to_string(),
        });
    }
    out.sort_by(|a, b| a.active_ago_sec.cmp(&b.active_ago_sec));
    out
}

fn project_sessions_json(
    project: &str,
    crew_rows: &str,
    orch_rows: &str,
    agent_list: &str,
    pane_process_info: Option<&str>,
    terminal_pids: Vec<u32>,
    transcripts: Vec<TranscriptCandidate>,
    seat_pids: Vec<u32>,
) -> String {
    let pane = orch_pane_from_rows(crew_rows, project);
    let pane_pid = pane_process_info.and_then(foreground_pid_from_process_info);
    let mut sessions = Vec::new();

    if let Some(pane_id) = pane {
        sessions.push(ProjectSessionRow {
            kind: "pane".into(),
            pid: pane_pid,
            session_id: orch_session_id_from_rows(orch_rows, project),
            state: pane_state_from_agent_list(agent_list, &pane_id)
                .or_else(|| Some("unknown".into())),
            active_ago_sec: None,
            transcript: None,
        });
    }

    let mut terminal_pids: Vec<u32> = terminal_pids
        .into_iter()
        .filter(|pid| Some(*pid) != pane_pid)
        .collect();
    terminal_pids.sort();
    terminal_pids.dedup();
    if terminal_pids.is_empty() {
        // A recent JSONL proves a conversation exists on disk, not that a Terminal session is
        // running now. Visibility/takeover V1 is process truth first, so disk-only transcripts do
        // not become terminal rows.
    } else if transcripts.is_empty() {
        for pid in terminal_pids {
            sessions.push(ProjectSessionRow {
                kind: "terminal".into(),
                pid: Some(pid),
                session_id: None,
                state: None,
                active_ago_sec: None,
                transcript: None,
            });
        }
    } else {
        for (idx, c) in transcripts.into_iter().enumerate() {
            sessions.push(ProjectSessionRow {
                kind: "terminal".into(),
                pid: terminal_pids
                    .get(idx)
                    .copied()
                    .or_else(|| terminal_pids.first().copied()),
                session_id: Some(c.session_id),
                state: None,
                active_ago_sec: Some(c.active_ago_sec),
                transcript: Some(c.transcript),
            });
        }
    }

    for pid in seat_pids {
        sessions.push(ProjectSessionRow {
            kind: "seat".into(),
            pid: Some(pid),
            session_id: None,
            state: None,
            active_ago_sec: None,
            transcript: None,
        });
    }

    serde_json::to_string(&ProjectSessionsPayload { sessions })
        .unwrap_or_else(|_| "{\"sessions\":[]}".into())
}

fn shell_stdout(bin: &str, args: &[&str]) -> String {
    std::process::Command::new(bin)
        .args(args)
        .env("PATH", terminal_path())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn project_sessions(project: String) -> String {
    let project = project.trim().to_string();
    if project.is_empty() || project.contains('/') || project.contains("..") {
        return "{\"sessions\":[]}".into();
    }

    let crew_rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let orch_rows =
        std::fs::read_to_string(desktop_bus_dir().join("orch-sessions.txt")).unwrap_or_default();
    let pane = orch_pane_from_rows(&crew_rows, &project);
    let agent_list = pane
        .as_ref()
        .map(|_| shell_stdout("herdr", &["agent", "list"]))
        .unwrap_or_default();
    let pane_process_info = pane.as_ref().and_then(|pane_id| {
        let raw = shell_stdout("herdr", &["pane", "process-info", "--pane", pane_id]);
        if raw.trim().is_empty() {
            None
        } else {
            Some(raw)
        }
    });

    let dir = project_dir(&project);
    let (terminal_pids, transcripts) = if let Some(dir) = dir.as_ref() {
        let wanted = dir.to_string_lossy().to_string();
        let pids: Vec<String> = shell_stdout("/usr/bin/pgrep", &["-x", "claude"])
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        let terminal_pids = if pids.is_empty() {
            Vec::new()
        } else {
            let list = pids.join(",");
            parse_lsof_pid_cwds(&shell_stdout(
                "/usr/sbin/lsof",
                &["-a", "-d", "cwd", "-p", &list, "-Fn"],
            ))
            .into_iter()
            .filter_map(|(pid, cwd)| if cwd == wanted { Some(pid) } else { None })
            .collect()
        };
        (terminal_pids, recent_transcript_candidates(dir))
    } else {
        (Vec::new(), Vec::new())
    };
    let seat_pids = parse_crew_runner_pids(
        &shell_stdout("/usr/bin/pgrep", &["-fl", "crew-runner.mjs"]),
        &project,
    );

    project_sessions_json(
        &project,
        &crew_rows,
        &orch_rows,
        &agent_list,
        pane_process_info.as_deref(),
        terminal_pids,
        transcripts,
        seat_pids,
    )
}

// ── herdr bridge ───────────────────────────────────────────────────────────────────────────────

pub(crate) fn desktop_bus_dir() -> PathBuf {
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

const HANDOFF_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// The CLI args for a write-only handoff, plus the reason when one is known. The reason rides as
/// `--reason <value>` so it can be persisted into the handoff record's trigger; a CLI that has not
/// yet learned the flag ignores it (baton.mjs only inspects `--write-only`), so the call stays
/// forward-compatible.
fn trantor_handoff_args(reason: Option<&str>) -> Vec<&str> {
    let mut args = vec!["handoff", "--write-only"];
    if let Some(r) = reason {
        args.push("--reason");
        args.push(r);
    }
    args
}

fn trantor_reopen_args() -> [&'static str; 1] {
    ["open"]
}

fn trantor_takeover_args(project: &str) -> [&str; 3] {
    ["takeover", project, "--json"]
}

fn write_only_flag_rejected(stderr: &str) -> bool {
    stderr.contains("--write-only")
}

fn foreground_pid_from_process_info(raw: &str) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let info = v.get("result")?.get("process_info")?;
    if let Some(pid) = info
        .get("foreground_process_group_id")
        .and_then(|p| p.as_u64())
        .and_then(|p| u32::try_from(p).ok())
        .filter(|p| *p > 0)
    {
        return Some(pid);
    }
    let procs = info
        .get("foreground_processes")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    for p in &procs {
        let hay = [
            p.get("name").and_then(|s| s.as_str()).unwrap_or(""),
            p.get("argv0").and_then(|s| s.as_str()).unwrap_or(""),
            p.get("cmdline").and_then(|s| s.as_str()).unwrap_or(""),
        ]
        .join(" ")
        .to_lowercase();
        if hay.contains("claude") {
            if let Some(pid) = p
                .get("pid")
                .and_then(|p| p.as_u64())
                .and_then(|p| u32::try_from(p).ok())
            {
                return Some(pid);
            }
        }
    }
    procs
        .last()
        .and_then(|p| p.get("pid"))
        .and_then(|p| p.as_u64())
        .and_then(|p| u32::try_from(p).ok())
}

async fn run_command_output(
    mut cmd: tokio::process::Command,
    label: &str,
) -> Result<(String, String), String> {
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("{label} could not start: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok((stdout, stderr))
    } else {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(if detail.is_empty() {
            format!("{label} failed")
        } else {
            format!("{label} failed: {detail}")
        })
    }
}

fn signal_process(pid: u32, signal: &str) -> Result<(), String> {
    let status = std::process::Command::new("/bin/kill")
        .arg(format!("-{signal}"))
        .arg(pid.to_string())
        .status()
        .map_err(|e| format!("kill {signal} {pid}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kill {signal} {pid} failed"))
    }
}

fn process_alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn end_process_gracefully(pid: u32) -> Result<(), String> {
    signal_process(pid, "TERM")?;
    let deadline = Instant::now() + HANDOFF_EXIT_TIMEOUT;
    while Instant::now() < deadline {
        if !process_alive(pid) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    signal_process(pid, "KILL")?;
    Ok(())
}

/// Why a handoff was fired. A fixed list on purpose: the reason lands in the handoff record's
/// `trigger` field (via `trantor handoff --reason`), and the SUCCESSION wave's recap and
/// messaging branch on it, so a free-form string would drift into places that parse it.
const HANDOFF_REASONS: &[&str] = &["clicked", "countdown", "unattended"];

/// The one boot prompt the successor gets after the pane reopens (card #5649, failure 2: the
/// successor sat idle ~15min until the human typed). A session never runs a turn unprompted, so
/// the recap waited for a human — this is the prompt that makes it recapitulate on its own.
const KICKOFF_PROMPT: &str =
    "You have just taken over via handoff. Recap now per your instructions.";

#[tauri::command]
async fn handoff_now(project: String, reason: Option<String>) -> Result<String, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    let reason = reason.unwrap_or_else(|| "clicked".to_string());
    if !HANDOFF_REASONS.contains(&reason.as_str()) {
        return Err(format!(
            "unknown handoff reason '{reason}' — one of {}",
            HANDOFF_REASONS.join("|")
        ));
    }
    let dir = project_dir(&project).ok_or_else(|| format!("no local checkout for {project}"))?;

    let mut handoff = tokio::process::Command::new("trantor");
    handoff
        .args(trantor_handoff_args(Some(&reason)))
        .current_dir(&dir)
        .env("PATH", terminal_path());
    let (_, handoff_stderr) = run_command_output(handoff, "trantor handoff --write-only").await?;
    if write_only_flag_rejected(&handoff_stderr) {
        return Err(format!(
            "trantor handoff --write-only rejected by CLI: {handoff_stderr}"
        ));
    }

    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let pane = orch_pane_from_rows(&rows, &project)
        .ok_or_else(|| format!("no orchestrator pane recorded for {project}"))?;

    let mut info = tokio::process::Command::new("herdr");
    info.args(["pane", "process-info", "--pane", &pane])
        .env("PATH", terminal_path());
    let (process_info, _) = run_command_output(info, "herdr pane process-info").await?;
    let pid = foreground_pid_from_process_info(&process_info)
        .ok_or_else(|| format!("no foreground process for orchestrator pane {pane}"))?;
    end_process_gracefully(pid).await?;

    let mut reopen = tokio::process::Command::new("trantor");
    reopen
        .args(trantor_reopen_args())
        .current_dir(&dir)
        .env("PATH", terminal_path());
    run_command_output(reopen, "trantor open").await?;

    // KICKOFF-AFTER-REOPEN (card #5649, failure 2): ONE boot prompt over the herdr SOCKET so the
    // successor recaps the handoff unprompted. Agent text never rides the CLI (socket only), and
    // the outcome is surfaced rather than swallowed — a blocked or still-starting agent means the
    // recap is still waiting on a human, which is exactly the failure this fixes.
    match herdr::prompt(&pane, KICKOFF_PROMPT) {
        Ok(outcome) => Ok(format!(
            "handoff written · session ended · pane reopened · kickoff: {}",
            kickoff_outcome_label(&outcome)
        )),
        Err(e) => Err(format!(
            "handoff chain done, but the kickoff prompt failed (successor may sit idle): {e}"
        )),
    }
}

/// A short, operator-facing label for what became of the boot prompt. Pure + unit-tested so the
/// kickoff path has a drill without needing a live herdr socket.
fn kickoff_outcome_label(outcome: &herdr::PromptOutcome) -> &'static str {
    match outcome {
        herdr::PromptOutcome::Delivered => "prompt delivered — successor is recapping",
        herdr::PromptOutcome::Blocked => "agent blocked at a dialog — answer it in the pane",
        herdr::PromptOutcome::NotReady => "agent still starting — recap will wait",
        herdr::PromptOutcome::Stalled => "no lifecycle change observed — recap may not land",
        herdr::PromptOutcome::NoAgent => "no agent in the pane — reopen the session",
    }
}

#[tauri::command]
async fn takeover_now(project: String) -> Result<String, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    let dir = project_dir(&project).ok_or_else(|| format!("no local checkout for {project}"))?;
    let out = tokio::process::Command::new("trantor")
        .args(trantor_takeover_args(&project))
        .current_dir(&dir)
        .env("PATH", terminal_path())
        .output()
        .await
        .map_err(|e| format!("trantor takeover could not start: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(stdout)
    } else if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err("trantor takeover failed".into())
    }
}

/// Pasted-image attach (2026-09-01: the operator pasted a CleanShot screenshot into the chat
/// twice and NOTHING happened — the textarea silently swallows image DATA; only file paths ever
/// worked). The webview hands the clipboard image over as base64; this writes it to a real file
/// under ~/.agent-bus/attachments/ and returns the path, which the composer splices into the
/// draft exactly like a drop — one attach mechanism (paths), two doors (drop, paste).
#[tauri::command]
fn save_pasted_image(data_base64: String, kind: String) -> Result<String, String> {
    use base64::Engine as _;
    if data_base64.len() > 40 * 1024 * 1024 {
        return Err("pasted image is too large (>30MB decoded)".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("clipboard image did not decode: {e}"))?;
    if bytes.is_empty() {
        return Err("clipboard image was empty".into());
    }
    let ext = match kind.as_str() {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    let dir = desktop_bus_dir().join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("attachments dir: {e}"))?;
    let name = format!(
        "pasted-{}.{ext}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let path = dir.join(name);
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// #5401 — projects whose orchestrator PANE survived (a tracked orch row) while the
/// conversation inside did not (no agent registered on that pane): the reboot shape. herdr's
/// login agent restores panes, not the claude processes in them. The app offers/fires resume
/// per the project's baton dial; `trantor open` is the resume vehicle — checkout resolution,
/// handoff-beats-resume, and the wake kickoff all already live there. Queried at app LAUNCH
/// only: a session the operator deliberately /exited also leaves an agent-less pane, and a
/// continuous poll would nag about it forever (monitoring doctrine: never warn about what the
/// operator declared).
#[tauri::command]
fn orch_restorables() -> Result<Vec<String>, String> {
    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let out = std::process::Command::new("herdr")
        .args(["agent", "list"])
        .env("PATH", terminal_path())
        .output()
        .map_err(|e| format!("herdr: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim())
        .unwrap_or(serde_json::Value::Null);
    let live: std::collections::HashSet<String> = v
        .get("result")
        .and_then(|r| r.get("agents"))
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    x.get("pane_id")
                        .and_then(|p| p.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(restorables_from(&rows, &live))
}

/// The pure half of orch_restorables: orch rows whose pane hosts no live agent. A ghost row
/// (pane gone entirely) is still restorable — `trantor open` heals it and resumes from the
/// transcript. Deduped per project; row order preserved.
fn restorables_from(rows: &str, live_panes: &std::collections::HashSet<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in rows.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() == 4
            && f[1] == "orch"
            && !f[0].is_empty()
            && !live_panes.contains(f[3])
            && !out.iter().any(|p| p == f[0])
        {
            out.push(f[0].to_string());
        }
    }
    out
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

// ── git panel (#5775) ──────────────────────────────────────────────────────────────────────────
// The Review lens showed what a seat CHANGED but left every git ACTION to a terminal. These four
// commands are the panel's whole surface: one read snapshot (branch, ahead/behind, raw porcelain
// status, recent log) and three mutations (stage/unstage, commit, push) — all against the SEAT's
// worktree, the tree review is already looking at. seat_diff above stays frozen; this is
// additive on purpose and shares no mutable state with it.

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct GitStatusEntry {
    path: String,
    /// porcelain v1 X: the index state. "?" means the file is untracked.
    x: String,
    /// porcelain v1 Y: the worktree state relative to the index.
    y: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct GitLogEntry {
    sha: String,
    author: String,
    /// author date, relative ("2 hours ago") — git's own rendering, shown as-is
    when: String,
    subject: String,
}

#[derive(Debug, Serialize)]
struct GitPanel {
    branch: String,
    upstream: Option<String>,
    /// commits ahead of the upstream — or, with no upstream, ahead of the merge base with main
    /// (the seat's unlanded work). behind only exists against an upstream; without one the seat
    /// branched from main and "behind" is a claim we have not measured.
    ahead: Option<u64>,
    behind: Option<u64>,
    /// raw `git status --porcelain=v1` rows; the frontend owns bucketing into
    /// staged/unstaged/untracked because that split is presentation, not git knowledge.
    status: Vec<GitStatusEntry>,
    /// +N/−N per changed path vs HEAD (numstat) — the SCM row's change-size chip (#5811).
    /// Untracked and binary paths are absent: git counts neither, and null beats a fake zero.
    counts: Vec<SeatDiffFile>,
    log: Vec<GitLogEntry>,
}

/// The seat's worktree, validated. The same guards seat_diff applies — project and agent name a
/// path under the bus dir, so ".." or "/" in either is path traversal, not a name.
fn seat_worktree(bus: &Path, project: &str, agent: &str) -> Result<std::path::PathBuf, String> {
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
    Ok(worktree)
}

/// A mutating git command, run for real, off the caller's thread. Failure text is git's own —
/// the panel surfaces it verbatim, because "error: Your branch has no upstream" beats any
/// paraphrase we could write.
async fn git_run(dir: &Path, args: &[&str]) -> Result<(), String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("git could not start: {e}"))?;
    if out.status.success() {
        return Ok(());
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

/// The async twin of run_git_text — same failure text, but the subprocess wait happens on the
/// async runtime instead of the caller. run_git_text stays sync because the frozen seat_diff
/// path uses it; nothing here touches that path.
async fn run_git_text_io(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
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

const MERGE_BASE_BRANCHES: [&str; 4] = ["main", "master", "origin/main", "origin/master"];

/// merge_base's async twin for the git panel — same branch ladder, same "main or master first"
/// answer, without editing the sync one the frozen seat_diff path depends on.
async fn merge_base_async(dir: &Path) -> Result<String, String> {
    for branch in MERGE_BASE_BRANCHES {
        if let Ok(base) = run_git_text_io(dir, &["merge-base", "HEAD", branch]).await {
            let base = base.trim().to_string();
            if !base.is_empty() {
                return Ok(base);
            }
        }
    }
    Err("could not find a merge base with main or master".into())
}

/// Mutating the git state of a worktree an agent is actively working in loses one of the two
/// edits with no undo — the exact hazard file_write_plain already guards, for the same reason. The
/// panel is for landed or paused work; while the seat is mid-turn, every mutation is refused.
async fn git_mutation_guard(agent: &str) -> Result<(), String> {
    // seat_state shells out to herdr synchronously; park that wait on a blocking thread so the
    // async runtime stays free for everything else the app is doing.
    let agent = agent.to_string();
    let for_check = agent.clone();
    let state = tauri::async_runtime::spawn_blocking(move || seat_state(for_check))
        .await
        .map_err(|e| format!("seat state check failed: {e}"))??;
    if state == "working" {
        return Err(format!(
            "{agent} is working in this worktree right now — retry once the seat lands"
        ));
    }
    Ok(())
}

/// Pure porcelain v1 parser, `-z` flavour: NUL-separated "XY PATH" records → entries. X is the
/// index state, Y the worktree state ("?" in X means untracked). With `-z`, git emits paths raw —
/// no quoting, no escaping — so a path containing spaces, quotes, or non-ASCII bytes is never
/// corrupted by a split; and a rename/copy carries its ORIGIN path as a SECOND NUL-separated
/// field, which we consume by skipping the next record instead of inventing a bogus entry. Records
/// too short to carry XY + a path are skipped, never guessed at. No I/O — cargo-tested below.
fn parse_porcelain_v1(raw: &str) -> Vec<GitStatusEntry> {
    let mut entries = Vec::new();
    let mut records = raw.split('\0');
    while let Some(rec) = records.next() {
        if rec.len() < 4 {
            continue;
        }
        let x = rec[..1].to_string();
        let y = rec[1..2].to_string();
        let path = rec[3..].to_string();
        // Rename (R) and copy (C): the origin path is the next field, consumed here so it is not
        // misread as a record of its own.
        if x == "R" || x == "C" {
            records.next();
        }
        entries.push(GitStatusEntry { path, x, y });
    }
    entries
}

/// Pure parser for `git log --pretty=format:%h%x1f%an%x1f%ar%x1f%s`. Unit separators, not spaces
/// or pipes: a commit subject can contain either of those, and a split on the wrong byte
/// corrupts exactly the rows the operator is trying to read. Rows without all four fields are
/// skipped. No I/O — cargo-tested below.
fn parse_log_pretty(raw: &str) -> Vec<GitLogEntry> {
    let mut log = Vec::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() == 4 {
            log.push(GitLogEntry {
                sha: parts[0].to_string(),
                author: parts[1].to_string(),
                when: parts[2].to_string(),
                subject: parts[3].to_string(),
            });
        }
    }
    log
}

/// Pure parser for `git rev-list --left-right --count <upstream>...HEAD`, which answers
/// "behind<TAB>ahead". Anything unreadable becomes null — the panel renders an unknown as
/// unknown, never as zero. No I/O — cargo-tested below.
fn parse_left_right(raw: &str) -> (Option<u64>, Option<u64>) {
    let mut it = raw.split('\t');
    (
        it.next().and_then(|s| s.trim().parse().ok()),
        it.next().and_then(|s| s.trim().parse().ok()),
    )
}

/// Where a branch stands relative to its upstream, with no-upstream as an explicit STATE rather
/// than a null to special-case at every call site. A fresh seat branches with no remote, which is
/// normal, not an error — `has_upstream` selects what `ahead` describes: the real remote when
/// true, the merge base with main when false (and `behind` is then None because "behind main" is
/// a claim a seat has not measured).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct UpstreamStatus {
    has_upstream: bool,
    ahead: Option<u64>,
    behind: Option<u64>,
}

/// The narrow "no upstream" matcher. `rev-parse @{u}` is THE honest upstream probe and fails
/// exactly when none is set; that failure is a state, not a fault, so it is the ONLY error class
/// swallowed. Broad phrases like "no such branch" are deliberately NOT matched — those are real
/// failures the panel should surface rather than misread as "no upstream".
fn is_no_upstream_error(err: &str) -> bool {
    err.contains("no upstream configured for branch")
        || err.contains("HEAD does not point to a branch")
}

/// The upstream answer in one place, normalized to a state object. No upstream → `has_upstream:
/// false` with ahead measured against the merge base with main; any other git failure surfaces.
async fn upstream_state(worktree: &Path) -> Result<(Option<String>, UpstreamStatus), String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .output()
        .await
        .map_err(|e| format!("git could not start: {e}"))?;
    if out.status.success() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            // "behind<TAB>ahead" — left is the upstream-only count, right is HEAD-only.
            let counts = run_git_text_io(
                worktree,
                &["rev-list", "--left-right", "--count", &format!("{name}...HEAD")],
            )
            .await?;
            let (behind, ahead) = parse_left_right(&counts);
            return Ok((
                Some(name),
                UpstreamStatus { has_upstream: true, ahead, behind },
            ));
        }
        return Ok((None, UpstreamStatus { has_upstream: false, ahead: None, behind: None }));
    }
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    if !is_no_upstream_error(&err) {
        return Err(format!("git rev-parse @{{u}} failed: {}", err.trim()));
    }
    let ahead = match merge_base_async(worktree).await {
        Ok(base) => run_git_text_io(worktree, &["rev-list", "--count", &format!("{base}..HEAD")])
            .await?
            .trim()
            .parse()
            .ok(),
        // No upstream AND no main to measure against: say nothing rather than guess.
        Err(_) => None,
    };
    Ok((None, UpstreamStatus { has_upstream: false, ahead, behind: None }))
}

async fn git_panel_from_bus_dir(bus: &Path, project: &str, agent: &str) -> Result<GitPanel, String> {
    let worktree = seat_worktree(bus, project, agent)?;

    let branch = run_git_text_io(&worktree, &["branch", "--show-current"])
        .await?
        .trim()
        .to_string();

    let (upstream, upstream_status) = upstream_state(&worktree).await?;

    let status =
        parse_porcelain_v1(&run_git_text_io(&worktree, &["status", "--porcelain=v1", "-z"]).await?);
    let counts = parse_numstat(&run_git_text_io(&worktree, &["diff", "--numstat", "HEAD"]).await?);
    let log = parse_log_pretty(
        &run_git_text_io(
            &worktree,
            &["log", "--max-count=15", "--pretty=format:%h%x1f%an%x1f%ar%x1f%s"],
        )
        .await?,
    );

    Ok(GitPanel {
        branch,
        upstream,
        ahead: upstream_status.ahead,
        behind: upstream_status.behind,
        status,
        counts,
        log,
    })
}

#[tauri::command]
async fn git_panel(project: String, agent: String) -> Result<String, String> {
    serde_json::to_string(
        &git_panel_from_bus_dir(&desktop_bus_dir(), &project, &agent).await?,
    )
    .map_err(|e| e.to_string())
}

/// Prove `rel` stays inside `root`, symlinks and all — the shared path guard every git/fs handler
/// passes through. A textual "no .., no absolute" check stops the obvious escapes but not a
/// symlink: a worktree that links a directory out to somewhere else passes "no .." and then reads
/// whatever the link points at. So this RESOLVES the path for real (canonicalize follows symlinks)
/// and then checks the result is still a DESCENDANT of the canonical root — the one check a
/// symlink cannot lie its way past. Rejects empty, NUL-containing, and absolute inputs before any
/// I/O. A path whose final component does not exist (a staged-then-deleted file) is checked by its
/// nearest existing ancestor, so unstage still works on a file already gone from disk.
fn resolve_within(root: &Path, rel: &str) -> Result<(), String> {
    if rel.is_empty() || rel.contains('\0') || Path::new(rel).is_absolute() {
        return Err(format!("path is invalid: {rel}"));
    }
    // A ".." component, anywhere, is traversal — reject it before any resolution: a path whose
    // final component does not exist yet would otherwise walk its ancestors back inside root and
    // read as contained when it is not.
    if rel.split('/').any(|c| c == "..") {
        return Err(format!("path is invalid: {rel}"));
    }
    let root = std::fs::canonicalize(root).map_err(|e| format!("cannot resolve worktree: {e}"))?;
    let full = root.join(rel);
    let mut probe = full.as_path();
    let resolved = loop {
        match std::fs::canonicalize(probe) {
            Ok(p) => break p,
            Err(_) => match probe.parent() {
                Some(parent) => probe = parent,
                None => return Err(format!("path escapes the worktree: {rel}")),
            },
        }
    };
    if !resolved.starts_with(&root) {
        return Err(format!("path escapes the worktree: {rel}"));
    }
    Ok(())
}

/// Relative paths only, each proven to stay inside `root` via `resolve_within`. Git accepts
/// absolute paths and pathspecs with "..", and the panel's inputs come from a UI listing, so
/// anything odd is a bug to name, not to honor.
fn clean_git_paths(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("no paths given".into());
    }
    paths
        .iter()
        .map(|p| {
            let p = p.trim();
            resolve_within(root, p)?;
            Ok(p.to_string())
        })
        .collect()
}

#[tauri::command]
async fn git_stage(
    project: String,
    agent: String,
    paths: Vec<String>,
    unstage: bool,
) -> Result<(), String> {
    let worktree = seat_worktree(&desktop_bus_dir(), &project, &agent)?;
    git_mutation_guard(&agent).await?;
    let paths = clean_git_paths(&worktree, &paths)?;
    let mut args: Vec<&str> = if unstage {
        // `restore --staged`, not `reset -q HEAD --`: the modern spelling, and it un-stages a
        // file even before the first commit, which `reset HEAD` cannot do.
        vec!["restore", "--staged", "--"]
    } else {
        vec!["add", "--"]
    };
    args.extend(paths.iter().map(String::as_str));
    git_run(&worktree, &args).await
}

#[tauri::command]
async fn git_commit(project: String, agent: String, message: String) -> Result<String, String> {
    let worktree = seat_worktree(&desktop_bus_dir(), &project, &agent)?;
    git_mutation_guard(&agent).await?;
    let msg = message.trim();
    if msg.is_empty() {
        return Err("commit message is empty".into());
    }
    // Commits what is STAGED, nothing more — the panel's staging list is the whole contract, and
    // a surprise `git add -A` under a human's finger is how unrelated seat work gets swept in.
    git_run(&worktree, &["commit", "-q", "-m", msg]).await?;
    run_git_text_io(&worktree, &["rev-parse", "--short", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
}

#[tauri::command]
async fn git_push(project: String, agent: String) -> Result<String, String> {
    let worktree = seat_worktree(&desktop_bus_dir(), &project, &agent)?;
    git_mutation_guard(&agent).await?;
    let branch = run_git_text_io(&worktree, &["branch", "--show-current"])
        .await?
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err("detached HEAD — there is no branch name to push".into());
    }
    // -u so the first push also SETS the upstream: every later panel read then measures
    // ahead/behind against the real thing instead of falling back to the merge base.
    git_run(&worktree, &["push", "-u", "origin", &branch]).await?;
    Ok(branch)
}

#[cfg(test)]
mod git_panel_tests {
    use super::*;

    #[test]
    fn porcelain_reads_staged_unstaged_and_untracked_rows() {
        let rows = parse_porcelain_v1(
            "M  staged-only.ts\0 M worktree-only.ts\0MM both.ts\0?? brand-new.ts\0A  staged-new.ts\0 D gone.ts\0",
        );
        assert_eq!(
            rows,
            vec![
                GitStatusEntry { path: "staged-only.ts".into(), x: "M".into(), y: " ".into() },
                GitStatusEntry { path: "worktree-only.ts".into(), x: " ".into(), y: "M".into() },
                GitStatusEntry { path: "both.ts".into(), x: "M".into(), y: "M".into() },
                GitStatusEntry { path: "brand-new.ts".into(), x: "?".into(), y: "?".into() },
                GitStatusEntry { path: "staged-new.ts".into(), x: "A".into(), y: " ".into() },
                GitStatusEntry { path: "gone.ts".into(), x: " ".into(), y: "D".into() },
            ]
        );
    }

    #[test]
    fn porcelain_takes_a_renames_new_name_unquoted() {
        // -z emits the NEW path first, then the origin as a second NUL field — no " -> " and no
        // quoting, which is exactly why a path with a space survives the round trip.
        let rows = parse_porcelain_v1("R  new name.rs\0old/name.rs\0");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "new name.rs");
        assert_eq!(rows[0].x, "R");
        assert_eq!(rows[0].y, " ");
    }

    #[test]
    fn porcelain_skips_a_renames_origin_field() {
        // The origin path is a record's own NUL field; the parser must consume it, not emit it as a
        // bogus entry, and still parse the record after it.
        let rows = parse_porcelain_v1("R  new name.rs\0old/name.rs\0M  other.ts\0");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].path, "new name.rs");
        assert_eq!(rows[0].x, "R");
        assert_eq!(rows[1].path, "other.ts");
        assert_eq!(rows[1].x, "M");
    }

    #[test]
    fn porcelain_skips_rows_too_short_to_carry_a_path() {
        assert!(parse_porcelain_v1("\0ab\0abc\0").is_empty());
    }

    #[test]
    fn log_pretty_reads_unit_separated_rows_and_skips_malformed_ones() {
        let log = parse_log_pretty(
            "abc1234\x1fAda\x1f2 hours ago\x1ffix: the thing\n\
             short\x1fonly-three-fields\n\
             \n\
             1234567\x1fBob\x1f3 days ago\x1fsubject | with a pipe\x1ftrailing\n\
             5678efg\x1fCara\x1fjust now\x1fadd: panel\n",
        );
        // the 3-field row and the 5-field row are skipped, never guessed at; the empty line too
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].sha, "abc1234");
        assert_eq!(log[0].author, "Ada");
        assert_eq!(log[0].when, "2 hours ago");
        assert_eq!(log[0].subject, "fix: the thing");
        assert_eq!(log[1].sha, "5678efg");
        assert_eq!(log[1].subject, "add: panel");
    }

    #[test]
    fn left_right_counts_behind_tab_ahead_and_garbage_is_null() {
        assert_eq!(parse_left_right("0\t3\n"), (Some(0), Some(3)));
        assert_eq!(parse_left_right("2\t0"), (Some(2), Some(0)));
        assert_eq!(parse_left_right("nonsense"), (None, None));
        assert_eq!(parse_left_right(""), (None, None));
    }

    #[test]
    fn clean_git_paths_rejects_traversal_absolute_and_empty() {
        let root = std::env::temp_dir().join("git-guard-clean-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(clean_git_paths(&root, &["..".into()]).is_err());
        assert!(clean_git_paths(&root, &["a/../../b".into()]).is_err());
        assert!(clean_git_paths(&root, &["/etc/passwd".into()]).is_err());
        assert!(clean_git_paths(&root, &["  ".into()]).is_err());
        assert!(clean_git_paths(&root, &[]).is_err());
        assert_eq!(
            clean_git_paths(&root, &[" src/a.rs ".into()]).unwrap(),
            vec!["src/a.rs".to_string()]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_within_refuses_a_symlink_that_points_outside() {
        // A symlink INSIDE the worktree that points out to a sibling directory is the escape a
        // textual "no .." check cannot see: canonicalize follows the link and lands outside.
        let root = std::env::temp_dir().join("git-guard-symlink-root");
        let outside = std::env::temp_dir().join("git-guard-symlink-outside");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        assert!(resolve_within(&root, "escape/secret.txt").is_err());
        assert!(resolve_within(&root, "escape").is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn no_upstream_is_the_only_swallowed_upstream_error() {
        assert!(is_no_upstream_error("fatal: no upstream configured for branch 'seat/glm'"));
        assert!(is_no_upstream_error("fatal: HEAD does not point to a branch"));
        assert!(!is_no_upstream_error("fatal: no such branch 'foo'"));
        assert!(!is_no_upstream_error("fatal: not a git repository"));
    }

    #[test]
    fn seat_worktree_rejects_traversal_and_missing_dirs() {
        let bus = std::env::temp_dir().join("git-panel-tests-nonexistent");
        assert!(seat_worktree(&bus, "..", "glm").is_err());
        assert!(seat_worktree(&bus, "trantor", "a/b").is_err());
        assert!(seat_worktree(&bus, "", "glm").is_err());
        assert!(seat_worktree(&bus, "trantor", "glm").is_err());
    }
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
/// Seconds since the epoch as text; the panic hook must not pull in a date crate or allocate much.
fn chrono_free_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

pub fn run() {
    // A panic on the main thread inside AppKit's sendEvent cannot unwind and aborts the app; the
    // crash report then shows only the abort, never the message (card #5917, twice on 2026-09-01).
    // This hook writes the message and location to a file BEFORE the abort, so the next crash
    // names itself. It changes nothing about how the panic proceeds.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let path = desktop_bus_dir().join("app-panics.log");
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_string());
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        let line = format!(
            "{} thread={:?} {} at {}\n",
            chrono_free_now(),
            std::thread::current().name().unwrap_or("?"),
            msg,
            loc
        );
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
        default_hook(info);
    }));
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
            project_sessions,
            herdr_pane_read,
            herdr_seats,
            seat_diff,
            git_panel,
            git_stage,
            git_commit,
            git_push,
            project_files,
            search_files,
            read_file,
            file_stat,
            file_diff,
            read_file_at_head,
            seat_state,
            sessions::sessions_list,
            sessions::session_transcript,
            orchestrator_chat,
            balances_refresh,
            chat_watch,
            chat_unwatch,
            file_watch,
            file_unwatch,
            ghost_complete,
            pane_send,
            pane_keys,
            orchestrator_status,
            handoff_now,
            takeover_now,
            orch_restorables,
            save_pasted_image,
            file_write_plain,
            project_changes,
            app_log,
            create_file,
            delete_file,
            rename_file,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_stop_project,
            autonomy_get,
            autonomy_set,
            duty_start,
            duty_stop,
            duty_log_path,
            policy_set_level,
            policy_link_projects,
            policy_unlink_projects,
            app_update_check,
            app_update_install,
            terminal::orchestrator_open,
            terminal::term_attach,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_detach
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Language servers are children of this process; an app exit must not leave one
            // orphaned. stdin-EOF usually does it, but this is the explicit promise.
            if let tauri::RunEvent::Exit = event {
                lsp::stop_all();
            }
        });
}

#[cfg(test)]
mod context_guard_tests {
    use super::*;

    /// The SHARED #5572 manifest — the mjs twin (hooks/lib/handoff.mjs guardContextTokens,
    /// drilled by test-handoff.mjs) runs the same file. One spec, two bindings, zero drift.
    const MANIFEST: &str = include_str!("../../../test/fixtures/context/manifest.json");

    #[test]
    fn the_guard_satisfies_every_manifest_case() {
        let m: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
        for case in m["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let mut g = ContextGuard::default();
            for t in case["rows"].as_array().unwrap() {
                g.push(t.as_u64().unwrap());
            }
            let got = g.report();
            let expect = case["expect"].as_u64();
            assert_eq!(
                got, expect,
                "case '{name}': got {got:?}, manifest says {expect:?}"
            );
        }
    }

    #[test]
    fn merge_carries_the_guard_across_single_row_batches() {
        // The incident shape: the watcher delivers ONE poisoned row as its own batch.
        let window = 1_000_000;
        let mut meta = ChatMeta {
            context: chat_context(None, window),
            ..ChatMeta::default()
        };
        for tokens in [400_000u64, 884_056, 889_929] {
            let mut batch = ChatMeta {
                context: chat_context(None, window),
                ..ChatMeta::default()
            };
            batch.guard.push(tokens);
            batch.context = chat_context(batch.guard.report(), window);
            merge_chat_meta(&mut meta, batch);
        }
        let mut poison = ChatMeta {
            context: chat_context(None, window),
            ..ChatMeta::default()
        };
        poison.guard.push(70_000);
        poison.context = chat_context(poison.guard.report(), window);
        merge_chat_meta(&mut meta, poison);
        assert_eq!(
            meta.context.tokens,
            Some(889_929),
            "the gauge must not read 7% at a real 88%"
        );
    }
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
    fn handoff_command_args_are_write_only_and_same_pane() {
        assert_eq!(trantor_handoff_args(None), ["handoff", "--write-only"]);
        assert_eq!(trantor_reopen_args(), ["open"]);
        assert_eq!(
            trantor_takeover_args("trantor"),
            ["takeover", "trantor", "--json"]
        );
    }

    #[test]
    fn orch_pane_resolves_the_last_project_orch_row() {
        let rows = [
            "trantor\torch\t__orch__\tw2:old",
            "trantor\therdr\tcodex\tw2:seat",
            "other\torch\t__orch__\tw9:other",
            "trantor\torch\t__orch__\tw2:new",
            "trantor\torch\t__orch__\t ",
        ]
        .join("\n");
        assert_eq!(
            orch_pane_from_rows(&rows, "trantor").as_deref(),
            Some("w2:new")
        );
    }

    #[test]
    fn process_info_prefers_the_foreground_process_group_id() {
        let raw = serde_json::json!({
            "result": {
                "process_info": {
                    "foreground_process_group_id": 23311,
                    "foreground_processes": [
                        { "name": "node", "pid": 10 },
                        { "name": "claude.exe", "pid": 20 }
                    ]
                }
            }
        })
        .to_string();
        assert_eq!(foreground_pid_from_process_info(&raw), Some(23311));
    }

    #[test]
    fn process_info_can_fall_back_to_the_claude_process() {
        let raw = serde_json::json!({
            "result": {
                "process_info": {
                    "foreground_processes": [
                        { "name": "node", "pid": 10 },
                        { "argv0": "claude", "pid": 20 },
                        { "name": "helper", "pid": 30 }
                    ]
                }
            }
        })
        .to_string();
        assert_eq!(foreground_pid_from_process_info(&raw), Some(20));
    }

    #[test]
    fn lsof_pid_cwds_keep_pid_context() {
        let raw =
            "p111\nfcwd\nn/Users/s/development/trantor\np222\nfcwd\nn/Users/s/development/other\n";
        assert_eq!(
            parse_lsof_pid_cwds(raw),
            vec![
                (111, "/Users/s/development/trantor".into()),
                (222, "/Users/s/development/other".into())
            ]
        );
    }

    #[test]
    fn crew_runner_pids_match_the_project_dir_argv() {
        let raw = "101 node /x/crew-runner.mjs codex /Users/s/.agent-bus/worktrees/trantor/codex\n102 node /x/crew-runner.mjs glm /Users/s/.agent-bus/worktrees/other/glm\n";
        assert_eq!(parse_crew_runner_pids(raw, "codex"), vec![101]);
        assert_eq!(parse_crew_runner_pids(raw, "glm"), vec![102]);
    }

    #[test]
    fn project_sessions_json_assembles_pane_terminal_and_seat_rows() {
        let crew_rows = [
            "trantor\torch\t__orch__\tpane-1",
            "trantor\therdr\tcodex\tseat-pane",
        ]
        .join("\n");
        let orch_rows = "other\told\ntrantor\tsid-pane\n";
        let agents = serde_json::json!({
            "result": { "agents": [
                { "pane_id": "pane-1", "agent_status": "idle" }
            ]}
        })
        .to_string();
        let proc = serde_json::json!({
            "result": { "process_info": { "foreground_process_group_id": 700 } }
        })
        .to_string();
        let raw = project_sessions_json(
            "trantor",
            &crew_rows,
            orch_rows,
            &agents,
            Some(&proc),
            vec![701],
            vec![TranscriptCandidate {
                session_id: "sid-term".into(),
                active_ago_sec: 42,
                transcript: "/tmp/sid-term.jsonl".into(),
            }],
            vec![990],
        );
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["sessions"][0]["kind"], "pane");
        assert_eq!(v["sessions"][0]["pid"], 700);
        assert_eq!(v["sessions"][0]["sessionId"], "sid-pane");
        assert_eq!(v["sessions"][0]["state"], "idle");
        assert_eq!(v["sessions"][1]["kind"], "terminal");
        assert_eq!(v["sessions"][1]["pid"], 701);
        assert_eq!(v["sessions"][1]["sessionId"], "sid-term");
        assert_eq!(v["sessions"][1]["activeAgoSec"], 42);
        assert_eq!(v["sessions"][1]["transcript"], "/tmp/sid-term.jsonl");
        assert_eq!(v["sessions"][2]["kind"], "seat");
        assert_eq!(v["sessions"][2]["pid"], 990);
    }

    #[test]
    fn project_sessions_json_excludes_the_pane_pid_from_terminal_sessions() {
        let crew_rows = "trantor\torch\t__orch__\tpane-1\n";
        let agents = serde_json::json!({
            "result": { "agents": [
                { "pane_id": "pane-1", "agent_status": "working" }
            ]}
        })
        .to_string();
        let proc = serde_json::json!({
            "result": { "process_info": { "foreground_process_group_id": 700 } }
        })
        .to_string();
        let raw = project_sessions_json(
            "trantor",
            crew_rows,
            "",
            &agents,
            Some(&proc),
            vec![700, 701],
            vec![TranscriptCandidate {
                session_id: "sid-term".into(),
                active_ago_sec: 12,
                transcript: "/tmp/sid-term.jsonl".into(),
            }],
            vec![],
        );
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["sessions"][0]["kind"], "pane");
        assert_eq!(v["sessions"][1]["kind"], "terminal");
        assert_eq!(v["sessions"][1]["pid"], 701);
    }

    #[test]
    fn project_sessions_json_preserves_two_recent_transcript_candidates() {
        let raw = project_sessions_json(
            "trantor",
            "",
            "",
            "",
            None,
            vec![301],
            vec![
                TranscriptCandidate {
                    session_id: "newest".into(),
                    active_ago_sec: 8,
                    transcript: "/tmp/newest.jsonl".into(),
                },
                TranscriptCandidate {
                    session_id: "older".into(),
                    active_ago_sec: 700,
                    transcript: "/tmp/older.jsonl".into(),
                },
            ],
            vec![],
        );
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(v["sessions"][0]["sessionId"], "newest");
        assert_eq!(v["sessions"][0]["pid"], 301);
        assert_eq!(v["sessions"][1]["sessionId"], "older");
        assert_eq!(v["sessions"][1]["pid"], 301);
    }

    #[test]
    fn write_only_flag_mentions_are_hard_errors() {
        assert!(write_only_flag_rejected(
            "error: unknown option '--write-only'"
        ));
        assert!(!write_only_flag_rejected("handoff saved"));
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
        assert!(is_harness_injection(
            "You just joined (your arrival was already announced on the bus). 1) relay_inbox"
        ));
        assert!(is_harness_injection(
            "NEW BUS MESSAGE for you:\n[foreman]: contract"
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
    fn a_queued_mid_turn_message_renders_as_the_operator_speaking() {
        let rows = [
            serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"sent while busy"}).to_string(),
            serde_json::json!({"type":"queue-operation","operation":"remove","content":"sent while busy"}).to_string(),
        ];
        let snap = decode_chat_lines_with_context_window(rows, 2, 0);
        // the enqueue speaks (flagged queued); the remove becomes a dequeue marker the front-end
        // reducer consumes to clear that flag — three states (sent, queued, seen) stay distinct.
        assert_eq!(snap.turns.len(), 2);
        assert_eq!(snap.turns[0].role, "user");
        assert_eq!(snap.turns[0].blocks[0].kind, "text");
        assert_eq!(snap.turns[0].blocks[0].text, "sent while busy");
        assert_eq!(snap.turns[0].queued, Some(true));
        assert_eq!(snap.turns[1].role, "system");
        assert_eq!(snap.turns[1].blocks[0].kind, "dequeue");
        assert_eq!(snap.turns[1].blocks[0].text, "sent while busy");
    }

    #[test]
    fn a_queued_harness_notification_never_wears_the_operators_face() {
        let rows = [
            serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>x</task-id>\n</task-notification>"}).to_string(),
            serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"[SYSTEM NOTIFICATION - NOT USER INPUT]\nsomething automated"}).to_string(),
            serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"real words from a person"}).to_string(),
        ];
        let snap = decode_chat_lines_with_context_window(rows, 3, 0);
        assert_eq!(snap.turns.len(), 1);
        assert_eq!(snap.turns[0].blocks[0].text, "real words from a person");
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

#[cfg(test)]
mod succession_tests {
    use super::*;

    // #5649 SUCCESSION rust: handoff_now(reason) · autonomy_set shells the CLI dial ·
    // kickoff-after-reopen boot prompt via the herdr socket. These drills cover the pure parts of
    // all three so the command wiring has a test bed without a live herdr/trantor to shell.

    #[test]
    fn handoff_reasons_are_exactly_the_three_declared_values() {
        assert_eq!(HANDOFF_REASONS, &["clicked", "countdown", "unattended"]);
    }

    #[test]
    fn handoff_args_carry_the_reason_when_present() {
        assert_eq!(
            trantor_handoff_args(Some("clicked")),
            vec!["handoff", "--write-only", "--reason", "clicked"]
        );
        assert_eq!(
            trantor_handoff_args(Some("countdown")),
            vec!["handoff", "--write-only", "--reason", "countdown"]
        );
        assert_eq!(
            trantor_handoff_args(Some("unattended")),
            vec!["handoff", "--write-only", "--reason", "unattended"]
        );
    }

    #[test]
    fn handoff_args_stay_backward_compatible_without_a_reason() {
        // The pre-#5649 call shape (frontend omitting reason) must still produce the old command.
        assert_eq!(trantor_handoff_args(None), vec!["handoff", "--write-only"]);
    }

    #[test]
    fn policy_bridge_args_are_the_cli_contract() {
        assert_eq!(
            trantor_policy_args("set", &[String::from("trantor")], Some(3), None).unwrap(),
            vec!["policy", "set", "trantor", "3"]
        );
        assert_eq!(
            trantor_policy_args(
                "link",
                &[
                    String::from("crebral-health"),
                    String::from("crebral-scribe")
                ],
                None,
                Some("shared schema")
            )
            .unwrap(),
            vec![
                "policy",
                "link",
                "crebral-health",
                "crebral-scribe",
                "--reason",
                "shared schema"
            ]
        );
        assert_eq!(
            trantor_policy_args(
                "unlink",
                &[
                    String::from("crebral-health"),
                    String::from("crebral-scribe")
                ],
                None,
                None
            )
            .unwrap(),
            vec!["policy", "unlink", "crebral-health", "crebral-scribe"]
        );
    }

    #[test]
    fn policy_bridge_rejects_unsafe_or_incomplete_args() {
        assert!(trantor_policy_args("set", &[String::from("trantor")], Some(5), None).is_err());
        assert!(trantor_policy_args("link", &[String::from("trantor")], None, Some("x")).is_err());
        assert!(trantor_policy_args(
            "link",
            &[String::from("trantor"), String::from("teams")],
            None,
            Some("")
        )
        .is_err());
        assert!(
            trantor_policy_args("set", &[String::from("bad\nproject")], Some(2), None).is_err()
        );
    }

    #[test]
    fn kickoff_prompt_is_the_fixed_recap_instruction() {
        // The one line the successor sees after the pane reopens. If this changes, the recap the
        // successor gives changes with it — so it is asserted, not assumed.
        assert_eq!(
            KICKOFF_PROMPT,
            "You have just taken over via handoff. Recap now per your instructions."
        );
    }

    #[test]
    fn every_kickoff_outcome_has_a_human_label() {
        use herdr::PromptOutcome as O;
        for o in [
            O::Delivered,
            O::Blocked,
            O::NotReady,
            O::Stalled,
            O::NoAgent,
        ] {
            let label = kickoff_outcome_label(&o);
            assert!(!label.is_empty(), "outcome {o:?} needs a label");
        }
        assert!(kickoff_outcome_label(&O::Delivered).contains("delivered"));
        assert!(kickoff_outcome_label(&O::Blocked).contains("blocked"));
        assert!(kickoff_outcome_label(&O::NotReady).contains("starting"));
        assert!(kickoff_outcome_label(&O::NoAgent).contains("no agent"));
    }

    // #5401 — the restore detector's pure half. The reboot shape: orch rows survive in
    // crew-windows.txt while herdr's agent list no longer knows their panes.
    #[test]
    fn restorables_are_orch_rows_without_a_live_agent() {
        let rows = "proj-a\torch\t__orch__\tw1:p1\n\
                    proj-a\therdrws\t__ws__\tw1\n\
                    proj-b\torch\t__orch__\tw2:p1\n\
                    proj-c\therdr\tkimi\tw3:p2\n\
                    proj-b\torch\t__orch__\tw2:p9\n";
        let live: std::collections::HashSet<String> = ["w1:p1".to_string()].into();
        // proj-a's agent is alive → not restorable. proj-b's two orch rows dedupe to one entry.
        // proj-c has only a SEAT row — seats belong to the crew, never to restore.
        assert_eq!(restorables_from(rows, &live), vec!["proj-b".to_string()]);
        // Nothing tracked, or every agent alive → nothing to restore.
        assert!(restorables_from("", &live).is_empty());
        let all_live: std::collections::HashSet<String> = [
            "w1:p1".to_string(),
            "w2:p1".to_string(),
            "w2:p9".to_string(),
        ]
        .into();
        assert!(restorables_from(rows, &all_live).is_empty());
        // A malformed row never panics and never restores.
        assert!(restorables_from("garbage-no-tabs\n\torch\t\t\n", &live).is_empty());
    }
}

#[cfg(test)]
mod file_guard_tests {
    use super::*;

    #[test]
    fn source_root_rejects_project_with_dotdot() {
        let result = source_root("bad..project", None);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "project is invalid");
    }

    #[test]
    fn source_root_rejects_project_with_slash() {
        let result = source_root("bad/project", None);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "project is invalid");
    }

    #[test]
    fn source_root_rejects_seat_with_dotdot() {
        let result = source_root("my-project", Some("bad..seat"));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "seat is invalid");
    }

    #[test]
    fn source_root_rejects_seat_with_slash() {
        let result = source_root("my-project", Some("bad/seat"));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "seat is invalid");
    }

    #[test]
    fn create_file_rejects_path_with_dotdot() {
        // We test the guard logic directly: a path containing .. must be rejected
        // before it ever reaches the filesystem. The Tauri command checks this.
        let guard = |path: &str| !path.contains("..") && !path.starts_with('/');
        assert!(guard("src/foo.ts"));
        assert!(!guard("../etc/passwd"));
        assert!(!guard("src/../etc/passwd"));
        assert!(!guard("/absolute/path"));
    }

    #[test]
    fn create_file_rejects_absolute_path() {
        let guard = |path: &str| !path.contains("..") && !path.starts_with('/');
        assert!(!guard("/etc/passwd"));
        assert!(!guard("/home/user/project/file.ts"));
    }

    #[test]
    fn delete_file_guards_against_git_dir() {
        // delete_file must refuse paths inside .git/ — deleting git internals
        // corrupts the repo and is never a legitimate operator action.
        let guard = |path: &str| {
            !path.contains("..")
                && !path.starts_with('/')
                && !path.starts_with(".git/")
                && path != ".git"
        };
        assert!(guard("src/foo.ts"));
        assert!(!guard(".git/config"));
        assert!(!guard(".git/HEAD"));
        assert!(!guard(".git"));
    }

    #[test]
    fn rename_file_guards_against_git_dir() {
        let guard = |path: &str| {
            !path.contains("..")
                && !path.starts_with('/')
                && !path.starts_with(".git/")
                && path != ".git"
        };
        assert!(guard("src/foo.ts"));
        assert!(!guard(".git/config"));
        assert!(!guard(".git/HEAD"));
    }
}

// ── project-wide change map (#5959) ───────────────────────────────────────────────────────────
// The tree and the CHANGED list show every seat's work at once, so the frontend needs ONE
// snapshot across the project checkout and every seat worktree — not one seatDiff fan-out per
// seat. One row per (seat, path): the checkout's own changes carry seat = null.

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ChangeRow {
    /// None = the project checkout itself; Some = the seat whose worktree changed.
    seat: Option<String>,
    path: String,
    /// git porcelain code, trimmed ("M", "A", "??", "D")
    status: String,
    plus: Option<u64>,
    minus: Option<u64>,
}

/// Status + numstat rows for ONE root (the checkout or a single seat worktree).
fn collect_changes_for_root(root: &Path, seat: Option<&str>) -> Vec<ChangeRow> {
    if !root.is_dir() {
        return Vec::new();
    }
    let status = git_status_map(root);
    let counts = git_numstat_vs_head(root);
    let mut rows: Vec<ChangeRow> = Vec::new();
    for (path, code) in &status {
        let (plus, minus) = match counts.get(path) {
            Some(c) => (Some(c.0), Some(c.1)),
            None => (None, None),
        };
        rows.push(ChangeRow {
            seat: seat.map(|s| s.to_string()),
            path: path.clone(),
            status: code.clone(),
            plus,
            minus,
        });
    }
    // numstat rows git status missed (e.g. staged-only renames) still deserve their counts
    for (path, (plus, minus)) in &counts {
        if !status.contains_key(path) {
            rows.push(ChangeRow {
                seat: seat.map(|s| s.to_string()),
                path: path.clone(),
                status: "M".into(),
                plus: Some(*plus),
                minus: Some(*minus),
            });
        }
    }
    rows
}

fn project_changes_sync(project: &str) -> Result<Vec<ChangeRow>, String> {
    if project.trim().is_empty()
        || project.contains("..")
        || project.contains('/')
    {
        return Err("project is invalid".into());
    }
    let dev_root = std::env::var("TRANTOR_DEV_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(format!("{}/development", std::env::var("HOME").unwrap_or_default())));
    let checkout = dev_root.join(project);
    let seats_root = desktop_bus_dir().join("worktrees").join(project);

    let mut rows = collect_changes_for_root(&checkout, None);
    if let Ok(entries) = std::fs::read_dir(&seats_root) {
        for entry in entries.flatten().filter(|e| e.path().is_dir()) {
            let seat = entry.file_name().to_string_lossy().to_string();
            rows.extend(collect_changes_for_root(&entry.path(), Some(&seat)));
        }
    }
    Ok(rows)
}

/// The frontend's diagnostic line, appended verbatim with a timestamp (#12752). Not a log for
/// humans — a trace the investigation greps. Fire-and-forget from the caller's side.
#[tauri::command]
fn app_log(line: String) -> Result<(), String> {
    let dir = desktop_bus_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app-trace.log"))
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    writeln!(f, "{ms} {line}").map_err(|e| e.to_string())
}

#[tauri::command]
fn project_changes(project: String) -> Result<String, String> {
    serde_json::to_string(&project_changes_sync(&project)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod project_changes_tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git run");
        assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    }

    /// Two seat worktrees under one project: each contributes its own rows, keyed by the seat
    /// name, with status AND numstat — the snapshot the tree's per-seat marks render from (#5959).
    #[test]
    fn two_worktrees_report_rows_per_seat_with_status_and_counts() {
        let tmp = std::env::temp_dir().join(format!("trantor-pc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let seat_a = tmp.join("a");
        let seat_b = tmp.join("b");
        std::fs::create_dir_all(&seat_a).unwrap();
        std::fs::create_dir_all(&seat_b).unwrap();

        // seat a: a committed base, then a real modification → status M with counts
        git(&seat_a, &["init", "-q", "-b", "main"]);
        std::fs::write(seat_a.join("f.txt"), "one line\n");
        git(&seat_a, &["add", "."]);
        git(&seat_a, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
        std::fs::write(seat_a.join("f.txt"), "one line\ntwo lines\n");
        // seat b: an untracked file only → status ?? with no counts (a worktree is always a
        // git checkout, so seat_b gets its own init too)
        git(&seat_b, &["init", "-q", "-b", "main"]);
        std::fs::write(seat_b.join("new.txt"), "brand new\n");

        let rows = collect_changes_for_root(&seat_a, Some("a"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].seat.as_deref(), Some("a"));
        assert_eq!(rows[0].path, "f.txt");
        assert_eq!(rows[0].status, "M");
        assert_eq!(rows[0].plus, Some(1));
        assert_eq!(rows[0].minus, Some(0));

        let rows_b = collect_changes_for_root(&seat_b, Some("b"));
        assert_eq!(rows_b.len(), 1);
        assert_eq!(rows_b[0].seat.as_deref(), Some("b"));
        assert_eq!(rows_b[0].status, "??");
        assert_eq!(rows_b[0].plus, None);

        // a non-git directory is silent, not an error
        let plain = tmp.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(collect_changes_for_root(&plain, Some("plain")).is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
