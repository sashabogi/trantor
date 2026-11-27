use super::*;
use std::process::Command;

struct Fixture {
    tmp: std::path::PathBuf,
    repo: std::path::PathBuf,
    remote: std::path::PathBuf,
    trash: std::path::PathBuf,
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git run");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn config(repo: &Path, tmp: &Path) {
    let hooks = tmp.join("no-hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for (key, value) in [
        ("user.email", "t@t".to_string()),
        ("user.name", "Tess".to_string()),
        ("commit.gpgsign", "false".to_string()),
        ("core.hooksPath", hooks.to_string_lossy().to_string()),
    ] {
        git(repo, &["config", key, &value]);
    }
}

fn commit_file(repo: &Path, path: &str, body: &str, message: &str) {
    let full = repo.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(full, body).unwrap();
    git(repo, &["add", "--", path]);
    git(repo, &["commit", "-qm", message]);
}

fn fixture(tag: &str) -> Fixture {
    let tmp = std::env::temp_dir().join(format!("trantor-g1-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let repo = tmp.join("repo");
    let remote = tmp.join("remote.git");
    let trash = tmp.join("trash");
    std::fs::create_dir_all(&repo).unwrap();
    git(&tmp, &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&repo, &["init", "-q", "-b", "main"]);
    config(&repo, &tmp);
    commit_file(&repo, "a.txt", "one\n", "first");
    git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&repo, &["push", "-qu", "origin", "main"]);
    git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    Fixture { tmp, repo, remote, trash }
}

fn second_clone(f: &Fixture, tag: &str) -> std::path::PathBuf {
    let clone = f.tmp.join(tag);
    git(&f.tmp, &["clone", "-q", f.remote.to_str().unwrap(), clone.to_str().unwrap()]);
    config(&clone, &f.tmp);
    clone
}

fn head(repo: &Path) -> String {
    git(repo, &["rev-parse", "HEAD"]).trim().to_string()
}

#[tokio::test]
async fn push_updates_only_the_local_bare_remote() {
    let f = fixture("push");
    commit_file(&f.repo, "local.txt", "local\n", "local commit");
    assert_eq!(git_push_at(&f.repo).await.unwrap(), "main");
    assert_eq!(head(&f.repo), head(&f.remote));
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn push_refuses_non_fast_forward_instead_of_forcing() {
    let f = fixture("push-diverged");
    let other = second_clone(&f, "other");
    commit_file(&other, "remote.txt", "remote\n", "remote commit");
    git(&other, &["push", "-q"]);
    let remote_head = head(&f.remote);
    commit_file(&f.repo, "local.txt", "local\n", "local commit");
    assert!(git_push_at(&f.repo).await.is_err());
    assert_eq!(head(&f.remote), remote_head);
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn pull_fast_forwards_from_a_local_bare_remote() {
    let f = fixture("pull-ff");
    let other = second_clone(&f, "other");
    commit_file(&other, "remote.txt", "remote\n", "remote commit");
    git(&other, &["push", "-q"]);
    let result = git_pull_at(&f.repo, PullStrategy::FastForward).await.unwrap();
    assert_eq!(result.status, "pulled");
    assert_eq!(std::fs::read_to_string(f.repo.join("remote.txt")).unwrap(), "remote\n");
    assert_eq!(head(&f.repo), head(&f.remote));
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn diverged_pull_names_the_choice_then_merges_when_clicked() {
    let f = fixture("pull-merge");
    let other = second_clone(&f, "other");
    commit_file(&other, "remote.txt", "remote\n", "remote commit");
    git(&other, &["push", "-q"]);
    commit_file(&f.repo, "local.txt", "local\n", "local commit");
    let result = git_pull_at(&f.repo, PullStrategy::FastForward).await.unwrap();
    assert_eq!(result.status, "diverged");
    assert!(result.reason.contains("Merge or Rebase"));
    assert!(git(&f.repo, &["status", "--porcelain"]).is_empty());
    let merged = git_pull_at(&f.repo, PullStrategy::Merge).await.unwrap();
    assert_eq!(merged.status, "pulled");
    assert!(f.repo.join("local.txt").is_file() && f.repo.join("remote.txt").is_file());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn diverged_pull_can_rebase_when_clicked() {
    let f = fixture("pull-rebase");
    let other = second_clone(&f, "other");
    commit_file(&other, "remote.txt", "remote\n", "remote commit");
    git(&other, &["push", "-q"]);
    commit_file(&f.repo, "local.txt", "local\n", "local commit");
    let result = git_pull_at(&f.repo, PullStrategy::Rebase).await.unwrap();
    assert_eq!(result.status, "pulled");
    assert_eq!(git(&f.repo, &["log", "-1", "--format=%s"]).trim(), "local commit");
    assert!(f.repo.join("remote.txt").is_file());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn discard_all_backs_up_tracked_untracked_and_staged_new_files() {
    let f = fixture("discard-all");
    std::fs::write(f.repo.join("a.txt"), "changed\n").unwrap();
    std::fs::create_dir_all(f.repo.join("nested")).unwrap();
    std::fs::write(f.repo.join("nested/new.txt"), "new\n").unwrap();
    std::fs::write(f.repo.join("staged.txt"), "staged\n").unwrap();
    git(&f.repo, &["add", "staged.txt"]);
    let backup = std::path::PathBuf::from(git_discard_in(&f.repo, None, &f.trash).await.unwrap());
    assert_eq!(std::fs::read_to_string(backup.join("a.txt")).unwrap(), "changed\n");
    assert_eq!(std::fs::read_to_string(backup.join("nested/new.txt")).unwrap(), "new\n");
    assert_eq!(std::fs::read_to_string(backup.join("staged.txt")).unwrap(), "staged\n");
    assert_eq!(std::fs::read_to_string(f.repo.join("a.txt")).unwrap(), "one\n");
    assert!(!f.repo.join("nested").exists() && !f.repo.join("staged.txt").exists());
    assert!(git(&f.repo, &["status", "--porcelain"]).is_empty());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn discard_all_puts_a_renamed_file_back_under_its_old_name() {
    let f = fixture("discard-rename");
    git(&f.repo, &["mv", "a.txt", "moved.txt"]);
    git_discard_in(&f.repo, None, &f.trash).await.unwrap();
    assert_eq!(std::fs::read_to_string(f.repo.join("a.txt")).unwrap(), "one\n");
    assert!(!f.repo.join("moved.txt").exists());
    assert!(git(&f.repo, &["status", "--porcelain"]).is_empty());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn discard_refuses_an_untracked_folder_that_holds_another_checkout() {
    let f = fixture("discard-nested");
    std::fs::write(f.repo.join("a.txt"), "changed\n").unwrap();
    let nested = f.repo.join("scratch/trees/one");
    std::fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "-q"]);
    let err = git_discard_in(&f.repo, None, &f.trash).await.unwrap_err();
    assert!(err.contains("holds another git checkout"), "{err}");
    assert_eq!(std::fs::read_to_string(f.repo.join("a.txt")).unwrap(), "changed\n");
    assert!(nested.join(".git").exists() && !f.trash.exists());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn discard_one_file_leaves_every_other_change_alone() {
    let f = fixture("discard-one");
    commit_file(&f.repo, "b.txt", "original\n", "add b");
    std::fs::write(f.repo.join("a.txt"), "changed\n").unwrap();
    std::fs::write(f.repo.join("b.txt"), "keep this change\n").unwrap();
    let backup = git_discard_in(&f.repo, Some(&["a.txt".into()]), &f.trash).await.unwrap();
    assert!(std::path::PathBuf::from(backup).join("a.txt").is_file());
    assert_eq!(std::fs::read_to_string(f.repo.join("a.txt")).unwrap(), "one\n");
    assert_eq!(std::fs::read_to_string(f.repo.join("b.txt")).unwrap(), "keep this change\n");
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn stash_save_list_apply_pop_and_drop_include_untracked_files() {
    let f = fixture("stash");
    std::fs::write(f.repo.join("a.txt"), "stashed\n").unwrap();
    std::fs::write(f.repo.join("new.txt"), "new\n").unwrap();
    git_stash_save_at(&f.repo, "work in progress").await.unwrap();
    assert!(git(&f.repo, &["status", "--porcelain"]).is_empty());
    let list = git_stash_list_at(&f.repo).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "stash@{0}");
    assert!(list[0].message.contains("work in progress"));
    git_stash_change_at(&f.repo, &list[0].name, "apply").await.unwrap();
    assert_eq!(std::fs::read_to_string(f.repo.join("new.txt")).unwrap(), "new\n");
    git_stash_change_at(&f.repo, &list[0].name, "drop").await.unwrap();
    assert!(git_stash_list_at(&f.repo).await.unwrap().is_empty());
    git_stash_save_at(&f.repo, "pop me").await.unwrap();
    git_stash_change_at(&f.repo, "stash@{0}", "pop").await.unwrap();
    assert!(git_stash_list_at(&f.repo).await.unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(f.repo.join("a.txt")).unwrap(), "stashed\n");
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn stash_requires_a_message_a_change_and_a_real_stash_reference() {
    let f = fixture("stash-guard");
    assert!(git_stash_save_at(&f.repo, "empty").await.is_err());
    std::fs::write(f.repo.join("a.txt"), "changed\n").unwrap();
    assert!(git_stash_save_at(&f.repo, "  ").await.is_err());
    for bad in ["HEAD", "stash@{x}", "stash@{0};push", "--help"] {
        assert!(git_stash_change_at(&f.repo, bad, "apply").await.is_err());
    }
    assert!(git_stash_change_at(&f.repo, "stash@{0}", "force").await.is_err());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn sync_without_a_remote_reports_the_same_reason_as_the_snapshot() {
    let f = fixture("sync-no-remote");
    git(&f.repo, &["remote", "remove", "origin"]);
    let panel = git_panel_at(&f.repo, 1).await.unwrap();
    assert_eq!(panel.remote, None);
    assert_eq!(serde_json::to_value(&panel).unwrap()["remote"], serde_json::Value::Null);
    assert_eq!(git_fetch_at(&f.repo).await.unwrap_err(), "This repository has no remote");
    assert_eq!(git_pull_at(&f.repo, PullStrategy::FastForward).await.unwrap_err(), "This repository has no remote");
    assert_eq!(git_push_at(&f.repo).await.unwrap_err(), "This repository has no remote");
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn sync_uses_the_named_remote_for_snapshot_fetch_pull_and_push() {
    let f = fixture("sync-named-remote");
    git(&f.repo, &["remote", "rename", "origin", "upstream"]);
    let panel = git_panel_at(&f.repo, 1).await.unwrap();
    assert_eq!(panel.remote.as_deref(), Some("upstream"));
    assert_eq!(serde_json::to_value(&panel).unwrap()["remote"], "upstream");
    let other = second_clone(&f, "other");
    commit_file(&other, "remote.txt", "remote\n", "remote commit");
    git(&other, &["push", "-q"]);
    git_fetch_at(&f.repo).await.unwrap();
    assert_eq!(git(&f.repo, &["rev-parse", "upstream/main"]).trim(), head(&f.remote));
    assert_eq!(git_pull_at(&f.repo, PullStrategy::FastForward).await.unwrap().status, "pulled");
    assert_eq!(head(&f.repo), head(&f.remote));
    commit_file(&f.repo, "local.txt", "local\n", "local commit");
    git_push_at(&f.repo).await.unwrap();
    assert_eq!(head(&f.repo), head(&f.remote));
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn sync_remote_prefers_the_branch_remote_then_origin_then_the_first_remote() {
    let f = fixture("sync-remote-selection");
    git(&f.repo, &["remote", "add", "upstream", f.remote.to_str().unwrap()]);
    git(&f.repo, &["config", "branch.main.remote", "upstream"]);
    assert_eq!(sync_remote(&f.repo).await.unwrap().as_deref(), Some("upstream"));
    git(&f.repo, &["config", "--unset", "branch.main.remote"]);
    assert_eq!(sync_remote(&f.repo).await.unwrap().as_deref(), Some("origin"));
    git(&f.repo, &["remote", "remove", "origin"]);
    assert_eq!(sync_remote(&f.repo).await.unwrap().as_deref(), Some("upstream"));
    git(&f.repo, &["config", "branch.main.remote", "."]);
    assert_eq!(sync_remote(&f.repo).await.unwrap().as_deref(), Some("upstream"));
    git(&f.repo, &["checkout", "-q", "--detach"]);
    assert_eq!(sync_remote(&f.repo).await.unwrap().as_deref(), Some("upstream"));
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn a_worktree_snapshot_sees_the_shared_remote_configuration() {
    let f = fixture("sync-worktree");
    let worktree = f.tmp.join("seat");
    git(&f.repo, &["worktree", "add", "-qb", "seat", worktree.to_str().unwrap()]);
    assert_eq!(git_panel_at(&worktree, 1).await.unwrap().remote.as_deref(), Some("origin"));
    git(&f.repo, &["remote", "remove", "origin"]);
    assert_eq!(git_panel_at(&worktree, 1).await.unwrap().remote, None);
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn a_fresh_repo_with_no_commits_reads_as_new_not_as_an_error() {
    // `git init` and nothing else: the branch is unborn, so @{u}, `diff HEAD` and `log` all fail.
    let tmp = std::env::temp_dir().join(format!("git-panel-unborn-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    git(&tmp, &["init", "-q", "-b", "main"]);
    assert!(!has_commits(&tmp).await);
    let panel = git_panel_at(&tmp, 5).await.expect("an unborn branch is a state, not a failure");
    assert_eq!(panel.branch, "main");
    assert_eq!(panel.upstream, None);
    assert!(panel.log.is_empty());
    // a staged file shows up as a change with its line count
    std::fs::write(tmp.join("a.txt"), "one\ntwo\n").unwrap();
    git(&tmp, &["add", "a.txt"]);
    let panel = git_panel_at(&tmp, 5).await.unwrap();
    assert_eq!(panel.status.len(), 1);
    assert_eq!(panel.counts.len(), 1);
    // after the first commit the normal path takes over
    git(&tmp, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"]);
    assert!(has_commits(&tmp).await);
    assert_eq!(git_panel_at(&tmp, 5).await.unwrap().log.len(), 1);
    let _ = std::fs::remove_dir_all(&tmp);
}
