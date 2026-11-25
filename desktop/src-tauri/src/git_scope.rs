#[allow(unused_imports)]
use super::*;

// ── git scope (#13988 drill) ───────────────────────────────────────────────────────────────────
// The git panel's commands act on ONE checkout: a seat's worktree (the original surface) or the
// project's main checkout. Mode policy lives in the UI bridge; native commands resolve exactly one
// checkout and keep the seat mutation guard on every write.

/// Which checkout a git command acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GitScope {
    Seat(String),
    Project,
}

/// `scope` absent or "seat" is the seat path exactly as before (agent required); "project" is the
/// main checkout and takes no agent, so a stray seat name can never land on the wrong tree.
pub(crate) fn parse_scope(agent: Option<&str>, scope: Option<&str>) -> Result<GitScope, String> {
    match scope.map(str::trim) {
        None | Some("") | Some("seat") => Ok(GitScope::Seat(agent.unwrap_or_default().to_string())),
        Some("project") => {
            if agent.is_some_and(|a| !a.trim().is_empty()) {
                return Err("the project scope takes no agent".into());
            }
            Ok(GitScope::Project)
        }
        Some(other) => Err(format!("scope must be seat or project, not {other}")),
    }
}

/// The project's main checkout under `dev_root`, by the same lookup the file commands use
/// (checkout_for: the id a renamed checkout records wins over the directory name).
pub(crate) fn project_checkout_in(dev_root: &Path, project: &str) -> Result<std::path::PathBuf, String> {
    if project.trim().is_empty() || project.contains("..") || project.contains('/') {
        return Err("project is invalid".into());
    }
    identity::checkout_for(dev_root, project).ok_or_else(|| format!("no local checkout for {project}"))
}

pub(crate) fn scope_dir_in(
    dev_root: &Path,
    bus: &Path,
    project: &str,
    scope: &GitScope,
) -> Result<std::path::PathBuf, String> {
    match scope {
        GitScope::Seat(agent) => seat_worktree(bus, project, agent),
        GitScope::Project => project_checkout_in(dev_root, project),
    }
}

/// Resolve the directory and, for a seat, refuse while it is mid-turn. The main checkout has no
/// seat to wait on; the operator's own finger is the only writer the panel adds there.
pub(crate) async fn scope_dir_for_mutation(project: &str, scope: &GitScope) -> Result<std::path::PathBuf, String> {
    let dir = scope_dir_in(&identity::dev_root(), &desktop_bus_dir(), project, scope)?;
    if let GitScope::Seat(agent) = scope {
        git_mutation_guard(agent).await?;
    }
    Ok(dir)
}

pub(crate) fn scope_dir(project: &str, scope: &GitScope) -> Result<std::path::PathBuf, String> {
    scope_dir_in(&identity::dev_root(), &desktop_bus_dir(), project, scope)
}

pub(crate) const LOG_LIMIT_DEFAULT: u32 = 15;
const LOG_LIMIT_MAX: u32 = 200;

/// The log length a caller asked for, clamped: 15 when unset (the seat panel's long-standing
/// count), never zero, never a history-sized read on every poll.
pub(crate) fn log_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(LOG_LIMIT_DEFAULT).clamp(1, LOG_LIMIT_MAX)
}

/// Stage or unstage `paths` in `dir`, each proven to stay inside it first.
pub(crate) async fn git_stage_at(dir: &Path, paths: &[String], unstage: bool) -> Result<(), String> {
    let paths = clean_git_paths(dir, paths)?;
    let mut args: Vec<&str> = if unstage {
        // `restore --staged`, not `reset -q HEAD --`: the modern spelling, and it un-stages a
        // file even before the first commit, which `reset HEAD` cannot do.
        vec!["restore", "--staged", "--"]
    } else {
        vec!["add", "--"]
    };
    args.extend(paths.iter().map(String::as_str));
    git_run(dir, &args).await
}

/// Commit what is STAGED in `dir`, nothing more, and answer the new short sha.
pub(crate) async fn git_commit_at(dir: &Path, message: &str) -> Result<String, String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err("commit message is empty".into());
    }
    // The panel's staging list is the whole contract: a surprise `git add -A` under a human's
    // finger is how unrelated seat work gets swept in.
    git_run(dir, &["commit", "-q", "-m", msg]).await?;
    run_git_text_io(dir, &["rev-parse", "--short", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
}

// #14268: the snapshot and sync commands must agree even when the remote is not named origin.
pub(crate) async fn sync_remote(dir: &Path) -> Result<Option<String>, String> {
    let remotes = run_git_text_io(dir, &["remote"]).await?;
    let names: Vec<&str> = remotes.lines().map(str::trim).filter(|name| !name.is_empty()).collect();
    if names.is_empty() {
        return Ok(None);
    }
    let branch = run_git_text_io(dir, &["branch", "--show-current"]).await?;
    let configured = run_git_text_io(dir, &["config", "--get", &format!("branch.{}.remote", branch.trim())])
        .await.unwrap_or_default();
    let selected = names.iter().find(|name| **name == configured.trim())
        .or_else(|| names.iter().find(|name| **name == "origin"))
        .or_else(|| names.first());
    Ok(selected.map(|name| (*name).to_string()))
}

pub(crate) async fn require_sync_remote(dir: &Path) -> Result<String, String> {
    sync_remote(dir).await?.ok_or_else(|| "This repository has no remote".to_string())
}

pub(crate) fn fetch_args(remote: &str) -> [&str; 4] {
    ["fetch", "--prune", "--", remote]
}

pub(crate) fn fetch_error(stderr: &str) -> String {
    stderr.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("git fetch failed").to_string()
}

pub(crate) async fn git_fetch_at(dir: &Path) -> Result<(), String> {
    let remote = require_sync_remote(dir).await?;
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(fetch_args(&remote))
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "git fetch timed out after 30 seconds".to_string())?
        .map_err(|e| format!("git could not start: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(fetch_error(&String::from_utf8_lossy(&out.stderr)))
    }
}

#[tauri::command]
pub(crate) async fn git_fetch(
    project: String,
    agent: Option<String>,
    scope: Option<String>,
) -> Result<(), String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir(&project, &scope)?;
    git_fetch_at(&dir).await
}

/// One file a commit touched: git's name-status letter plus its numstat counts (null = binary).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitShowFile {
    pub(crate) path: String,
    pub(crate) status: String,
    pub(crate) plus: Option<u64>,
    pub(crate) minus: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitCommitShow {
    pub(crate) sha: String,
    pub(crate) files: Vec<GitShowFile>,
    pub(crate) patch: String,
    pub(crate) truncated: bool,
}

/// A commit id as the log prints it: hex only, so it can never be read as an option or a range.
pub(crate) fn valid_commit_id(sha: &str) -> bool {
    (4..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// `git show --name-status` rows ("M\tpath") joined with `--numstat` counts by path.
pub(crate) fn join_show_files(name_status: &str, numstat: &str) -> Vec<GitShowFile> {
    let counts = parse_numstat(numstat);
    name_status
        .lines()
        .filter_map(|line| {
            let (status, path) = line.split_once('\t')?;
            let path = path.trim();
            if path.is_empty() || status.trim().is_empty() {
                return None;
            }
            let n = counts.iter().find(|c| c.path == path);
            Some(GitShowFile {
                path: path.to_string(),
                status: status.trim().to_string(),
                plus: n.and_then(|c| c.plus),
                minus: n.and_then(|c| c.minus),
            })
        })
        .collect()
}

/// One commit's files and patch. Renames are split into delete + add and a merge is shown against
/// its first parent, so every row is one path and the patch always has a body to render.
pub(crate) async fn git_show_at(dir: &Path, sha: &str) -> Result<GitCommitShow, String> {
    let sha = sha.trim();
    if !valid_commit_id(sha) {
        return Err(format!("commit id is invalid: {sha}"));
    }
    let full = run_git_text_io(dir, &["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")])
        .await
        .map_err(|_| format!("no commit {sha} in this checkout"))?
        .trim()
        .to_string();
    let show = |what: &'static str| ["show", "--no-renames", "--diff-merges=first-parent", "--format=", what];
    let run = |what: &'static str| {
        let mut args = show(what).to_vec();
        args.push(full.as_str());
        args
    };
    let files = join_show_files(
        &run_git_text_io(dir, &run("--name-status")).await?,
        &run_git_text_io(dir, &run("--numstat")).await?,
    );
    let (patch, truncated) = cap_patch(run_git_text_io(dir, &run("--patch")).await?.as_bytes());
    Ok(GitCommitShow { sha: full, files, patch, truncated })
}

#[tauri::command]
pub(crate) async fn git_show(
    project: String,
    agent: Option<String>,
    scope: Option<String>,
    sha: String,
) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir(&project, &scope)?;
    serde_json::to_string(&git_show_at(&dir, &sha).await?).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "git_scope_tests.rs"]
mod git_scope_tests;
