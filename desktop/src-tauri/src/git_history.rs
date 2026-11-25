#[allow(unused_imports)]
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitHistoryEntry {
    pub(crate) sha: String,
    pub(crate) author: String,
    pub(crate) when: String,
    pub(crate) subject: String,
    pub(crate) refs: Vec<String>,
}

fn parse_history(raw: &str) -> Vec<GitHistoryEntry> {
    raw.split('\x1e').filter_map(|record| {
        let fields: Vec<&str> = record.trim().split('\x1f').collect();
        if fields.len() != 5 {
            return None;
        }
        let refs = fields[4].split(',').filter_map(|name| {
            let name = name.trim().strip_prefix("HEAD -> ").unwrap_or(name.trim());
            (!name.is_empty() && name != "HEAD").then(|| name.to_string())
        }).collect();
        Some(GitHistoryEntry {
            sha: fields[0].to_string(),
            author: fields[1].to_string(),
            when: fields[2].to_string(),
            subject: fields[3].to_string(),
            refs,
        })
    }).collect()
}

pub(crate) async fn git_history_at(
    dir: &Path,
    all: bool,
    file: Option<&str>,
    message: Option<&str>,
    limit: Option<u32>,
) -> Result<Vec<GitHistoryEntry>, String> {
    if let Some(path) = file {
        resolve_within(dir, path)?;
    }
    let mut args = vec![
        "log".to_string(),
        format!("--max-count={}", log_limit(limit)),
        "--pretty=format:%H%x1f%an%x1f%ar%x1f%s%x1f%D%x1e".to_string(),
    ];
    if all {
        args.push("--all".to_string());
    }
    if let Some(message) = message.filter(|value| !value.is_empty()) {
        args.push(format!("--grep={message}"));
        args.push("--fixed-strings".to_string());
        args.push("--regexp-ignore-case".to_string());
    }
    if let Some(path) = file {
        args.push("--".to_string());
        args.push(path.to_string());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(parse_history(&run_git_text_io(dir, &refs).await?))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitCommitMeta {
    pub(crate) sha: String,
    pub(crate) author: String,
    pub(crate) when: String,
    pub(crate) subject: String,
    pub(crate) message: String,
    pub(crate) parents: Vec<String>,
    pub(crate) github_url: Option<String>,
}

pub(crate) fn github_commit_url(remote: &str, sha: &str) -> Option<String> {
    let remote = remote.trim();
    let repo = [
        "https://github.com/",
        "http://github.com/",
        "git@github.com:",
        "ssh://git@github.com/",
        "git://github.com/",
    ].iter().find_map(|prefix| remote.strip_prefix(prefix))?;
    let repo = repo.trim_end_matches('/').strip_suffix(".git").unwrap_or(repo.trim_end_matches('/'));
    let mut parts = repo.split('/');
    let owner = parts.next()?;
    let name = parts.next()?;
    if owner.is_empty() || name.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("https://github.com/{owner}/{name}/commit/{sha}"))
}

pub(crate) async fn git_commit_meta_at(dir: &Path, sha: &str) -> Result<GitCommitMeta, String> {
    let sha = sha.trim();
    if !valid_commit_id(sha) {
        return Err(format!("commit id is invalid: {sha}"));
    }
    let full = run_git_text_io(dir, &["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")])
        .await
        .map_err(|_| format!("no commit {sha} in this checkout"))?
        .trim()
        .to_string();
    let raw = run_git_text_io(dir, &["show", "-s", "--format=%an%x1f%ar%x1f%s%x1e%B%x1e%P", &full]).await?;
    let mut records = raw.splitn(3, '\x1e');
    let header = records.next().ok_or_else(|| "git returned malformed commit metadata".to_string())?;
    let message = records.next().ok_or_else(|| "git returned malformed commit metadata".to_string())?;
    let parents = records.next().ok_or_else(|| "git returned malformed commit metadata".to_string())?;
    let fields: Vec<&str> = header.split('\x1f').collect();
    if fields.len() != 3 {
        return Err("git returned malformed commit metadata".to_string());
    }
    let remote = run_git_text_io(dir, &["remote", "get-url", "origin"]).await.ok();
    let github_url = remote.and_then(|url| github_commit_url(&url, &full));
    Ok(GitCommitMeta {
        sha: full,
        author: fields[0].to_string(),
        when: fields[1].to_string(),
        subject: fields[2].to_string(),
        message: message.trim().to_string(),
        parents: parents.split_whitespace().map(str::to_string).collect(),
        github_url,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitBlameLine {
    pub(crate) line: u32,
    pub(crate) sha: String,
    pub(crate) author: String,
    pub(crate) when: String,
    pub(crate) subject: String,
}

#[derive(Default)]
struct BlamePart {
    line: u32,
    sha: String,
    author: String,
    committed_at: u64,
    subject: String,
}

fn relative_age(timestamp: u64) -> String {
    let now = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(value) => value.as_secs(),
        Err(_) => timestamp,
    };
    let seconds = now.saturating_sub(timestamp);
    if seconds < 60 {
        return "just now".to_string();
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    let days = hours / 24;
    if days < 30 {
        return format!("{days}d ago");
    }
    let months = days / 30;
    if months < 12 {
        return format!("{months}mo ago");
    }
    format!("{}y ago", days / 365)
}

fn parse_blame(raw: &str) -> Vec<GitBlameLine> {
    let mut lines = Vec::new();
    let mut part = BlamePart::default();
    for row in raw.lines() {
        if row.starts_with('\t') {
            if part.line > 0 {
                lines.push(GitBlameLine {
                    line: part.line,
                    sha: part.sha,
                    author: part.author,
                    when: relative_age(part.committed_at),
                    subject: part.subject,
                });
            }
            part = BlamePart::default();
            continue;
        }
        let fields: Vec<&str> = row.split_whitespace().collect();
        if fields.len() >= 3 && fields[0].chars().all(|c| c.is_ascii_hexdigit()) {
            if let Ok(line) = fields[2].parse() {
                part.line = line;
                part.sha = fields[0].to_string();
            }
        } else if let Some(author) = row.strip_prefix("author ") {
            part.author = author.to_string();
        } else if let Some(time) = row.strip_prefix("author-time ") {
            part.committed_at = time.parse().unwrap_or(0);
        } else if let Some(subject) = row.strip_prefix("summary ") {
            part.subject = subject.to_string();
        }
    }
    lines
}

pub(crate) async fn git_blame_at(dir: &Path, path: &str) -> Result<Vec<GitBlameLine>, String> {
    resolve_within(dir, path)?;
    let raw = run_git_text_io(dir, &["blame", "--line-porcelain", "HEAD", "--", path]).await?;
    Ok(parse_blame(&raw))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitOperation {
    pub(crate) operation: Option<String>,
    pub(crate) conflicts: usize,
}

async fn operation_at(dir: &Path) -> Result<GitOperation, String> {
    let raw = run_git_text_io(dir, &["rev-parse", "--git-dir"]).await?;
    let git_dir = PathBuf::from(raw.trim());
    let git_dir = if git_dir.is_absolute() { git_dir } else { dir.join(git_dir) };
    let operation = if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("rebase")
    } else if git_dir.join("MERGE_HEAD").exists() {
        Some("merge")
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick")
    } else if git_dir.join("REVERT_HEAD").exists() {
        Some("revert")
    } else {
        None
    };
    let status = run_git_text_io(dir, &["status", "--porcelain=v1", "-z"]).await?;
    let conflicts = parse_porcelain_v1(&status).into_iter().filter(|entry| {
        matches!(format!("{}{}", entry.x, entry.y).as_str(), "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
    }).count();
    Ok(GitOperation { operation: operation.map(str::to_string), conflicts })
}

pub(crate) async fn git_operation_at(dir: &Path) -> Result<GitOperation, String> {
    operation_at(dir).await
}

pub(crate) async fn git_operation_continue_at(dir: &Path) -> Result<(), String> {
    let state = operation_at(dir).await?;
    if state.conflicts > 0 {
        return Err(format!("{} conflicted file(s) remain", state.conflicts));
    }
    match state.operation.as_deref() {
        Some("merge") => git_run(dir, &["commit", "--no-edit"]).await,
        Some("rebase") => git_run(dir, &["-c", "core.editor=true", "rebase", "--continue"]).await,
        Some("cherry-pick") => git_run(dir, &["-c", "core.editor=true", "cherry-pick", "--continue"]).await,
        Some("revert") => git_run(dir, &["-c", "core.editor=true", "revert", "--continue"]).await,
        _ => Err("no merge, rebase, cherry-pick or revert is paused".to_string()),
    }
}

pub(crate) async fn git_operation_abort_at(dir: &Path) -> Result<(), String> {
    let operation = operation_at(dir).await?.operation.ok_or_else(|| "no merge, rebase, cherry-pick or revert is paused".to_string())?;
    let args: &[&str] = match operation.as_str() {
        "merge" => &["merge", "--abort"],
        "rebase" => &["rebase", "--abort"],
        "cherry-pick" => &["cherry-pick", "--abort"],
        "revert" => &["revert", "--abort"],
        _ => return Err(format!("cannot abort {operation}")),
    };
    git_run(dir, args).await
}

#[tauri::command]
pub(crate) async fn git_history(
    project: String,
    agent: Option<String>,
    scope: Option<String>,
    all: bool,
    file: Option<String>,
    message: Option<String>,
    limit: Option<u32>,
) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir(&project, &scope)?;
    serde_json::to_string(&git_history_at(&dir, all, file.as_deref(), message.as_deref(), limit).await?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn git_commit_meta(
    project: String,
    agent: Option<String>,
    scope: Option<String>,
    sha: String,
) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir(&project, &scope)?;
    serde_json::to_string(&git_commit_meta_at(&dir, &sha).await?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn git_blame(
    project: String,
    agent: Option<String>,
    scope: Option<String>,
    path: String,
) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir(&project, &scope)?;
    serde_json::to_string(&git_blame_at(&dir, &path).await?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn git_operation(project: String, agent: Option<String>, scope: Option<String>) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir(&project, &scope)?;
    serde_json::to_string(&git_operation_at(&dir).await?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn git_operation_continue(project: String, agent: Option<String>, scope: Option<String>) -> Result<(), String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_operation_continue_at(&dir).await
}

#[tauri::command]
pub(crate) async fn git_operation_abort(project: String, agent: Option<String>, scope: Option<String>) -> Result<(), String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_operation_abort_at(&dir).await
}

#[cfg(test)]
#[path = "git_history_tests.rs"]
mod git_history_tests;
