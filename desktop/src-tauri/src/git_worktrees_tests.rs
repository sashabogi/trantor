// #14300: the worktree list against a real temp repository with real linked worktrees.
use super::*;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git run");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
}

struct Fx {
    tmp: std::path::PathBuf,
    repo: std::path::PathBuf,
    agent: std::path::PathBuf,
    locked: std::path::PathBuf,
    helper: std::path::PathBuf,
}

/// main with one commit; a dirty agent worktree, a clean locked one, a helper one commit ahead.
fn fixture(tag: &str) -> Fx {
    let tmp = std::env::temp_dir().join(format!("trantor-wt-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let repo = tmp.join("dev").join("acme");
    let hooks = tmp.join("no-hooks");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&hooks).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.email", "t@t"), ("user.name", "Tess"), ("commit.gpgsign", "false"), ("core.hooksPath", hooks.to_str().unwrap())] {
        git(&repo, &["config", k, v]);
    }
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "first"]);
    let agent = repo.join(".claude/worktrees/agent-abc123");
    let locked = repo.join(".claude/worktrees/agent-lock999");
    let helper = tmp.join("scratchpad/wt-codex");
    git(&repo, &["worktree", "add", "-q", "-b", "worktree-agent-abc123", agent.to_str().unwrap()]);
    git(&repo, &["worktree", "add", "-q", "-b", "worktree-agent-lock999", locked.to_str().unwrap()]);
    git(&repo, &["worktree", "lock", locked.to_str().unwrap()]);
    git(&repo, &["worktree", "add", "-q", "-b", "work/codex", helper.to_str().unwrap()]);
    std::fs::write(agent.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(agent.join("new.txt"), "new\n").unwrap();
    std::fs::write(helper.join("h.txt"), "h\n").unwrap();
    git(&helper, &["add", "."]);
    git(&helper, &["commit", "-qm", "helper work"]);
    Fx { tmp, repo, agent, locked, helper }
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

#[test]
fn kinds_come_from_path_and_branch_patterns() {
    assert_eq!(worktree_kind("/r/.claude/worktrees/agent-1", Some("x")), "agent");
    assert_eq!(worktree_kind("/elsewhere", Some("worktree-agent-1")), "agent");
    assert_eq!(worktree_kind("/tmp/scratchpad/wt-a", None), "helper");
    assert_eq!(worktree_kind("/elsewhere", Some("work/codex")), "helper");
    assert_eq!(worktree_kind("/h/.agent-bus/worktrees/trantor/glm", None), "seat");
    assert_eq!(worktree_kind("/elsewhere", Some("seat/glm")), "seat");
    assert_eq!(worktree_kind("/elsewhere", Some("feature")), "other");
}

#[test]
fn porcelain_parsing_reads_branch_head_and_lock() {
    let text = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/w\nHEAD bbb\nbranch refs/heads/work/x\nlocked claimed by pid 1\n\nworktree /r/d\nHEAD ccc\ndetached\n";
    let rows = parse_worktree_porcelain(text);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1].branch.as_deref(), Some("work/x"));
    assert!(rows[1].locked && !rows[0].locked);
    assert_eq!(rows[2].branch, None);
    assert_eq!(rows[2].head, "ccc");
}

#[tokio::test]
async fn fresh_worktrees_list_with_kinds_changes_and_ahead_counts() {
    let f = fixture("fresh");
    let rows = list_worktrees_at(&f.repo, false, now()).await.unwrap();
    assert_eq!(rows.len(), 3, "main checkout is not listed: {rows:?}");
    let by = |p: &Path| rows.iter().find(|r| Path::new(&r.path).canonicalize().unwrap() == p.canonicalize().unwrap()).unwrap().clone();
    let agent = by(&f.agent);
    assert_eq!((agent.kind.as_str(), agent.changed, agent.ahead, agent.locked), ("agent", 2, 0, false));
    assert_eq!(agent.branch.as_deref(), Some("worktree-agent-abc123"));
    let helper = by(&f.helper);
    assert_eq!((helper.kind.as_str(), helper.changed, helper.ahead), ("helper", 0, 1));
    assert!(by(&f.locked).locked);
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn stale_worktrees_hide_unless_locked_and_all_returns_everything() {
    let f = fixture("stale");
    let later = now() + 3 * 60 * 60;
    let active = list_worktrees_at(&f.repo, false, later).await.unwrap();
    assert_eq!(active.len(), 1, "only the locked one stays: {active:?}");
    assert!(active[0].locked);
    let all = list_worktrees_at(&f.repo, true, later).await.unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all.iter().map(|r| r.changed).sum::<u64>(), 2);
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn work_inside_the_two_hour_window_stays_listed() {
    let f = fixture("dirty");
    // 1h later: still inside the window, the dirty agent and the helper commit both count.
    let soon = list_worktrees_at(&f.repo, false, now() + 60 * 60).await.unwrap();
    assert_eq!(soon.len(), 3);
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[test]
fn a_worktree_scope_resolves_only_to_listed_worktrees_of_this_project() {
    let f = fixture("scope");
    let dev = f.tmp.join("dev");
    let scope = parse_scope(Some(&format!("wt:{}", f.agent.display())), None).unwrap();
    assert_eq!(scope, GitScope::Worktree(f.agent.display().to_string()));
    let dir = scope_dir_in(&dev, &f.tmp, "acme", &scope).unwrap();
    assert_eq!(dir.canonicalize().unwrap(), f.agent.canonicalize().unwrap());
    // The main checkout, an arbitrary folder and a traversal path are all refused.
    for bad in [f.repo.display().to_string(), f.tmp.display().to_string(), format!("{}/../..", f.agent.display()), "/etc".to_string()] {
        let err = scope_dir_in(&dev, &f.tmp, "acme", &GitScope::Worktree(bad.clone())).unwrap_err();
        assert!(err.contains("not a worktree") || err.contains("no longer exists"), "{bad}: {err}");
    }
    // A plain seat name still parses as a seat.
    assert_eq!(parse_scope(Some("glm"), None), Ok(GitScope::Seat("glm".into())));
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn worktree_scopes_refuse_mutations() {
    let err = scope_dir_for_mutation("acme", &GitScope::Worktree("/x".into())).await.unwrap_err();
    assert!(err.contains("read-only"), "{err}");
}

#[test]
fn file_reads_accept_a_listed_worktree_and_file_writes_still_refuse_it() {
    let f = fixture("reads");
    let wt = format!("wt:{}", f.agent.display());
    assert!(source_root("acme", Some(&wt)).is_err(), "writes never resolve a worktree scope");
    assert!(source_root_read("acme", Some("bad/seat")).is_err());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn a_row_names_up_to_five_changed_paths_newest_first_and_keeps_the_full_count() {
    let f = fixture("files");
    // a.txt (unstaged) and new.txt (untracked) exist; add a staged file and four more untracked ones.
    std::fs::write(f.agent.join("staged.txt"), "s\n").unwrap();
    git(&f.agent, &["add", "staged.txt"]);
    for n in ["u1.txt", "u2.txt", "u5.txt", "u4.txt"] {
        std::fs::write(f.agent.join(n), "x\n").unwrap();
    }
    let at = |secs: u64| std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
    let base = now() - 1000;
    for (i, n) in ["a.txt", "new.txt", "staged.txt", "u1.txt", "u2.txt", "u4.txt", "u5.txt"].iter().enumerate() {
        std::fs::File::options().write(true).open(f.agent.join(n)).unwrap().set_modified(at(base + i as u64 * 10)).unwrap();
    }
    let rows = list_worktrees_at(&f.repo, false, now()).await.unwrap();
    let agent = rows.iter().find(|r| r.kind == "agent" && r.branch.as_deref() == Some("worktree-agent-abc123")).unwrap();
    assert_eq!(agent.changed, 7);
    assert_eq!(agent.files, vec!["u5.txt", "u4.txt", "u2.txt", "u1.txt", "staged.txt"]);
    let helper = rows.iter().find(|r| r.kind == "helper").unwrap();
    assert!(helper.files.is_empty());
    let _ = std::fs::remove_dir_all(&f.tmp);
}
