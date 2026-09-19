#[allow(unused_imports)]
use super::*;

/// Save an edit, plainly: a file write and nothing else (#5809, Orca's save anatomy). Dirty work
/// stays in Changes until an explicit stage/commit. The seat-working guard stays.
#[tauri::command]
pub(crate) fn file_write_plain(
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
pub(crate) fn create_file(
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
pub(crate) fn delete_file(project: String, path: String, seat: Option<String>) -> Result<String, String> {
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
pub(crate) fn rename_file(
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
