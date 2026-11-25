#[allow(unused_imports)]
use super::*;

// #14300: agents work in their own git worktrees, so source control must list the live ones as scopes.
// This file reads `git worktree list --porcelain` and answers the active ones; git_scope.rs resolves a
// picked one back to a path, only ever from this same list.

/// A worktree with no activity for this long, no lock and no fresh commit is stale noise.
pub(crate) const ACTIVE_WINDOW_SECS: u64 = 2 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct AgentWorktree {
    pub(crate) path: String,
    pub(crate) branch: Option<String>,
    pub(crate) head: String,
    pub(crate) locked: bool,
    /// "agent" | "helper" | "seat" | "other", from the path and branch patterns each launcher uses.
    pub(crate) kind: String,
    /// unix seconds: newest of the index and HEAD mtimes and the HEAD commit time.
    pub(crate) last_activity: u64,
    pub(crate) changed: u64,
    /// commits on this worktree's HEAD that the main branch does not have.
    pub(crate) ahead: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RawWorktree {
    pub(crate) path: String,
    pub(crate) head: String,
    pub(crate) branch: Option<String>,
    pub(crate) locked: bool,
}

/// `git worktree list --porcelain`: blank-line separated blocks of `worktree`, `HEAD`, `branch`, `locked`.
pub(crate) fn parse_worktree_porcelain(text: &str) -> Vec<RawWorktree> {
    let mut out: Vec<RawWorktree> = Vec::new();
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            out.push(RawWorktree { path: path.to_string(), ..RawWorktree::default() });
        } else if let Some(cur) = out.last_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                cur.head = head.to_string();
            } else if let Some(branch) = line.strip_prefix("branch ") {
                cur.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_string());
            } else if line == "locked" || line.starts_with("locked ") {
                cur.locked = true;
            }
        }
    }
    out
}

pub(crate) fn worktree_kind(path: &str, branch: Option<&str>) -> &'static str {
    let branch = branch.unwrap_or("");
    if path.contains("/.claude/worktrees/agent-") || branch.starts_with("worktree-agent-") {
        "agent"
    } else if path.contains("/scratchpad/wt-") || branch.starts_with("work/") {
        "helper"
    } else if path.contains("/.agent-bus/worktrees/") || branch.starts_with("seat/") {
        "seat"
    } else {
        "other"
    }
}

fn mtime_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

/// A linked worktree's `.git` is a file `gitdir: <repo>/.git/worktrees/<name>`; its index and HEAD live there.
fn worktree_gitdir(dir: &Path) -> std::path::PathBuf {
    let dot_git = dir.join(".git");
    if dot_git.is_dir() {
        return dot_git;
    }
    std::fs::read_to_string(&dot_git)
        .ok()
        .and_then(|t| t.trim().strip_prefix("gitdir:").map(|p| std::path::PathBuf::from(p.trim())))
        .unwrap_or(dot_git)
}

/// Read-only git: no optional locks, so listing never rewrites an agent's index under its feet.
async fn git_quiet(dir: &Path, args: &[&str]) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .await
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

async fn main_branch_ref(repo: &Path) -> Option<String> {
    for name in MERGE_BASE_BRANCHES {
        if git_quiet(repo, &["rev-parse", "--verify", "--quiet", name]).await.is_some() {
            return Some(name.to_string());
        }
    }
    None
}

async fn changed_files(dir: &Path) -> u64 {
    let raw = git_quiet(dir, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).await;
    raw.map_or(0, |r| parse_porcelain_v1(&r).len() as u64)
}

/// The repo's linked worktrees, active ones only unless `all`. `now` is injected so tests can age them.
pub(crate) async fn list_worktrees_at(repo: &Path, all: bool, now: u64) -> Result<Vec<AgentWorktree>, String> {
    let text = run_git_text_io(repo, &["worktree", "list", "--porcelain"]).await?;
    let base = main_branch_ref(repo).await;
    let mut out = Vec::new();
    for raw in parse_worktree_porcelain(&text).into_iter().skip(1) {
        let dir = std::path::PathBuf::from(&raw.path);
        if !dir.is_dir() {
            continue;
        }
        let gitdir = worktree_gitdir(&dir);
        let commit_at = git_quiet(&dir, &["log", "-1", "--format=%ct", "HEAD"])
            .await
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let touched = mtime_secs(&gitdir.join("index")).max(mtime_secs(&gitdir.join("HEAD")));
        let last_activity = touched.max(commit_at);
        let recent = |t: u64| now.saturating_sub(t) <= ACTIVE_WINDOW_SECS;
        let changed = if all || raw.locked || recent(touched) || recent(commit_at) { changed_files(&dir).await } else { 0 };
        let active = raw.locked || recent(commit_at) || (changed > 0 && recent(last_activity));
        if !all && !active {
            continue;
        }
        let ahead = match &base {
            Some(base) => git_quiet(&dir, &["rev-list", "--count", "HEAD", &format!("^{base}")])
                .await
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0),
            None => 0,
        };
        let kind = worktree_kind(&raw.path, raw.branch.as_deref()).to_string();
        out.push(AgentWorktree {
            path: raw.path, branch: raw.branch, head: raw.head, locked: raw.locked, kind, last_activity, changed, ahead,
        });
    }
    out.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    Ok(out)
}

/// A scope path is only ever one `git worktree list` reports for this repo, never the main checkout.
pub(crate) fn listed_worktree_path(repo: &Path, wanted: &str) -> Result<std::path::PathBuf, String> {
    let want = std::fs::canonicalize(wanted).map_err(|_| "that worktree no longer exists".to_string())?;
    let text = run_git_text(repo, &["worktree", "list", "--porcelain"])?;
    parse_worktree_porcelain(&text)
        .into_iter()
        .skip(1)
        .filter_map(|w| std::fs::canonicalize(&w.path).ok())
        .find(|p| *p == want)
        .ok_or_else(|| "that path is not a worktree of this project".to_string())
}

#[tauri::command]
pub(crate) async fn git_worktrees(project: String, all: Option<bool>) -> Result<String, String> {
    let repo = project_checkout_in(&identity::dev_root(), &project)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let rows = list_worktrees_at(&repo, all.unwrap_or(false), now).await?;
    serde_json::to_string(&rows).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "git_worktrees_tests.rs"]
mod git_worktrees_tests;
