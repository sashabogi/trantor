#[allow(unused_imports)]
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitBranch {
    pub(crate) name: String,
    pub(crate) sha: String,
    pub(crate) committed_at: u64,
    pub(crate) ahead: Option<u64>,
    pub(crate) behind: Option<u64>,
    pub(crate) current: bool,
    pub(crate) remote: bool,
    pub(crate) worktree: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitBranchList {
    pub(crate) default_branch: Option<String>,
    pub(crate) current: Option<String>,
    pub(crate) branches: Vec<GitBranch>,
}

fn tracking_count(track: &str, key: &str) -> Option<u64> {
    track.trim_matches(['[', ']']).split(',').find_map(|part| {
        let mut words = part.trim().split_whitespace();
        (words.next() == Some(key)).then(|| words.next()?.parse().ok()).flatten()
    })
}

fn parse_branches(text: &str, current: &str, remote: bool) -> Vec<GitBranch> {
    text.lines().filter_map(|line| {
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        if fields.len() != 6 || !remote && !fields[5].is_empty() || remote && !fields[5].is_empty() {
            return None;
        }
        Some(GitBranch {
            name: fields[0].to_string(),
            sha: fields[1].to_string(),
            committed_at: fields[2].parse().ok()?,
            ahead: tracking_count(fields[3], "ahead"),
            behind: tracking_count(fields[3], "behind"),
            current: !remote && fields[0] == current,
            remote,
            worktree: (!fields[4].is_empty()).then(|| fields[4].to_string()),
        })
    }).collect()
}

async fn read_branches(dir: &Path, remote: bool, current: &str) -> Result<Vec<GitBranch>, String> {
    let root = if remote { "refs/remotes" } else { "refs/heads" };
    let format = "%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(upstream:track)%1f%(worktreepath)%1f%(symref)";
    let text = run_git_text_io(dir, &["for-each-ref", &format!("--format={format}"), root]).await?;
    Ok(parse_branches(&text, current, remote))
}

pub(crate) async fn git_branch_list_at(dir: &Path) -> Result<GitBranchList, String> {
    let current = run_git_text_io(dir, &["branch", "--show-current"]).await?.trim().to_string();
    let mut branches = read_branches(dir, false, &current).await?;
    branches.extend(read_branches(dir, true, &current).await?);
    branches.sort_by(|a, b| b.committed_at.cmp(&a.committed_at).then_with(|| a.name.cmp(&b.name)));
    let default_branch = default_branch_async(dir).await?.map(|branch| branch.name);
    Ok(GitBranchList { default_branch, current: (!current.is_empty()).then_some(current), branches })
}

async fn validate_branch(dir: &Path, name: &str) -> Result<(), String> {
    if name.trim() != name || name.is_empty() {
        return Err("branch name is empty".into());
    }
    run_git_text_io(dir, &["check-ref-format", "--branch", name]).await?;
    Ok(())
}

async fn local_branch_exists(dir: &Path, name: &str) -> bool {
    run_git_text_io(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).await.is_ok()
}

async fn remote_branch_exists(dir: &Path, name: &str) -> bool {
    run_git_text_io(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{name}")]).await.is_ok()
}

async fn validate_existing_branch(dir: &Path, name: &str) -> Result<(), String> {
    validate_branch(dir, name).await?;
    if local_branch_exists(dir, name).await || remote_branch_exists(dir, name).await {
        Ok(())
    } else {
        Err(format!("branch does not exist: {name}"))
    }
}

pub(crate) async fn git_branch_create_at(dir: &Path, name: &str, start: Option<&str>) -> Result<(), String> {
    validate_branch(dir, name).await?;
    if local_branch_exists(dir, name).await {
        return Err(format!("branch already exists: {name}"));
    }
    match start {
        Some(sha) => {
            if !valid_commit_id(sha) {
                return Err(format!("commit id is invalid: {sha}"));
            }
            run_git_text_io(dir, &["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")]).await?;
            git_run(dir, &["branch", "--", name, sha]).await
        }
        None => git_run(dir, &["branch", "--", name, "HEAD"]).await,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitBranchResult {
    pub(crate) status: String,
    pub(crate) reason: String,
    pub(crate) conflicts: Vec<String>,
}

fn branch_result(status: &str, reason: String) -> GitBranchResult {
    GitBranchResult { status: status.into(), reason, conflicts: Vec::new() }
}

async fn unmerged_paths(dir: &Path) -> Result<Vec<String>, String> {
    let status = run_git_text_io(dir, &["status", "--porcelain=v1", "-z"]).await?;
    Ok(parse_porcelain_v1(&status).into_iter().filter(|entry| {
        matches!(format!("{}{}", entry.x, entry.y).as_str(), "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
    }).map(|entry| entry.path).collect())
}

pub(crate) async fn git_branch_switch_at(dir: &Path, name: &str, dirty: &str) -> Result<GitBranchResult, String> {
    validate_existing_branch(dir, name).await?;
    if !matches!(dirty, "ask" | "bring" | "stash") {
        return Err(format!("uncommitted-file choice must be ask, bring or stash, not {dirty}"));
    }
    if run_git_text_io(dir, &["branch", "--show-current"]).await?.trim() == name {
        return Ok(branch_result("done", format!("Already on {name}")));
    }
    let status = run_git_text_io(dir, &["status", "--porcelain=v1", "-z"]).await?;
    if !status.is_empty() && dirty == "ask" {
        let count = parse_porcelain_v1(&status).len();
        return Ok(branch_result("dirty", format!("{count} uncommitted path(s); choose bring or stash")));
    }
    if !status.is_empty() && dirty == "stash" {
        let paths = changed_paths(&status);
        refuse_nested_checkouts(dir, &paths)?;
        git_stash_save_at(dir, &format!("Before switching to {name}")).await?;
    }
    if local_branch_exists(dir, name).await {
        git_run(dir, &["switch", name]).await?;
    } else {
        let local = name.split_once('/').map(|(_, local)| local).unwrap_or(name);
        validate_branch(dir, local).await?;
        if local_branch_exists(dir, local).await {
            git_run(dir, &["switch", local]).await?;
        } else {
            git_run(dir, &["switch", "--track", "-c", local, name]).await?;
        }
    }
    Ok(branch_result("done", format!("Switched to {name}")))
}

async fn checked_out_worktree(dir: &Path, name: &str) -> Result<Option<String>, String> {
    let text = run_git_text_io(dir, &["worktree", "list", "--porcelain"]).await?;
    let wanted = format!("refs/heads/{name}");
    let mut worktree = None;
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            worktree = Some(path.to_string());
        } else if line == format!("branch {wanted}") {
            return Ok(worktree);
        }
    }
    Ok(None)
}

pub(crate) async fn git_branch_rename_at(dir: &Path, old: &str, new: &str) -> Result<(), String> {
    validate_existing_branch(dir, old).await?;
    validate_branch(dir, new).await?;
    if !local_branch_exists(dir, old).await {
        return Err("remote branches cannot be renamed here".into());
    }
    if let Some(path) = checked_out_worktree(dir, old).await? {
        // git reports the resolved path, so a symlinked folder must be resolved before comparing.
        let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        if real(Path::new(&path)) != real(dir) {
            return Err(format!("{old} is checked out in another worktree; rename it there"));
        }
    }
    git_run(dir, &["branch", "-m", old, new]).await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitBranchDeleteResult {
    pub(crate) status: String,
    pub(crate) unique: u64,
}

pub(crate) async fn git_branch_delete_at(dir: &Path, name: &str, force: bool) -> Result<GitBranchDeleteResult, String> {
    validate_existing_branch(dir, name).await?;
    if !local_branch_exists(dir, name).await {
        return Err("remote branches cannot be deleted here".into());
    }
    if default_branch_async(dir).await?.is_some_and(|branch| branch.name == name) {
        return Err(format!("{name} is protected and cannot be deleted"));
    }
    if run_git_text_io(dir, &["branch", "--show-current"]).await?.trim() == name {
        return Err(format!("{name} is checked out; switch to another branch first"));
    }
    if let Some(path) = checked_out_worktree(dir, name).await? {
        return Err(format!("{name} is checked out in {path}"));
    }
    let unique = run_git_text_io(dir, &["rev-list", "--count", name, "--not", "HEAD"]).await?.trim().parse::<u64>()
        .map_err(|e| format!("cannot count commits unique to {name}: {e}"))?;
    if unique > 0 && !force {
        return Ok(GitBranchDeleteResult { status: "confirm".into(), unique });
    }
    git_run(dir, &["branch", if force { "-D" } else { "-d" }, "--", name]).await?;
    Ok(GitBranchDeleteResult { status: "deleted".into(), unique })
}

pub(crate) async fn git_branch_integrate_at(dir: &Path, name: &str, operation: &str) -> Result<GitBranchResult, String> {
    validate_existing_branch(dir, name).await?;
    let result = match operation {
        "merge" => git_run(dir, &["merge", "--no-edit", name]).await,
        "rebase" => git_run(dir, &["rebase", name]).await,
        _ => return Err(format!("branch operation must be merge or rebase, not {operation}")),
    };
    if let Err(error) = result {
        let conflicts = unmerged_paths(dir).await?;
        if !conflicts.is_empty() {
            return Ok(GitBranchResult {
                status: "conflict".into(),
                reason: format!("{} stopped on {} conflicted file(s)", operation, conflicts.len()),
                conflicts,
            });
        }
        return Err(error);
    }
    Ok(branch_result("done", format!("{} {name} completed", operation)))
}

#[tauri::command]
pub(crate) async fn git_branch_list(project: String, agent: Option<String>, scope: Option<String>) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir(&project, &scope)?;
    serde_json::to_string(&git_branch_list_at(&dir).await?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn git_branch_create(project: String, agent: Option<String>, scope: Option<String>, name: String, sha: Option<String>) -> Result<(), String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_branch_create_at(&dir, &name, sha.as_deref()).await
}

#[tauri::command]
pub(crate) async fn git_branch_switch(project: String, agent: Option<String>, scope: Option<String>, name: String, dirty: String) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    serde_json::to_string(&git_branch_switch_at(&dir, &name, &dirty).await?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn git_branch_rename(project: String, agent: Option<String>, scope: Option<String>, old: String, new: String) -> Result<(), String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_branch_rename_at(&dir, &old, &new).await
}

#[tauri::command]
pub(crate) async fn git_branch_delete(project: String, agent: Option<String>, scope: Option<String>, name: String, force: bool) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    serde_json::to_string(&git_branch_delete_at(&dir, &name, force).await?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn git_branch_merge(project: String, agent: Option<String>, scope: Option<String>, name: String) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    serde_json::to_string(&git_branch_integrate_at(&dir, &name, "merge").await?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn git_branch_rebase(project: String, agent: Option<String>, scope: Option<String>, name: String) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    serde_json::to_string(&git_branch_integrate_at(&dir, &name, "rebase").await?).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "git_branch_tests.rs"]
mod git_branch_tests;
