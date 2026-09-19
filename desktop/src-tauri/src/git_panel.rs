#[allow(unused_imports)]
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SeatDiffFile {
    path: String,
    plus: Option<u64>,
    minus: Option<u64>,
    untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SeatDiff {
    branch: String,
    base: String,
    files: Vec<SeatDiffFile>,
    patch: String,
    truncated: bool,
}

pub(crate) fn parse_numstat(raw: &str) -> Vec<SeatDiffFile> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let Some(plus) = parts.next() else { continue };
        let Some(minus) = parts.next() else { continue };
        let Some(path) = parts.next() else { continue };
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        out.push(SeatDiffFile {
            path: path.to_string(),
            plus: plus.parse::<u64>().ok(),
            minus: minus.parse::<u64>().ok(),
            untracked: false,
        });
    }
    out
}

pub(crate) fn parse_untracked_porcelain(raw: &str) -> Vec<SeatDiffFile> {
    raw.lines()
        .filter_map(|line| {
            let path = line.strip_prefix("?? ")?.trim();
            if path.is_empty() {
                return None;
            }
            Some(SeatDiffFile {
                path: path.to_string(),
                plus: None,
                minus: None,
                untracked: true,
            })
        })
        .collect()
}

pub(crate) fn run_git_text(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git could not start: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let err = String::from_utf8_lossy(if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    })
    .trim()
    .to_string();
    Err(if err.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        format!("git {} failed: {err}", args.join(" "))
    })
}

pub(crate) fn merge_base(dir: &Path) -> Result<String, String> {
    for branch in ["main", "master", "origin/main", "origin/master"] {
        if let Ok(base) = run_git_text(dir, &["merge-base", "HEAD", branch]) {
            let base = base.trim().to_string();
            if !base.is_empty() {
                return Ok(base);
            }
        }
    }
    Err("could not find a merge base with main or master".into())
}

pub(crate) fn cap_patch(bytes: &[u8]) -> (String, bool) {
    const PATCH_LIMIT: usize = 400_000;
    if bytes.len() <= PATCH_LIMIT {
        return (String::from_utf8_lossy(bytes).to_string(), false);
    }
    (
        String::from_utf8_lossy(&bytes[..PATCH_LIMIT]).to_string(),
        true,
    )
}

pub(crate) fn seat_diff_from_bus_dir(bus: &Path, project: &str, agent: &str) -> Result<SeatDiff, String> {
    if project.trim().is_empty()
        || agent.trim().is_empty()
        || project.contains("..")
        || agent.contains("..")
        || project.contains('/')
        || agent.contains('/')
    {
        return Err("project or agent is invalid".into());
    }
    let worktree = bus.join("worktrees").join(project).join(agent);
    if !worktree.is_dir() {
        return Err("seat worktree does not exist".into());
    }
    let branch = run_git_text(&worktree, &["branch", "--show-current"])?
        .trim()
        .to_string();
    let base = merge_base(&worktree)?;

    let mut files = parse_numstat(&run_git_text(&worktree, &["diff", "--numstat", &base])?);
    let untracked =
        parse_untracked_porcelain(&run_git_text(&worktree, &["status", "--porcelain"])?);
    for f in untracked {
        if !files.iter().any(|existing| existing.path == f.path) {
            files.push(f);
        }
    }

    let patch_out = std::process::Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["diff", &base])
        .output()
        .map_err(|e| format!("git diff could not start: {e}"))?;
    if !patch_out.status.success() {
        let err = String::from_utf8_lossy(&patch_out.stderr)
            .trim()
            .to_string();
        return Err(if err.is_empty() {
            "git diff failed".into()
        } else {
            format!("git diff failed: {err}")
        });
    }
    let (patch, truncated) = cap_patch(&patch_out.stdout);
    Ok(SeatDiff {
        branch,
        base,
        files,
        patch,
        truncated,
    })
}

#[tauri::command]
pub(crate) fn seat_diff(project: String, agent: String) -> Result<String, String> {
    serde_json::to_string(&seat_diff_from_bus_dir(
        &desktop_bus_dir(),
        &project,
        &agent,
    )?)
    .map_err(|e| e.to_string())
}

// ── git panel (#5775) ──────────────────────────────────────────────────────────────────────────
// One read snapshot and three mutations (stage/unstage, commit, push) against the SEAT's worktree.
// Additive: seat_diff above stays frozen and shares no mutable state with it.

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitStatusEntry {
    path: String,
    /// porcelain v1 X: the index state. "?" means the file is untracked.
    x: String,
    /// porcelain v1 Y: the worktree state relative to the index.
    y: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GitLogEntry {
    sha: String,
    author: String,
    /// author date, relative ("2 hours ago") — git's own rendering, shown as-is
    when: String,
    subject: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct GitPanel {
    branch: String,
    upstream: Option<String>,
    /// commits ahead of the upstream — or, with no upstream, ahead of the merge base with main
    /// (the seat's unlanded work). behind only exists against an upstream; without one the seat
    /// branched from main and "behind" is a claim we have not measured.
    ahead: Option<u64>,
    behind: Option<u64>,
    /// raw `git status --porcelain=v1` rows; the frontend owns bucketing into
    /// staged/unstaged/untracked because that split is presentation, not git knowledge.
    status: Vec<GitStatusEntry>,
    /// +N/−N per changed path vs HEAD (numstat) — the SCM row's change-size chip (#5811).
    /// Untracked and binary paths are absent: git counts neither, and null beats a fake zero.
    counts: Vec<SeatDiffFile>,
    log: Vec<GitLogEntry>,
}

/// The seat's worktree, validated. The same guards seat_diff applies — project and agent name a
/// path under the bus dir, so ".." or "/" in either is path traversal, not a name.
pub(crate) fn seat_worktree(bus: &Path, project: &str, agent: &str) -> Result<std::path::PathBuf, String> {
    if project.trim().is_empty()
        || agent.trim().is_empty()
        || project.contains("..")
        || agent.contains("..")
        || project.contains('/')
        || agent.contains('/')
    {
        return Err("project or agent is invalid".into());
    }
    let worktree = bus.join("worktrees").join(project).join(agent);
    if !worktree.is_dir() {
        return Err("seat worktree does not exist".into());
    }
    Ok(worktree)
}

/// A mutating git command, run for real, off the caller's thread. Failure text is git's own —
/// the panel surfaces it verbatim, because "error: Your branch has no upstream" beats any
/// paraphrase we could write.
pub(crate) async fn git_run(dir: &Path, args: &[&str]) -> Result<(), String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("git could not start: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    })
    .trim()
    .to_string();
    Err(if err.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        format!("git {} failed: {err}", args.join(" "))
    })
}

/// The async twin of run_git_text — same failure text, but the subprocess wait happens on the
/// async runtime instead of the caller. run_git_text stays sync because the frozen seat_diff
/// path uses it; nothing here touches that path.
pub(crate) async fn run_git_text_io(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("git could not start: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let err = String::from_utf8_lossy(if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    })
    .trim()
    .to_string();
    Err(if err.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        format!("git {} failed: {err}", args.join(" "))
    })
}

pub(crate) const MERGE_BASE_BRANCHES: [&str; 4] = ["main", "master", "origin/main", "origin/master"];

/// merge_base's async twin for the git panel — same branch ladder, same "main or master first"
/// answer, without editing the sync one the frozen seat_diff path depends on.
pub(crate) async fn merge_base_async(dir: &Path) -> Result<String, String> {
    for branch in MERGE_BASE_BRANCHES {
        if let Ok(base) = run_git_text_io(dir, &["merge-base", "HEAD", branch]).await {
            let base = base.trim().to_string();
            if !base.is_empty() {
                return Ok(base);
            }
        }
    }
    Err("could not find a merge base with main or master".into())
}

/// Mutating the git state of a worktree an agent is actively working in loses one of the two
/// edits with no undo — the exact hazard file_write_plain already guards, for the same reason. The
/// panel is for landed or paused work; while the seat is mid-turn, every mutation is refused.
pub(crate) async fn git_mutation_guard(agent: &str) -> Result<(), String> {
    // seat_state shells out to herdr synchronously; park that wait on a blocking thread so the
    // async runtime stays free for everything else the app is doing.
    let agent = agent.to_string();
    let for_check = agent.clone();
    let state = tauri::async_runtime::spawn_blocking(move || seat_state(for_check))
        .await
        .map_err(|e| format!("seat state check failed: {e}"))??;
    if state == "working" {
        return Err(format!(
            "{agent} is working in this worktree right now — retry once the seat lands"
        ));
    }
    Ok(())
}

/// Pure porcelain v1 parser, `-z` flavour: NUL-separated "XY PATH" records. With `-z` git emits
/// paths raw, so odd bytes never corrupt a split; a rename carries its origin as a second field, skipped.
pub(crate) fn parse_porcelain_v1(raw: &str) -> Vec<GitStatusEntry> {
    let mut entries = Vec::new();
    let mut records = raw.split('\0');
    while let Some(rec) = records.next() {
        if rec.len() < 4 {
            continue;
        }
        let x = rec[..1].to_string();
        let y = rec[1..2].to_string();
        let path = rec[3..].to_string();
        // Rename (R) and copy (C): the origin path is the next field, consumed here so it is not
        // misread as a record of its own.
        if x == "R" || x == "C" {
            records.next();
        }
        entries.push(GitStatusEntry { path, x, y });
    }
    entries
}

/// Pure parser for `git log --pretty=format:%h%x1f%an%x1f%ar%x1f%s`. Unit separators, not spaces
/// or pipes: a commit subject can contain either of those, and a split on the wrong byte
/// corrupts exactly the rows the operator is trying to read. Rows without all four fields are
/// skipped. No I/O — cargo-tested below.
pub(crate) fn parse_log_pretty(raw: &str) -> Vec<GitLogEntry> {
    let mut log = Vec::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() == 4 {
            log.push(GitLogEntry {
                sha: parts[0].to_string(),
                author: parts[1].to_string(),
                when: parts[2].to_string(),
                subject: parts[3].to_string(),
            });
        }
    }
    log
}

/// Pure parser for `git rev-list --left-right --count <upstream>...HEAD`, which answers
/// "behind<TAB>ahead". Anything unreadable becomes null — the panel renders an unknown as
/// unknown, never as zero. No I/O — cargo-tested below.
pub(crate) fn parse_left_right(raw: &str) -> (Option<u64>, Option<u64>) {
    let mut it = raw.split('\t');
    (
        it.next().and_then(|s| s.trim().parse().ok()),
        it.next().and_then(|s| s.trim().parse().ok()),
    )
}

/// Where a branch stands relative to its upstream, with no-upstream as an explicit STATE:
/// `has_upstream` selects what `ahead` describes (the remote, else the merge base with main).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct UpstreamStatus {
    has_upstream: bool,
    ahead: Option<u64>,
    behind: Option<u64>,
}

/// The narrow "no upstream" matcher. `rev-parse @{u}` is THE honest upstream probe and fails
/// exactly when none is set; that failure is a state, not a fault, so it is the ONLY error class
/// swallowed. Broad phrases like "no such branch" are deliberately NOT matched — those are real
/// failures the panel should surface rather than misread as "no upstream".
pub(crate) fn is_no_upstream_error(err: &str) -> bool {
    err.contains("no upstream configured for branch")
        || err.contains("HEAD does not point to a branch")
}

/// The upstream answer in one place, normalized to a state object. No upstream → `has_upstream:
/// false` with ahead measured against the merge base with main; any other git failure surfaces.
pub(crate) async fn upstream_state(worktree: &Path) -> Result<(Option<String>, UpstreamStatus), String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .output()
        .await
        .map_err(|e| format!("git could not start: {e}"))?;
    if out.status.success() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            // "behind<TAB>ahead" — left is the upstream-only count, right is HEAD-only.
            let counts = run_git_text_io(
                worktree,
                &["rev-list", "--left-right", "--count", &format!("{name}...HEAD")],
            )
            .await?;
            let (behind, ahead) = parse_left_right(&counts);
            return Ok((
                Some(name),
                UpstreamStatus { has_upstream: true, ahead, behind },
            ));
        }
        return Ok((None, UpstreamStatus { has_upstream: false, ahead: None, behind: None }));
    }
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    if !is_no_upstream_error(&err) {
        return Err(format!("git rev-parse @{{u}} failed: {}", err.trim()));
    }
    let ahead = match merge_base_async(worktree).await {
        Ok(base) => run_git_text_io(worktree, &["rev-list", "--count", &format!("{base}..HEAD")])
            .await?
            .trim()
            .parse()
            .ok(),
        // No upstream AND no main to measure against: say nothing rather than guess.
        Err(_) => None,
    };
    Ok((None, UpstreamStatus { has_upstream: false, ahead, behind: None }))
}

pub(crate) async fn git_panel_from_bus_dir(bus: &Path, project: &str, agent: &str) -> Result<GitPanel, String> {
    let worktree = seat_worktree(bus, project, agent)?;

    let branch = run_git_text_io(&worktree, &["branch", "--show-current"])
        .await?
        .trim()
        .to_string();

    let (upstream, upstream_status) = upstream_state(&worktree).await?;

    let status =
        parse_porcelain_v1(&run_git_text_io(&worktree, &["status", "--porcelain=v1", "-z"]).await?);
    let counts = parse_numstat(&run_git_text_io(&worktree, &["diff", "--numstat", "HEAD"]).await?);
    let log = parse_log_pretty(
        &run_git_text_io(
            &worktree,
            &["log", "--max-count=15", "--pretty=format:%h%x1f%an%x1f%ar%x1f%s"],
        )
        .await?,
    );

    Ok(GitPanel {
        branch,
        upstream,
        ahead: upstream_status.ahead,
        behind: upstream_status.behind,
        status,
        counts,
        log,
    })
}

#[tauri::command]
pub(crate) async fn git_panel(project: String, agent: String) -> Result<String, String> {
    serde_json::to_string(
        &git_panel_from_bus_dir(&desktop_bus_dir(), &project, &agent).await?,
    )
    .map_err(|e| e.to_string())
}

/// Prove `rel` stays inside `root`, symlinks and all: the shared path guard every git/fs handler
/// passes through. Canonicalize, then require a descendant of the canonical root; a missing final
/// component is checked by its nearest existing ancestor so unstage works on a deleted file.
pub(crate) fn resolve_within(root: &Path, rel: &str) -> Result<(), String> {
    if rel.is_empty() || rel.contains('\0') || Path::new(rel).is_absolute() {
        return Err(format!("path is invalid: {rel}"));
    }
    // A ".." component, anywhere, is traversal — reject it before any resolution: a path whose
    // final component does not exist yet would otherwise walk its ancestors back inside root and
    // read as contained when it is not.
    if rel.split('/').any(|c| c == "..") {
        return Err(format!("path is invalid: {rel}"));
    }
    let root = std::fs::canonicalize(root).map_err(|e| format!("cannot resolve worktree: {e}"))?;
    let full = root.join(rel);
    let mut probe = full.as_path();
    let resolved = loop {
        match std::fs::canonicalize(probe) {
            Ok(p) => break p,
            Err(_) => match probe.parent() {
                Some(parent) => probe = parent,
                None => return Err(format!("path escapes the worktree: {rel}")),
            },
        }
    };
    if !resolved.starts_with(&root) {
        return Err(format!("path escapes the worktree: {rel}"));
    }
    Ok(())
}

/// Relative paths only, each proven to stay inside `root` via `resolve_within`. Git accepts
/// absolute paths and pathspecs with "..", and the panel's inputs come from a UI listing, so
/// anything odd is a bug to name, not to honor.
pub(crate) fn clean_git_paths(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("no paths given".into());
    }
    paths
        .iter()
        .map(|p| {
            let p = p.trim();
            resolve_within(root, p)?;
            Ok(p.to_string())
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn git_stage(
    project: String,
    agent: String,
    paths: Vec<String>,
    unstage: bool,
) -> Result<(), String> {
    let worktree = seat_worktree(&desktop_bus_dir(), &project, &agent)?;
    git_mutation_guard(&agent).await?;
    let paths = clean_git_paths(&worktree, &paths)?;
    let mut args: Vec<&str> = if unstage {
        // `restore --staged`, not `reset -q HEAD --`: the modern spelling, and it un-stages a
        // file even before the first commit, which `reset HEAD` cannot do.
        vec!["restore", "--staged", "--"]
    } else {
        vec!["add", "--"]
    };
    args.extend(paths.iter().map(String::as_str));
    git_run(&worktree, &args).await
}

#[tauri::command]
pub(crate) async fn git_commit(project: String, agent: String, message: String) -> Result<String, String> {
    let worktree = seat_worktree(&desktop_bus_dir(), &project, &agent)?;
    git_mutation_guard(&agent).await?;
    let msg = message.trim();
    if msg.is_empty() {
        return Err("commit message is empty".into());
    }
    // Commits what is STAGED, nothing more — the panel's staging list is the whole contract, and
    // a surprise `git add -A` under a human's finger is how unrelated seat work gets swept in.
    git_run(&worktree, &["commit", "-q", "-m", msg]).await?;
    run_git_text_io(&worktree, &["rev-parse", "--short", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
}

#[tauri::command]
pub(crate) async fn git_push(project: String, agent: String) -> Result<String, String> {
    let worktree = seat_worktree(&desktop_bus_dir(), &project, &agent)?;
    git_mutation_guard(&agent).await?;
    let branch = run_git_text_io(&worktree, &["branch", "--show-current"])
        .await?
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err("detached HEAD — there is no branch name to push".into());
    }
    // -u so the first push also SETS the upstream: every later panel read then measures
    // ahead/behind against the real thing instead of falling back to the merge base.
    git_run(&worktree, &["push", "-u", "origin", &branch]).await?;
    Ok(branch)
}

#[cfg(test)]
mod git_panel_tests {
    use super::*;

    #[test]
    fn porcelain_reads_staged_unstaged_and_untracked_rows() {
        let rows = parse_porcelain_v1(
            "M  staged-only.ts\0 M worktree-only.ts\0MM both.ts\0?? brand-new.ts\0A  staged-new.ts\0 D gone.ts\0",
        );
        assert_eq!(
            rows,
            vec![
                GitStatusEntry { path: "staged-only.ts".into(), x: "M".into(), y: " ".into() },
                GitStatusEntry { path: "worktree-only.ts".into(), x: " ".into(), y: "M".into() },
                GitStatusEntry { path: "both.ts".into(), x: "M".into(), y: "M".into() },
                GitStatusEntry { path: "brand-new.ts".into(), x: "?".into(), y: "?".into() },
                GitStatusEntry { path: "staged-new.ts".into(), x: "A".into(), y: " ".into() },
                GitStatusEntry { path: "gone.ts".into(), x: " ".into(), y: "D".into() },
            ]
        );
    }

    #[test]
    fn porcelain_takes_a_renames_new_name_unquoted() {
        // -z emits the NEW path first, then the origin as a second NUL field — no " -> " and no
        // quoting, which is exactly why a path with a space survives the round trip.
        let rows = parse_porcelain_v1("R  new name.rs\0old/name.rs\0");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "new name.rs");
        assert_eq!(rows[0].x, "R");
        assert_eq!(rows[0].y, " ");
    }

    #[test]
    fn porcelain_skips_a_renames_origin_field() {
        // The origin path is a record's own NUL field; the parser must consume it, not emit it as a
        // bogus entry, and still parse the record after it.
        let rows = parse_porcelain_v1("R  new name.rs\0old/name.rs\0M  other.ts\0");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].path, "new name.rs");
        assert_eq!(rows[0].x, "R");
        assert_eq!(rows[1].path, "other.ts");
        assert_eq!(rows[1].x, "M");
    }

    #[test]
    fn porcelain_skips_rows_too_short_to_carry_a_path() {
        assert!(parse_porcelain_v1("\0ab\0abc\0").is_empty());
    }

    #[test]
    fn log_pretty_reads_unit_separated_rows_and_skips_malformed_ones() {
        let log = parse_log_pretty(
            "abc1234\x1fAda\x1f2 hours ago\x1ffix: the thing\n\
             short\x1fonly-three-fields\n\
             \n\
             1234567\x1fBob\x1f3 days ago\x1fsubject | with a pipe\x1ftrailing\n\
             5678efg\x1fCara\x1fjust now\x1fadd: panel\n",
        );
        // the 3-field row and the 5-field row are skipped, never guessed at; the empty line too
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].sha, "abc1234");
        assert_eq!(log[0].author, "Ada");
        assert_eq!(log[0].when, "2 hours ago");
        assert_eq!(log[0].subject, "fix: the thing");
        assert_eq!(log[1].sha, "5678efg");
        assert_eq!(log[1].subject, "add: panel");
    }

    #[test]
    fn left_right_counts_behind_tab_ahead_and_garbage_is_null() {
        assert_eq!(parse_left_right("0\t3\n"), (Some(0), Some(3)));
        assert_eq!(parse_left_right("2\t0"), (Some(2), Some(0)));
        assert_eq!(parse_left_right("nonsense"), (None, None));
        assert_eq!(parse_left_right(""), (None, None));
    }

    #[test]
    fn clean_git_paths_rejects_traversal_absolute_and_empty() {
        let root = std::env::temp_dir().join("git-guard-clean-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(clean_git_paths(&root, &["..".into()]).is_err());
        assert!(clean_git_paths(&root, &["a/../../b".into()]).is_err());
        assert!(clean_git_paths(&root, &["/etc/passwd".into()]).is_err());
        assert!(clean_git_paths(&root, &["  ".into()]).is_err());
        assert!(clean_git_paths(&root, &[]).is_err());
        assert_eq!(
            clean_git_paths(&root, &[" src/a.rs ".into()]).unwrap(),
            vec!["src/a.rs".to_string()]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_within_refuses_a_symlink_that_points_outside() {
        // A symlink INSIDE the worktree that points out to a sibling directory is the escape a
        // textual "no .." check cannot see: canonicalize follows the link and lands outside.
        let root = std::env::temp_dir().join("git-guard-symlink-root");
        let outside = std::env::temp_dir().join("git-guard-symlink-outside");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        assert!(resolve_within(&root, "escape/secret.txt").is_err());
        assert!(resolve_within(&root, "escape").is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn no_upstream_is_the_only_swallowed_upstream_error() {
        assert!(is_no_upstream_error("fatal: no upstream configured for branch 'seat/glm'"));
        assert!(is_no_upstream_error("fatal: HEAD does not point to a branch"));
        assert!(!is_no_upstream_error("fatal: no such branch 'foo'"));
        assert!(!is_no_upstream_error("fatal: not a git repository"));
    }

    #[test]
    fn seat_worktree_rejects_traversal_and_missing_dirs() {
        let bus = std::env::temp_dir().join("git-panel-tests-nonexistent");
        assert!(seat_worktree(&bus, "..", "glm").is_err());
        assert!(seat_worktree(&bus, "trantor", "a/b").is_err());
        assert!(seat_worktree(&bus, "", "glm").is_err());
        assert!(seat_worktree(&bus, "trantor", "glm").is_err());
    }
}

// ── self-update ────────────────────────────────────────────────────────────────────────────────
// Same release discovery as bin/app.mjs (any release carrying a Trantor_*.dmg, newest wins), run
// in-process so it needs no CLI on PATH: a Finder-launched app gets a bare PATH.
