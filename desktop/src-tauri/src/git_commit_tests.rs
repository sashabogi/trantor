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

fn commit_file(repo: &Path, path: &str, body: &str, message: &str) {
    std::fs::write(repo.join(path), body).unwrap();
    git(repo, &["add", "--", path]);
    git(repo, &["commit", "-qm", message]);
}

fn fixture(tag: &str) -> Fixture {
    let tmp = std::env::temp_dir().join(format!("trantor-g3-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let repo = tmp.join("repo");
    let remote = tmp.join("remote.git");
    let trash = tmp.join("trash");
    std::fs::create_dir_all(&repo).unwrap();
    git(&tmp, &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&repo, &["init", "-q", "-b", "main"]);
    let hooks = tmp.join("no-hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for (key, value) in [
        ("user.email", "t@t".to_string()),
        ("user.name", "Tess".to_string()),
        ("commit.gpgsign", "false".to_string()),
        ("core.hooksPath", hooks.to_string_lossy().to_string()),
    ] {
        git(&repo, &["config", key, &value]);
    }
    let body = (1..=20).map(|n| format!("{n}\n")).collect::<String>();
    commit_file(&repo, "a.txt", &body, "first");
    git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&repo, &["push", "-qu", "origin", "main"]);
    Fixture { tmp, repo, remote, trash }
}

fn edit_two_hunks(repo: &Path) {
    let body = std::fs::read_to_string(repo.join("a.txt")).unwrap().replace("\n2\n", "\nTWO\n").replace("\n20\n", "\nTWENTY\n");
    std::fs::write(repo.join("a.txt"), body).unwrap();
}

const FIRST_HUNK: &str = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,4 +1,4 @@\n 1\n-2\n+TWO\n 3\n 4\n";
const SECOND_HUNK: &str = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -17,4 +17,4 @@\n 17\n 18\n 19\n-20\n+TWENTY\n";

#[tokio::test]
async fn amend_and_undo_restore_the_message_and_staged_changes_only_before_push() {
    let f = fixture("history");
    let first = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    assert!(git_amend_at(&f.repo, "rewrite pushed").await.unwrap_err().contains("already pushed"));
    assert!(git_undo_at(&f.repo).await.unwrap_err().contains("already pushed"));
    commit_file(&f.repo, "a.txt", "local\n", "local subject");
    std::fs::write(f.repo.join("a.txt"), "amended\n").unwrap();
    git(&f.repo, &["add", "a.txt"]);
    assert_eq!(git_amend_at(&f.repo, "amended subject").await.unwrap().len(), 7);
    assert_eq!(git(&f.repo, &["log", "-1", "--format=%s"]).trim(), "amended subject");
    let message = git_undo_at(&f.repo).await.unwrap();
    assert_eq!(message, "amended subject");
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]).trim(), first);
    assert_eq!(git(&f.repo, &["status", "--porcelain"]).trim(), "M  a.txt");
    assert_eq!(std::fs::read_to_string(f.repo.join("a.txt")).unwrap(), "amended\n");
    assert!(f.remote.exists());
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn one_of_two_hunks_stages_and_unstages_without_touching_the_other() {
    let f = fixture("stage");
    edit_two_hunks(&f.repo);
    git_apply_patch_in(&f.repo, "a.txt", FIRST_HUNK, "stage", &f.trash).await.unwrap();
    let cached = git(&f.repo, &["diff", "--cached"]);
    assert!(cached.contains("+TWO") && !cached.contains("TWENTY"), "{cached}");
    let unstaged = git(&f.repo, &["diff"]);
    assert!(unstaged.contains("+TWENTY") && !unstaged.contains("+TWO"), "{unstaged}");
    git_apply_patch_in(&f.repo, "a.txt", FIRST_HUNK, "unstage", &f.trash).await.unwrap();
    assert!(git(&f.repo, &["diff", "--cached"]).is_empty());
    let stale = git_apply_patch_in(&f.repo, "a.txt", FIRST_HUNK, "stage", &f.trash).await.unwrap();
    assert!(stale.is_empty());
    let err = git_apply_patch_in(&f.repo, "a.txt", FIRST_HUNK, "stage", &f.trash).await.unwrap_err();
    assert!(err.contains("no longer applies"), "{err}");
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn discard_copies_the_whole_file_then_reverses_only_the_selected_hunk() {
    let f = fixture("discard");
    edit_two_hunks(&f.repo);
    git_apply_patch_in(&f.repo, "a.txt", FIRST_HUNK, "stage", &f.trash).await.unwrap();
    let backup = std::path::PathBuf::from(git_apply_patch_in(&f.repo, "a.txt", SECOND_HUNK, "discard", &f.trash).await.unwrap());
    assert!(std::fs::read_to_string(backup.join("a.txt")).unwrap().contains("TWENTY"));
    let disk = std::fs::read_to_string(f.repo.join("a.txt")).unwrap();
    assert!(disk.contains("TWO") && !disk.contains("TWENTY") && disk.contains("20\n"));
    let cached = git(&f.repo, &["diff", "--cached"]);
    assert!(cached.contains("+TWO") && !cached.contains("TWENTY"));
    let remaining = git(&f.repo, &["diff"]);
    assert!(remaining.is_empty(), "{remaining}");
    let _ = std::fs::remove_dir_all(&f.tmp);
}
