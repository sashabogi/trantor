#[allow(unused_imports)]
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PullStrategy {
    FastForward,
    Merge,
    Rebase,
}

fn pull_strategy(value: Option<&str>) -> Result<PullStrategy, String> {
    match value.unwrap_or("ff") {
        "ff" => Ok(PullStrategy::FastForward),
        "merge" => Ok(PullStrategy::Merge),
        "rebase" => Ok(PullStrategy::Rebase),
        other => Err(format!("pull strategy must be ff, merge or rebase, not {other}")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitPullResult {
    pub(crate) status: String,
    pub(crate) reason: String,
}

pub(crate) async fn git_pull_at(dir: &Path, strategy: PullStrategy) -> Result<GitPullResult, String> {
    git_fetch_at(dir).await?;
    let (upstream, state) = upstream_state(dir).await?;
    let upstream = upstream.ok_or_else(|| "Pull needs an upstream branch; push this branch first".to_string())?;
    let ahead = state.ahead.unwrap_or(0);
    let behind = state.behind.unwrap_or(0);
    if ahead > 0 && behind > 0 && strategy == PullStrategy::FastForward {
        return Ok(GitPullResult {
            status: "diverged".into(),
            reason: format!("Branches diverged: {ahead} local and {behind} remote commits. Choose Merge or Rebase."),
        });
    }
    if behind == 0 {
        return Ok(GitPullResult { status: "upToDate".into(), reason: "Already up to date".into() });
    }
    match strategy {
        PullStrategy::FastForward => git_run(dir, &["merge", "--ff-only", &upstream]).await?,
        PullStrategy::Merge => git_run(dir, &["merge", "--no-edit", &upstream]).await?,
        PullStrategy::Rebase => git_run(dir, &["rebase", &upstream]).await?,
    }
    Ok(GitPullResult {
        status: "pulled".into(),
        reason: format!("Integrated {behind} remote commits with {strategy:?}"),
    })
}

#[tauri::command]
pub(crate) async fn git_pull(
    project: String,
    agent: Option<String>,
    scope: Option<String>,
    strategy: Option<String>,
) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    let result = git_pull_at(&dir, pull_strategy(strategy.as_deref())?).await?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

pub(crate) async fn git_push_at(dir: &Path) -> Result<String, String> {
    let branch = run_git_text_io(dir, &["branch", "--show-current"]).await?.trim().to_string();
    if branch.is_empty() {
        return Err("detached HEAD — there is no branch name to push".into());
    }
    git_run(dir, &["push", "-u", "origin", &branch]).await?;
    Ok(branch)
}

#[tauri::command]
pub(crate) async fn git_push(
    project: String,
    agent: Option<String>,
    scope: Option<String>,
) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_push_at(&dir).await
}

fn trash_root() -> Result<std::path::PathBuf, String> {
    if let Some(path) = std::env::var_os("TRANTOR_TRASH_DIR") {
        return Ok(std::path::PathBuf::from(path));
    }
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set; cannot locate the Trash".to_string())?;
    let home = std::path::PathBuf::from(home);
    #[cfg(target_os = "macos")]
    return Ok(home.join(".Trash"));
    #[cfg(not(target_os = "macos"))]
    if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
        return Ok(std::path::PathBuf::from(data).join("Trash/files"));
    }
    #[cfg(not(target_os = "macos"))]
    Ok(home.join(".local/share/Trash/files"))
}

fn discard_folder(root: &Path) -> Result<std::path::PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("cannot date the Trash backup: {e}"))?;
    let folder = root.join(format!("Trantor discard {}-{}-{}", stamp.as_secs(), stamp.subsec_nanos(), std::process::id()));
    std::fs::create_dir_all(&folder).map_err(|e| format!("cannot create Trash backup {}: {e}", folder.display()))?;
    Ok(folder)
}

fn copy_path(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source).map_err(|e| format!("cannot read {}: {e}", source.display()))?;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create Trash folder {}: {e}", parent.display()))?;
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(destination).map_err(|e| format!("cannot copy directory {}: {e}", source.display()))?;
        let entries = std::fs::read_dir(source).map_err(|e| format!("cannot list {}: {e}", source.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("cannot list {}: {e}", source.display()))?;
            copy_path(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(source).map_err(|e| format!("cannot copy link {}: {e}", source.display()))?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, destination).map_err(|e| format!("cannot copy link {}: {e}", source.display()))?;
        #[cfg(not(unix))]
        return Err(format!("cannot copy symbolic link {} on this platform", source.display()));
        return Ok(());
    }
    std::fs::copy(source, destination).map_err(|e| format!("cannot copy {} to Trash: {e}", source.display()))?;
    Ok(())
}

/// Every path in a `status -z` listing, a rename's old name included, so discard all restores it too.
pub(crate) fn changed_paths(status: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut records = status.split('\0');
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        paths.push(record[3..].to_string());
        if record.starts_with('R') || record.starts_with('C') {
            paths.extend(records.next().map(str::to_string));
        }
    }
    paths
}

const CHECKOUT_SEARCH_DEPTH: usize = 4;

/// True when an untracked folder holds another git checkout (a worktree, a clone) near its top.
fn holds_checkout(folder: &Path, depth: usize) -> bool {
    let Ok(entries) = std::fs::read_dir(folder) else { return false };
    entries.flatten().take(2000).any(|entry| {
        let path = entry.path();
        let is_dir = std::fs::symlink_metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        entry.file_name() == ".git" || (depth > 0 && is_dir && holds_checkout(&path, depth - 1))
    })
}

pub(crate) fn refuse_nested_checkouts(dir: &Path, paths: &[String]) -> Result<(), String> {
    for path in paths {
        let full = dir.join(path);
        let is_dir = std::fs::symlink_metadata(&full).map(|m| m.is_dir()).unwrap_or(false);
        if is_dir && holds_checkout(&full, CHECKOUT_SEARCH_DEPTH) {
            return Err(format!("{path} holds another git checkout, so nothing was discarded. Remove it yourself or add it to .gitignore."));
        }
    }
    Ok(())
}

async fn discard_paths(dir: &Path, paths: Option<&[String]>) -> Result<Vec<String>, String> {
    let owned;
    let paths = match paths {
        Some(paths) => paths,
        None => {
            let status = run_git_text_io(dir, &["status", "--porcelain=v1", "-z"]).await?;
            owned = changed_paths(&status);
            &owned
        }
    };
    if paths.is_empty() {
        return Err("There are no changes to discard".into());
    }
    clean_git_paths(dir, paths)
}

async fn remove_from_index_or_worktree(dir: &Path, path: &str) -> Result<(), String> {
    if run_git_text_io(dir, &["ls-files", "--error-unmatch", "--", path]).await.is_ok() {
        return git_run(dir, &["rm", "-r", "-f", "-q", "--", path]).await;
    }
    let full = dir.join(path);
    let metadata = std::fs::symlink_metadata(&full).map_err(|e| format!("cannot remove {}: {e}", full.display()))?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(&full).map_err(|e| format!("cannot remove {}: {e}", full.display()))
    } else {
        std::fs::remove_file(&full).map_err(|e| format!("cannot remove {}: {e}", full.display()))
    }
}

pub(crate) async fn git_discard_in(dir: &Path, paths: Option<&[String]>, trash: &Path) -> Result<String, String> {
    let paths = discard_paths(dir, paths).await?;
    refuse_nested_checkouts(dir, &paths)?;
    let folder = discard_folder(trash)?;
    for path in &paths {
        let source = dir.join(path);
        if std::fs::symlink_metadata(&source).is_ok() {
            copy_path(&source, &folder.join(path))?;
        }
    }
    for path in &paths {
        let head_path = format!("HEAD:{path}");
        if run_git_text_io(dir, &["cat-file", "-e", &head_path]).await.is_ok() {
            git_run(dir, &["restore", "--source=HEAD", "--staged", "--worktree", "--", path]).await?;
        } else {
            remove_from_index_or_worktree(dir, path).await?;
        }
    }
    Ok(folder.to_string_lossy().to_string())
}

pub(crate) async fn git_discard_at(dir: &Path, paths: Option<&[String]>) -> Result<String, String> {
    git_discard_in(dir, paths, &trash_root()?).await
}

#[tauri::command]
pub(crate) async fn git_discard(
    project: String,
    agent: Option<String>,
    scope: Option<String>,
    paths: Option<Vec<String>>,
) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_discard_at(&dir, paths.as_deref()).await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitStash {
    pub(crate) name: String,
    pub(crate) sha: String,
    pub(crate) created_at: u64,
    pub(crate) message: String,
}

fn parse_stash_list(text: &str) -> Vec<GitStash> {
    text.lines().filter_map(|line| {
        let mut parts = line.splitn(4, '\u{1f}');
        let name = parts.next()?.to_string();
        let sha = parts.next()?.to_string();
        let created_at = parts.next()?.parse().ok()?;
        let message = parts.next()?.to_string();
        Some(GitStash { name, sha, created_at, message })
    }).collect()
}

pub(crate) async fn git_stash_list_at(dir: &Path) -> Result<Vec<GitStash>, String> {
    let text = run_git_text_io(dir, &["stash", "list", "--format=%gd%x1f%H%x1f%at%x1f%s"]).await?;
    Ok(parse_stash_list(&text))
}

#[tauri::command]
pub(crate) async fn git_stash_list(project: String, agent: Option<String>, scope: Option<String>) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir(&project, &scope)?;
    serde_json::to_string(&git_stash_list_at(&dir).await?).map_err(|e| e.to_string())
}

pub(crate) async fn git_stash_save_at(dir: &Path, message: &str) -> Result<(), String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("stash message is empty".into());
    }
    if run_git_text_io(dir, &["status", "--porcelain=v1"]).await?.trim().is_empty() {
        return Err("There are no changes to stash".into());
    }
    git_run(dir, &["stash", "push", "--include-untracked", "-m", message]).await
}

#[tauri::command]
pub(crate) async fn git_stash_save(project: String, agent: Option<String>, scope: Option<String>, message: String) -> Result<(), String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_stash_save_at(&dir, &message).await
}

fn stash_ref(reference: &str) -> Result<&str, String> {
    let valid = reference.strip_prefix("stash@{")
        .and_then(|r| r.strip_suffix('}'))
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
    if valid { Ok(reference) } else { Err(format!("invalid stash reference: {reference}")) }
}

pub(crate) async fn git_stash_change_at(dir: &Path, reference: &str, action: &str) -> Result<(), String> {
    let reference = stash_ref(reference)?;
    match action {
        "apply" | "pop" => git_run(dir, &["stash", action, reference]).await,
        "drop" => git_run(dir, &["stash", "drop", "-q", reference]).await,
        _ => Err(format!("unknown stash action: {action}")),
    }
}

#[tauri::command]
pub(crate) async fn git_stash_change(
    project: String,
    agent: Option<String>,
    scope: Option<String>,
    reference: String,
    action: String,
) -> Result<(), String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_stash_change_at(&dir, &reference, &action).await
}

#[cfg(test)]
#[path = "git_checkout_tests.rs"]
mod git_checkout_tests;
