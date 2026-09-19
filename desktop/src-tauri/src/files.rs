#[allow(unused_imports)]
use super::*;

/// One entry in the project's file tree. `status` carries git's porcelain code for the file, which
/// is the whole point of showing a tree here: a legacy developer wants to watch WHICH files the
/// agents are touching, not just that a repo exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct FileEntry {
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
pub(crate) const TREE_SKIP: &[&str] = &[
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

/// +N/−N per path vs HEAD from one `git diff --numstat HEAD` per request. Untracked and binary
/// rows map to nothing: a fake zero would read as "known small" (#5811).
pub(crate) fn git_numstat_vs_head(dir: &Path) -> std::collections::HashMap<String, (u64, u64)> {
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
pub(crate) fn git_status_map(dir: &Path) -> std::collections::HashMap<String, String> {
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

pub(crate) fn parse_status_porcelain(raw: &str) -> std::collections::HashMap<String, String> {
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
pub(crate) struct FileBody {
    text: String,
    /// set when the file was cut at the cap, so the UI can say so instead of implying it is whole
    truncated: bool,
    bytes: u64,
}

pub(crate) const FILE_VIEW_CAP: u64 = 512 * 1024;

/// A file's stat on disk, for the live viewer's polling loop. Modified time + size are the cheap
/// signal that a file changed under the operator: reading the whole body every tick is how a viewer
/// turns into a re-download loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct FileStat {
    /// modified time in milliseconds since the Unix epoch, 0 when the OS could not say
    mtime_ms: u64,
    bytes: u64,
}

#[tauri::command]
pub(crate) fn file_stat(project: String, path: String, seat: Option<String>) -> Result<String, String> {
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
pub(crate) fn read_file(project: String, path: String, seat: Option<String>) -> Result<String, String> {
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
pub(crate) fn read_file_at_head(
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
pub(crate) fn file_diff(project: String, path: String, seat: Option<String>) -> Result<String, String> {
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

/// Paths matching a query, for the composer's @-reference menu. A flat search bounded on depth
/// and count: autocomplete must reach a file three folders deep, and this runs on every keystroke.
#[tauri::command]
pub(crate) fn search_files(project: String, query: String, seat: Option<String>) -> Result<String, String> {
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
pub(crate) fn project_files(
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
