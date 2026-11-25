use super::*;
use std::process::Command;

struct Fixture {
    tmp: PathBuf,
    repo: PathBuf,
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git run");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
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
    let tmp = std::env::temp_dir().join(format!("trantor-g4-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let repo = tmp.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
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
    commit_file(&repo, "a.txt", "one\ntwo\n", "first");
    Fixture { tmp, repo }
}

fn conflicting_merge(repo: &Path) {
    git(repo, &["switch", "-qc", "topic"]);
    commit_file(repo, "a.txt", "topic\n", "topic");
    git(repo, &["switch", "-q", "main"]);
    commit_file(repo, "a.txt", "main\n", "main");
    let out = Command::new("git").arg("-C").arg(repo).args(["merge", "--no-edit", "topic"]).output().unwrap();
    assert!(!out.status.success(), "the fixture must stop on a conflict");
}

#[tokio::test]
async fn all_branch_history_includes_branch_and_tag_refs() {
    let f = fixture("all");
    git(&f.repo, &["switch", "-qc", "seat/kimi-9"]);
    commit_file(&f.repo, "seat.txt", "seat\n", "seat branch work");
    git(&f.repo, &["tag", "v-seat"]);
    git(&f.repo, &["switch", "-q", "main"]);
    commit_file(&f.repo, "main.txt", "main\n", "main work");

    let current = git_history_at(&f.repo, false, None, None, None).await.unwrap();
    assert!(!current.iter().any(|row| row.subject == "seat branch work"));
    let all = git_history_at(&f.repo, true, None, None, None).await.unwrap();
    let seat = all.iter().find(|row| row.subject == "seat branch work").unwrap();
    assert!(seat.refs.contains(&"seat/kimi-9".to_string()));
    assert!(seat.refs.contains(&"tag: v-seat".to_string()));
    assert!(all.iter().any(|row| row.subject == "main work"));
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn history_filters_by_path_and_the_whole_commit_message() {
    let f = fixture("search");
    commit_file(&f.repo, "src/a.ts", "a\n", "visible subject");
    commit_file(&f.repo, "src/b.ts", "b\n", "other subject\n\nA needle in the body");

    let file = git_history_at(&f.repo, true, Some("src/a.ts"), None, None).await.unwrap();
    assert_eq!(file.iter().map(|row| row.subject.as_str()).collect::<Vec<_>>(), vec!["visible subject"]);
    let bare = git_history_at(&f.repo, true, Some("a.ts"), None, None).await.unwrap();
    assert_eq!(bare.iter().map(|row| row.subject.as_str()).collect::<Vec<_>>(), vec!["visible subject"]);
    let message = git_history_at(&f.repo, true, None, Some("needle in the body"), None).await.unwrap();
    assert_eq!(message.len(), 1);
    assert_eq!(message[0].subject, "other subject");
    let literal = git_history_at(&f.repo, true, None, Some("needle.*body"), None).await.unwrap();
    assert!(literal.is_empty(), "message search is literal, not a regular expression");
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn blame_returns_the_author_age_and_commit_for_each_line() {
    let f = fixture("blame");
    let first = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    commit_file(&f.repo, "a.txt", "one\nchanged\n", "second line");

    let lines = git_blame_at(&f.repo, "a.txt").await.unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].line, 1);
    assert_eq!(lines[0].sha, first);
    assert_eq!(lines[0].author, "Tess");
    assert!(!lines[0].when.is_empty());
    assert_eq!(lines[1].subject, "second line");
    assert_ne!(lines[0].sha, lines[1].sha);
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn commit_metadata_keeps_the_full_message_parent_and_github_url() {
    let f = fixture("meta");
    let parent = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    commit_file(&f.repo, "a.txt", "next\n", "subject\n\nfull body\non two lines");
    let head = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    git(&f.repo, &["remote", "add", "origin", "git@github.com:owner/repo.git"]);

    let meta = git_commit_meta_at(&f.repo, &head).await.unwrap();
    assert_eq!(meta.message, "subject\n\nfull body\non two lines");
    assert_eq!(meta.parents, vec![parent]);
    assert_eq!(meta.github_url, Some(format!("https://github.com/owner/repo/commit/{head}")));
    assert_eq!(github_commit_url("https://example.com/owner/repo.git", &head), None);
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn a_paused_merge_continues_after_the_last_conflict_is_resolved() {
    let f = fixture("continue");
    conflicting_merge(&f.repo);
    let paused = git_operation_at(&f.repo).await.unwrap();
    assert_eq!(paused, GitOperation { operation: Some("merge".to_string()), conflicts: 1 });
    assert!(git_operation_continue_at(&f.repo).await.is_err());

    std::fs::write(f.repo.join("a.txt"), "resolved\n").unwrap();
    git(&f.repo, &["add", "--", "a.txt"]);
    git_operation_continue_at(&f.repo).await.unwrap();
    assert_eq!(git_operation_at(&f.repo).await.unwrap().operation, None);
    assert_eq!(git(&f.repo, &["show", "-s", "--format=%s", "HEAD"]).trim(), "Merge branch 'topic'");
    let _ = std::fs::remove_dir_all(&f.tmp);
}

#[tokio::test]
async fn a_paused_merge_aborts_back_to_the_pre_merge_file() {
    let f = fixture("abort");
    conflicting_merge(&f.repo);
    assert_eq!(git_operation_at(&f.repo).await.unwrap().conflicts, 1);

    git_operation_abort_at(&f.repo).await.unwrap();
    assert_eq!(git_operation_at(&f.repo).await.unwrap(), GitOperation { operation: None, conflicts: 0 });
    assert_eq!(std::fs::read_to_string(f.repo.join("a.txt")).unwrap(), "main\n");
    let _ = std::fs::remove_dir_all(&f.tmp);
}
