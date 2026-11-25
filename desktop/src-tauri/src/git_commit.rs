#[allow(unused_imports)]
use super::*;
use tokio::io::AsyncWriteExt;

pub(crate) async fn git_head_is_pushed(dir: &Path) -> Result<bool, String> {
    let refs = run_git_text_io(dir, &["for-each-ref", "--contains", "HEAD", "--format=%(refname)", "refs/remotes"]).await?;
    Ok(!refs.trim().is_empty())
}

pub(crate) async fn git_amend_at(dir: &Path, message: &str) -> Result<String, String> {
    if git_head_is_pushed(dir).await? {
        return Err("The last commit is already pushed; amend is refused".into());
    }
    let message = message.trim();
    if message.is_empty() {
        return Err("commit message is empty".into());
    }
    git_run(dir, &["commit", "--amend", "-q", "-m", message]).await?;
    run_git_text_io(dir, &["rev-parse", "--short", "HEAD"]).await.map(|sha| sha.trim().to_string())
}

pub(crate) async fn git_undo_at(dir: &Path) -> Result<String, String> {
    if git_head_is_pushed(dir).await? {
        return Err("The last commit is already pushed; undo is refused".into());
    }
    let message = run_git_text_io(dir, &["log", "-1", "--format=%B"]).await?;
    if run_git_text_io(dir, &["rev-parse", "--verify", "--quiet", "HEAD^"]).await.is_err() {
        return Err("The first commit cannot be undone".into());
    }
    git_run(dir, &["reset", "--soft", "HEAD^"]).await?;
    Ok(message.trim_end().to_string())
}

#[tauri::command]
pub(crate) async fn git_commit_amend(project: String, agent: Option<String>, scope: Option<String>, message: String) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_amend_at(&dir, &message).await
}

#[tauri::command]
pub(crate) async fn git_commit_undo(project: String, agent: Option<String>, scope: Option<String>) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_undo_at(&dir).await
}

fn patch_args(path: &str, action: &str) -> Result<Vec<String>, String> {
    let mut args = vec!["apply".to_string(), "--whitespace=nowarn".into(), format!("--include={path}")];
    match action {
        "stage" => args.push("--cached".into()),
        "unstage" => args.extend(["--cached".into(), "--reverse".into()]),
        "discard" => args.push("--reverse".into()),
        _ => return Err(format!("unknown patch action: {action}")),
    }
    args.push("-".into());
    Ok(args)
}

async fn apply_patch(dir: &Path, args: &[String], patch: &str) -> Result<(), String> {
    let mut child = tokio::process::Command::new("git")
        .arg("-C").arg(dir).args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn().map_err(|e| format!("git apply could not start: {e}"))?;
    child.stdin.take().ok_or_else(|| "git apply has no stdin".to_string())?
        .write_all(patch.as_bytes()).await.map_err(|e| format!("could not send the patch to git: {e}"))?;
    let out = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output()).await
        .map_err(|_| "git apply timed out after 30 seconds".to_string())?
        .map_err(|e| format!("git apply failed: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr });
    Err(format!("The patch no longer applies; the diff was refreshed. {}", detail.trim()))
}

pub(crate) async fn git_apply_patch_in(dir: &Path, path: &str, patch: &str, action: &str, trash: &Path) -> Result<String, String> {
    let path = clean_git_paths(dir, &[path.to_string()])?.remove(0);
    if patch.trim().is_empty() {
        return Err("The patch is empty; refresh the diff and select the change again".into());
    }
    let args = patch_args(&path, action)?;
    let mut backup = String::new();
    if action == "discard" {
        let folder = discard_folder(trash)?;
        let source = dir.join(&path);
        if std::fs::symlink_metadata(&source).is_ok() {
            copy_path(&source, &folder.join(&path))?;
        }
        backup = folder.to_string_lossy().to_string();
    }
    apply_patch(dir, &args, patch).await?;
    Ok(backup)
}

pub(crate) async fn git_apply_patch_at(dir: &Path, path: &str, patch: &str, action: &str) -> Result<String, String> {
    let trash = if action == "discard" { trash_root()? } else { std::path::PathBuf::new() };
    git_apply_patch_in(dir, path, patch, action, &trash).await
}

#[tauri::command]
pub(crate) async fn git_apply_patch(project: String, agent: Option<String>, scope: Option<String>, path: String, patch: String, action: String) -> Result<String, String> {
    let scope = parse_scope(agent.as_deref(), scope.as_deref())?;
    let dir = scope_dir_for_mutation(&project, &scope).await?;
    git_apply_patch_at(&dir, &path, &patch, &action).await
}

#[cfg(test)]
#[path = "git_commit_tests.rs"]
mod git_commit_tests;
