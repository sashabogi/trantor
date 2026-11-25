use super::*;
use std::process::Command;

struct Repo(std::path::PathBuf);

impl Repo {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("trantor-file-diff-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        let repo = Self(path);
        repo.git(&["init", "-q"]);
        repo.git(&["config", "user.name", "Diff test"]);
        repo.git(&["config", "user.email", "diff@example.test"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.git(&["config", "core.hooksPath", "/dev/null"]);
        repo
    }

    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(&self.0).output().unwrap();
        assert!(out.status.success(), "git {args:?} failed");
        String::from_utf8(out.stdout).unwrap()
    }

    fn diff(&self, side: Option<FileDiffSide>) -> String {
        file_diff_at(&self.0, "a.txt", side).unwrap()
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// #14268: a mixed file must yield independently applicable index and working tree patches.
#[test]
fn file_diff_separates_staged_and_unstaged_hunks() {
    let repo = Repo::new("mixed");
    let original = (1..=30).map(|n| format!("line {n}\n")).collect::<String>();
    std::fs::write(repo.0.join("a.txt"), &original).unwrap();
    repo.git(&["add", "a.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    let staged = original.replace("line 2\n", "staged edit\n");
    std::fs::write(repo.0.join("a.txt"), &staged).unwrap();
    repo.git(&["add", "a.txt"]);
    std::fs::write(repo.0.join("a.txt"), staged.replace("line 29\n", "unstaged edit\n")).unwrap();
    assert!(repo.git(&["status", "--porcelain"]).starts_with("MM "));
    let index = repo.diff(Some(FileDiffSide::Staged));
    let working = repo.diff(Some(FileDiffSide::Unstaged));
    assert!(index.contains("+staged edit"));
    assert!(!index.contains("unstaged edit"));
    assert!(working.contains("+unstaged edit"));
    assert!(!working.contains("+staged edit\n"));
    assert_eq!(index.matches("@@ -").count(), 1);
    assert_eq!(working.matches("@@ -").count(), 1);
    assert!(repo.diff(None).contains("+staged edit"));
    assert!(repo.diff(None).contains("+unstaged edit"));
    std::fs::write(repo.0.join("staged.patch"), index).unwrap();
    std::fs::write(repo.0.join("unstaged.patch"), working).unwrap();
    repo.git(&["apply", "--cached", "--check", "--reverse", "staged.patch"]);
    repo.git(&["apply", "--cached", "--check", "unstaged.patch"]);
}

// #14268: new files are unstaged until added, including before the first commit.
#[test]
fn file_diff_untracked_and_unborn_index_have_only_their_own_side() {
    let repo = Repo::new("untracked");
    std::fs::write(repo.0.join("a.txt"), "first\nsecond\n").unwrap();
    assert!(repo.diff(Some(FileDiffSide::Staged)).is_empty());
    let working = repo.diff(Some(FileDiffSide::Unstaged));
    assert!(working.contains("--- /dev/null"));
    assert!(working.contains("+first\n+second"));
    repo.git(&["add", "a.txt"]);
    assert!(repo.diff(Some(FileDiffSide::Unstaged)).is_empty());
    assert!(repo.diff(Some(FileDiffSide::Staged)).contains("+first\n+second"));
}

// #14268: adjacent changes still use the index as the working tree diff's base.
#[test]
fn file_diff_same_line_changes_compare_against_the_index() {
    let repo = Repo::new("same-line");
    std::fs::write(repo.0.join("a.txt"), "base\n").unwrap();
    repo.git(&["add", "a.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    std::fs::write(repo.0.join("a.txt"), "index\n").unwrap();
    repo.git(&["add", "a.txt"]);
    std::fs::write(repo.0.join("a.txt"), "working\n").unwrap();
    assert!(repo.diff(Some(FileDiffSide::Staged)).contains("-base\n+index"));
    assert!(repo.diff(Some(FileDiffSide::Unstaged)).contains("-index\n+working"));
}
