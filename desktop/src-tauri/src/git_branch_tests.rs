use super::*;
use std::process::Command;

struct Fixture {
    tmp: std::path::PathBuf,
    repo: std::path::PathBuf,
    remote: std::path::PathBuf,
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
    let tmp = std::env::temp_dir().join(format!("trantor-g2-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let repo = tmp.join("repo");
    let remote = tmp.join("remote.git");
    std::fs::create_dir_all(&repo).unwrap();
    git(&tmp, &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&repo, &["init", "-q", "-b", "main"]);
    config(&repo, &tmp);
    commit_file(&repo, "a.txt", "one\n", "first");
    git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&repo, &["push", "-qu", "origin", "main"]);
    git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    Fixture { tmp, repo, remote }
}

fn branch(repo: &Path) -> String {
    git(repo, &["branch", "--show-current"]).trim().to_string()
}

#[tokio::test]
async fn lists_local_remote_tracking_and_worktree_branches() {
    let f = fixture("list");
    git(&f.repo, &["switch", "-qc", "feature"]);
    commit_file(&f.repo, "feature.txt", "feature\n", "feature");
    git(&f.repo, &["push", "-qu", "origin", "feature"]);
    let other = f.tmp.join("other");
    git(&f.tmp, &["clone", "-q", f.remote.to_str().unwrap(), other.to_str().unwrap()]);
    config(&other, &f.tmp);
    git(&other, &["switch", "-qc", "feature", "origin/feature"]);
    commit_file(&other, "remote.txt", "remote\n", "remote");
    git(&other, &["push", "-q", "origin", "feature"]);
    commit_file(&f.repo, "local.txt", "local\n", "local");
    git(&f.repo, &["fetch", "-q", "origin"]);
    git(&f.repo, &["worktree", "add", "-q", f.tmp.join("held").to_str().unwrap(), "main"]);
    let list = git_branch_list_at(&f.repo).await.unwrap();
    let feature = list.branches.iter().find(|b| b.name == "feature" && !b.remote).unwrap();
    assert_eq!((feature.ahead, feature.behind, feature.current), (Some(1), Some(1), true));
    assert!(feature.committed_at > 0 && feature.sha.len() == 40);
    let held = list.branches.iter().find(|b| b.name == "main" && !b.remote).unwrap();
    assert!(held.worktree.is_some());
    assert!(list.branches.iter().any(|b| b.name == "origin/feature" && b.remote));
    assert!(!list.branches.iter().any(|b| b.name == "origin/HEAD"));
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn creates_from_a_commit_switches_and_renames() {
    let f = fixture("create");
    let first = head(&f.repo);
    commit_file(&f.repo, "second.txt", "second\n", "second");
    assert!(git_branch_create_at(&f.repo, "--bad", None).await.is_err());
    git_branch_create_at(&f.repo, "topic", Some(&first)).await.unwrap();
    git_branch_switch_at(&f.repo, "topic", "bring").await.unwrap();
    assert_eq!(branch(&f.repo), "topic");
    assert!(!f.repo.join("second.txt").exists());
    git_branch_rename_at(&f.repo, "topic", "renamed").await.unwrap();
    assert_eq!(branch(&f.repo), "renamed");
    let _ = std::fs::remove_dir_all(&f.tmp);
}

fn head(repo: &Path) -> String {
    git(repo, &["rev-parse", "HEAD"]).trim().to_string()
}

#[tokio::test]
async fn dirty_switch_can_bring_changes_or_stash_with_the_target_name() {
    let f = fixture("dirty");
    git(&f.repo, &["branch", "topic"]);
    std::fs::write(f.repo.join("a.txt"), "brought\n").unwrap();
    let ask = git_branch_switch_at(&f.repo, "topic", "ask").await.unwrap();
    assert_eq!(ask.status, "dirty");
    assert_eq!(branch(&f.repo), "main");
    git_branch_switch_at(&f.repo, "topic", "bring").await.unwrap();
    assert_eq!(std::fs::read_to_string(f.repo.join("a.txt")).unwrap(), "brought\n");
    git_branch_switch_at(&f.repo, "main", "stash").await.unwrap();
    assert!(git(&f.repo, &["status", "--porcelain"]).is_empty());
    let stashes = git_stash_list_at(&f.repo).await.unwrap();
    assert_eq!(stashes.len(), 1);
    assert!(stashes[0].message.contains("Before switching to main"));
    git_stash_change_at(&f.repo, "stash@{0}", "pop").await.unwrap();
    assert_eq!(std::fs::read_to_string(f.repo.join("a.txt")).unwrap(), "brought\n");
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn stash_switch_restores_a_rename_under_its_new_and_old_names() {
    let f = fixture("rename-status");
    git(&f.repo, &["branch", "topic"]);
    git(&f.repo, &["mv", "a.txt", "moved.txt"]);
    git_branch_switch_at(&f.repo, "topic", "stash").await.unwrap();
    assert!(f.repo.join("a.txt").is_file());
    git_stash_change_at(&f.repo, "stash@{0}", "apply").await.unwrap();
    assert!(f.repo.join("moved.txt").is_file());
    assert!(!f.repo.join("a.txt").exists());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn stash_switch_refuses_an_untracked_folder_holding_a_checkout() {
    let f = fixture("nested");
    git(&f.repo, &["branch", "topic"]);
    let nested = f.repo.join("scratch/checkout");
    std::fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "-q"]);
    let error = git_branch_switch_at(&f.repo, "topic", "stash").await.unwrap_err();
    assert!(error.contains("holds another git checkout"), "{error}");
    assert_eq!(branch(&f.repo), "main");
    assert!(nested.join(".git").exists());
    assert!(git_stash_list_at(&f.repo).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn delete_protects_main_and_checked_out_branches_and_counts_unique_commits() {
    let f = fixture("delete");
    git(&f.repo, &["switch", "-qc", "topic"]);
    commit_file(&f.repo, "one.txt", "one\n", "one");
    commit_file(&f.repo, "two.txt", "two\n", "two");
    let current = git_branch_delete_at(&f.repo, "topic", true).await.unwrap_err();
    assert!(current.contains("checked out"), "{current}");
    git(&f.repo, &["switch", "-q", "main"]);
    assert!(git_branch_delete_at(&f.repo, "main", true).await.is_err());
    let ask = git_branch_delete_at(&f.repo, "topic", false).await.unwrap();
    assert_eq!((ask.status.as_str(), ask.unique), ("confirm", 2));
    assert!(local_branch_exists(&f.repo, "topic").await);
    let deleted = git_branch_delete_at(&f.repo, "topic", true).await.unwrap();
    assert_eq!((deleted.status.as_str(), deleted.unique), ("deleted", 2));
    assert!(!local_branch_exists(&f.repo, "topic").await);
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn delete_refuses_a_branch_checked_out_in_another_worktree() {
    let f = fixture("other-worktree");
    git(&f.repo, &["branch", "held"]);
    let held = f.tmp.join("held");
    git(&f.repo, &["worktree", "add", "-q", held.to_str().unwrap(), "held"]);
    let error = git_branch_delete_at(&f.repo, "held", true).await.unwrap_err();
    assert!(error.contains(held.to_str().unwrap()), "{error}");
    let rename = git_branch_rename_at(&f.repo, "held", "renamed").await.unwrap_err();
    assert!(rename.contains("another worktree"), "{rename}");
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn merge_conflict_returns_the_unmerged_path_and_keeps_git_paused() {
    let f = fixture("merge-conflict");
    git(&f.repo, &["switch", "-qc", "topic"]);
    commit_file(&f.repo, "a.txt", "topic\n", "topic");
    git(&f.repo, &["switch", "-q", "main"]);
    commit_file(&f.repo, "a.txt", "main\n", "main");
    let result = git_branch_integrate_at(&f.repo, "topic", "merge").await.unwrap();
    assert_eq!(result.status, "conflict");
    assert_eq!(result.conflicts, vec!["a.txt"]);
    assert!(f.repo.join(".git/MERGE_HEAD").exists());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn rebase_conflict_returns_the_unmerged_path_and_keeps_git_paused() {
    let f = fixture("rebase-conflict");
    git(&f.repo, &["switch", "-qc", "topic"]);
    commit_file(&f.repo, "a.txt", "topic\n", "topic");
    git(&f.repo, &["switch", "-q", "main"]);
    commit_file(&f.repo, "a.txt", "main\n", "main");
    git(&f.repo, &["switch", "-q", "topic"]);
    let result = git_branch_integrate_at(&f.repo, "main", "rebase").await.unwrap();
    assert_eq!(result.status, "conflict");
    assert_eq!(result.conflicts, vec!["a.txt"]);
    assert!(f.repo.join(".git/rebase-merge").exists() || f.repo.join(".git/rebase-apply").exists());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn switching_to_a_remote_branch_creates_its_local_tracking_branch() {
    let f = fixture("remote-switch");
    git(&f.repo, &["switch", "-qc", "topic"]);
    commit_file(&f.repo, "topic.txt", "topic\n", "topic");
    git(&f.repo, &["push", "-qu", "origin", "topic"]);
    git(&f.repo, &["switch", "-q", "main"]);
    git(&f.repo, &["branch", "-D", "topic"]);
    git_branch_switch_at(&f.repo, "origin/topic", "bring").await.unwrap();
    assert_eq!(branch(&f.repo), "topic");
    assert_eq!(git(&f.repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(), "origin/topic");
    let _ = std::fs::remove_dir_all(&f.tmp);
}
