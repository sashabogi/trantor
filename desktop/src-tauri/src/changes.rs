#[allow(unused_imports)]
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ChangeRow {
    /// None = the project checkout itself; Some = the seat whose worktree changed.
    seat: Option<String>,
    path: String,
    /// git porcelain code, trimmed ("M", "A", "??", "D")
    status: String,
    plus: Option<u64>,
    minus: Option<u64>,
}

/// Status + numstat rows for ONE root (the checkout or a single seat worktree).
pub(crate) fn collect_changes_for_root(root: &Path, seat: Option<&str>) -> Vec<ChangeRow> {
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

pub(crate) fn project_changes_sync(project: &str) -> Result<Vec<ChangeRow>, String> {
    if project.trim().is_empty()
        || project.contains("..")
        || project.contains('/')
    {
        return Err("project is invalid".into());
    }
    let dev_root = identity::dev_root();
    let checkout = identity::checkout_for(&dev_root, project).unwrap_or_else(|| dev_root.join(project));
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

/// Backend trace line into the same app-trace.log the frontend writes (#5993 status watcher).
pub(crate) fn trace(line: String) {
    app_trace(&line);
}

/// The diagnostic trace the investigation greps (`~/.agent-bus/app-trace.log`), shared by the
/// frontend's `app_log` command and Rust-side watchers (#5993): one line per state change,
/// `{millis} {line}`. Fire-and-forget — a trace that cannot be written must never break the
/// stream that noticed the problem.
pub(crate) fn app_trace(line: &str) {
    let dir = desktop_bus_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app-trace.log"))
    else {
        return;
    };
    use std::io::Write;
    let _ = writeln!(f, "{ms} {line}");
}

/// The frontend's diagnostic line, appended verbatim with a timestamp (#12752). Not a log for
/// humans — a trace the investigation greps. Fire-and-forget from the caller's side.
#[tauri::command]
pub(crate) fn app_log(line: String) -> Result<(), String> {
    app_trace(&line);
    Ok(())
}

#[tauri::command]
pub(crate) fn project_changes(project: String) -> Result<String, String> {
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
