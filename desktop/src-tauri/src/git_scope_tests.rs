// #13988 drill: the project's main checkout gets the seat panel's reads, stage and commit, against
// a real temp repository built here. Nothing in these tests touches the trantor checkout.
use super::*;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git run");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// `<tmp>/dev/<project>` with two commits on main, one tracked edit and one untracked file.
fn fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let tmp = std::env::temp_dir().join(format!("trantor-gs-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let repo = tmp.join("dev").join("acme");
    let hooks = tmp.join("no-hooks");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&hooks).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [
        ("user.email", "t@t"),
        ("user.name", "Tess"),
        ("commit.gpgsign", "false"),
        ("core.hooksPath", hooks.to_str().unwrap()),
    ] {
        git(&repo, &["config", k, v]);
    }
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "#13988 first"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(repo.join("b.txt"), "bee\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "second: add b"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(repo.join("new.txt"), "fresh\n").unwrap();
    (tmp, repo)
}

#[test]
fn scope_parsing_keeps_the_seat_default_and_refuses_mixed_or_unknown_scopes() {
    assert_eq!(parse_scope(Some("glm"), None), Ok(GitScope::Seat("glm".into())));
    assert_eq!(parse_scope(Some("glm"), Some("seat")), Ok(GitScope::Seat("glm".into())));
    assert_eq!(parse_scope(None, Some("project")), Ok(GitScope::Project));
    assert_eq!(parse_scope(Some(""), Some("project")), Ok(GitScope::Project));
    assert!(parse_scope(Some("glm"), Some("project")).is_err());
    assert!(parse_scope(None, Some("everything")).is_err());
    // A seat call with no agent still fails exactly where it always did: the seat path guard.
    let bus = std::env::temp_dir().join("trantor-gs-no-bus");
    let err = scope_dir_in(&bus, &bus, "acme", &parse_scope(None, None).unwrap()).unwrap_err();
    assert_eq!(err, "project or agent is invalid");
}

#[test]
fn project_scope_resolves_the_checkout_and_rejects_traversal() {
    let (tmp, repo) = fixture("resolve");
    let dev = tmp.join("dev");
    assert_eq!(scope_dir_in(&dev, &tmp, "acme", &GitScope::Project).unwrap(), repo);
    assert!(project_checkout_in(&dev, "../acme").is_err());
    assert!(project_checkout_in(&dev, "a/b").is_err());
    assert!(project_checkout_in(&dev, " ").is_err());
    assert!(project_checkout_in(&dev, "missing").is_err());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn project_panel_reads_branch_status_counts_and_log() {
    let (tmp, repo) = fixture("panel");
    git(&repo, &["add", "a.txt"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    let panel = git_panel_at(&repo, log_limit(None)).await.unwrap();
    assert_eq!(panel.branch, "main");
    assert_eq!(panel.upstream, None);
    assert_eq!(panel.ahead, Some(0), "on main itself nothing is unlanded");
    let a = panel.status.iter().find(|e| e.path == "a.txt").unwrap();
    assert_eq!((a.x.as_str(), a.y.as_str()), ("M", "M"), "staged AND edited again");
    let n = panel.status.iter().find(|e| e.path == "new.txt").unwrap();
    assert_eq!(n.x, "?");
    assert_eq!(panel.counts.iter().find(|c| c.path == "a.txt").and_then(|c| c.plus), Some(2));
    assert_eq!(panel.log.len(), 2);
    assert_eq!(panel.log[0].subject, "second: add b");
    assert_eq!(panel.log[1].author, "Tess");
    assert_eq!(git_panel_at(&repo, log_limit(Some(1))).await.unwrap().log.len(), 1);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn log_limit_defaults_to_the_seat_count_and_is_clamped() {
    assert_eq!(log_limit(None), 15);
    assert_eq!(log_limit(Some(0)), 1);
    assert_eq!(log_limit(Some(40)), 40);
    assert_eq!(log_limit(Some(100_000)), 200);
}

#[tokio::test]
async fn project_show_lists_a_commits_files_and_patch() {
    let (tmp, repo) = fixture("show");
    let sha = git(&repo, &["rev-parse", "--short", "HEAD"]).trim().to_string();
    let show = git_show_at(&repo, &sha).await.unwrap();
    assert!(show.sha.starts_with(&sha) && show.sha.len() == 40);
    let paths: Vec<(&str, &str)> = show.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
    assert_eq!(paths, vec![("a.txt", "M"), ("b.txt", "A")]);
    assert_eq!(show.files[0].plus, Some(1));
    assert_eq!(show.files[0].minus, Some(0));
    assert!(show.patch.contains("+bee"));
    assert!(show.patch.contains("diff --git a/a.txt b/a.txt"));
    assert!(!show.truncated);
    let root = git(&repo, &["rev-list", "--max-parents=0", "HEAD"]).trim().to_string();
    let first = git_show_at(&repo, &root).await.unwrap();
    assert_eq!(first.files.len(), 1, "the root commit shows its one added file");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn show_refuses_anything_but_a_commit_id() {
    let (tmp, repo) = fixture("show-guard");
    for bad in ["--output=/tmp/x", "HEAD", "main..HEAD", "abc", "zzzz1234", ""] {
        assert!(git_show_at(&repo, bad).await.is_err(), "{bad} must be refused");
    }
    assert!(git_show_at(&repo, "deadbeefdeadbeef").await.is_err(), "unknown id is an error");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn project_stage_unstage_and_commit_only_what_is_staged() {
    let (tmp, repo) = fixture("commit");
    git_stage_at(&repo, &["new.txt".into()], false).await.unwrap();
    let staged = git(&repo, &["diff", "--cached", "--name-only"]);
    assert_eq!(staged.trim(), "new.txt");
    git_stage_at(&repo, &["new.txt".into()], true).await.unwrap();
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]).trim(), "");
    git_stage_at(&repo, &["new.txt".into()], false).await.unwrap();
    assert!(git_commit_at(&repo, "   ").await.is_err(), "an empty message is refused");
    let short = git_commit_at(&repo, "#13988 add new").await.unwrap();
    assert_eq!(short, git(&repo, &["rev-parse", "--short", "HEAD"]).trim());
    assert_eq!(git(&repo, &["show", "--format=", "--name-only", "HEAD"]).trim(), "new.txt");
    // a.txt was edited but never staged: the commit left it alone.
    assert!(git(&repo, &["status", "--porcelain"]).contains(" M a.txt"));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn project_stage_refuses_paths_outside_the_checkout() {
    let (tmp, repo) = fixture("paths");
    for bad in ["../outside.txt", "/etc/passwd", "a/../../x", ""] {
        assert!(git_stage_at(&repo, &[bad.into()], false).await.is_err(), "{bad} must be refused");
    }
    assert!(git_stage_at(&repo, &[], false).await.is_err());
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]).trim(), "");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn show_files_join_name_status_with_counts_and_keep_binary_null() {
    let files = join_show_files("M\tsrc/a.rs\nA\timg.png\n\n", "3\t1\tsrc/a.rs\n-\t-\timg.png\n");
    assert_eq!(files.len(), 2);
    assert_eq!((files[0].plus, files[0].minus), (Some(3), Some(1)));
    assert_eq!((files[1].status.as_str(), files[1].plus), ("A", None));
}
