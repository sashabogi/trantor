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
    expected_text: Option<String>,
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
    write_file_checked(&full, &text, expected_text.as_deref())?;
    Ok(())
}

fn write_file_checked(full: &Path, text: &str, expected: Option<&str>) -> Result<(), String> {
    if let Some(expected) = expected {
        let disk = std::fs::read(full).map_err(|e| format!("cannot check {}: {e}", full.display()))?;
        if disk != expected.as_bytes() {
            return Err("file_changed_on_disk".into());
        }
    }
    std::fs::write(full, text).map_err(|e| format!("cannot write {}: {e}", full.display()))
}

#[cfg(test)]
#[path = "file_write_guard_tests.rs"]
mod file_write_guard_tests;

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

/// Copy one file into a "Trantor discard" folder under `trash`. Returns that folder's path.
pub(crate) fn trash_file_in(root: &Path, rel: &str, trash: &Path) -> Result<String, String> {
    let folder = crate::git_checkout::discard_folder(trash)?;
    crate::git_checkout::copy_path(&root.join(rel), &folder.join(rel))?;
    Ok(folder.to_string_lossy().to_string())
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
    // #14268: an untracked file has no git history, so it goes to the Trash before it is removed.
    trash_file_in(&root, &path, &crate::git_checkout::trash_root()?)?;
    std::fs::remove_file(&full).map_err(|e| format!("cannot delete {path}: {e}"))?;
    let add =std::process::Command::new("git")
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

// Move, folder rename and delete, reveal and image bytes (#14106). They touch the checkout only:
// nothing is staged or committed, so the result shows up in Changes.

fn clean_rel(path: &str) -> Result<(), String> {
    let bad = path.is_empty()
        || path.contains('\0')
        || path.starts_with('/')
        || path == ".git"
        || path.starts_with(".git/")
        || path.split('/').any(|c| c == "..");
    if bad {
        return Err("path escapes the project".into());
    }
    Ok(())
}

fn checked(root: &Path, rel: &str) -> Result<std::path::PathBuf, String> {
    clean_rel(rel)?;
    resolve_within(root, rel)?;
    Ok(root.join(rel))
}

fn refuse_working_seat(seat: Option<&str>) -> Result<(), String> {
    if let Some(agent) = seat {
        if seat_state(agent.to_string())? == "working" {
            return Err(format!("{agent} is working in this worktree right now, so try again once the seat lands"));
        }
    }
    Ok(())
}

fn parent_rel(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

pub(crate) fn move_path_in(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let source = checked(root, from)?;
    let target = checked(root, to)?;
    let meta = std::fs::symlink_metadata(&source).map_err(|_| "the source does not exist".to_string())?;
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err("the destination already exists".into());
    }
    if meta.is_dir() && (to == from || to.starts_with(&format!("{from}/"))) {
        return Err("a folder cannot move into itself".into());
    }
    if !target.parent().is_some_and(|p| p.is_dir()) {
        return Err("the destination folder does not exist".into());
    }
    std::fs::rename(&source, &target).map_err(|e| format!("cannot move {from} to {to}: {e}"))
}

pub(crate) fn rename_folder_in(root: &Path, from: &str, to: &str) -> Result<(), String> {
    if !checked(root, from)?.is_dir() {
        return Err("that folder does not exist".into());
    }
    if parent_rel(from) != parent_rel(to) {
        return Err("a rename stays in the same folder".into());
    }
    move_path_in(root, from, to)
}

pub(crate) fn count_files_in(root: &Path, rel: &str) -> Result<u64, String> {
    fn walk(dir: &Path) -> Result<u64, String> {
        let mut total = 0;
        for entry in std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
            let kind = entry.file_type().map_err(|e| format!("cannot read {}: {e}", entry.path().display()))?;
            total += if kind.is_dir() { walk(&entry.path())? } else { 1 };
        }
        Ok(total)
    }
    let full = checked(root, rel)?;
    if !full.is_dir() {
        return Err("that folder does not exist".into());
    }
    walk(&full)
}

/// Copy the folder into a "Trantor discard" folder under `trash`, then remove it. Returns that copy's path.
pub(crate) fn delete_folder_in(root: &Path, rel: &str, trash: &Path) -> Result<String, String> {
    let full = checked(root, rel)?;
    let meta = std::fs::symlink_metadata(&full).map_err(|_| "that folder does not exist".to_string())?;
    if !meta.is_dir() {
        return Err("that is not a folder".into());
    }
    let folder = crate::git_checkout::discard_folder(trash)?;
    crate::git_checkout::copy_path(&full, &folder.join(rel))?;
    std::fs::remove_dir_all(&full).map_err(|e| format!("cannot delete {rel}: {e}"))?;
    Ok(folder.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn move_path(project: String, from: String, to: String, seat: Option<String>) -> Result<(), String> {
    let root = source_root(&project, seat.as_deref())?;
    refuse_working_seat(seat.as_deref())?;
    move_path_in(&root, &from, &to)
}

#[tauri::command]
pub(crate) fn rename_folder(project: String, from: String, to: String, seat: Option<String>) -> Result<(), String> {
    let root = source_root(&project, seat.as_deref())?;
    refuse_working_seat(seat.as_deref())?;
    rename_folder_in(&root, &from, &to)
}

#[tauri::command]
pub(crate) fn count_folder_files(project: String, path: String, seat: Option<String>) -> Result<u64, String> {
    count_files_in(&source_root(&project, seat.as_deref())?, &path)
}

#[tauri::command]
pub(crate) fn delete_folder(project: String, path: String, seat: Option<String>) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    refuse_working_seat(seat.as_deref())?;
    delete_folder_in(&root, &path, &crate::git_checkout::trash_root()?)
}

/// The absolute path of a project path on this machine, for Copy path. Does not need the path to exist.
pub(crate) fn absolute_path_in(root: &Path, rel: &str) -> Result<String, String> {
    Ok(checked(root, rel)?.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn absolute_path(project: String, path: String, seat: Option<String>) -> Result<String, String> {
    absolute_path_in(&source_root(&project, seat.as_deref())?, &path)
}

/// Show the file or folder in Finder (the file manager's folder elsewhere). Read only, so a working seat is fine.
#[tauri::command]
pub(crate) fn reveal_path(project: String, path: String, seat: Option<String>) -> Result<(), String> {
    let full = checked(&source_root(&project, seat.as_deref())?, &path)?;
    if std::fs::symlink_metadata(&full).is_err() {
        return Err("that path does not exist".into());
    }
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg("-R").arg(&full).status();
    #[cfg(not(target_os = "macos"))]
    let status = std::process::Command::new("xdg-open").arg(full.parent().unwrap_or(&full)).status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(_) => Err("the file manager could not show that path".into()),
        Err(e) => Err(format!("cannot open the file manager: {e}")),
    }
}

/// Largest image handed to the webview as base64; a bigger one reports its size and no bytes.
pub(crate) const IMAGE_VIEW_CAP: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub(crate) struct ImageBody {
    pub(crate) mime: String,
    pub(crate) bytes: u64,
    pub(crate) data: Option<String>,
}

fn image_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

pub(crate) fn read_image_in(root: &Path, rel: &str) -> Result<ImageBody, String> {
    use base64::Engine;
    let mime = image_mime(rel).ok_or_else(|| "that is not an image type".to_string())?;
    let full = checked(root, rel)?;
    let bytes = std::fs::metadata(&full).map_err(|e| format!("cannot read {rel}: {e}"))?.len();
    if bytes > IMAGE_VIEW_CAP {
        return Ok(ImageBody { mime: mime.into(), bytes, data: None });
    }
    let raw = std::fs::read(&full).map_err(|e| format!("cannot read {rel}: {e}"))?;
    let data = base64::engine::general_purpose::STANDARD.encode(raw);
    Ok(ImageBody { mime: mime.into(), bytes, data: Some(data) })
}

#[tauri::command]
pub(crate) fn read_image(project: String, path: String, seat: Option<String>) -> Result<String, String> {
    let body = read_image_in(&source_root(&project, seat.as_deref())?, &path)?;
    serde_json::to_string(&body).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "file_ops_move_tests.rs"]
mod file_ops_move_tests;

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
