// #14256: optional GitHub tooling must never hide the local checkout's health.
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn gh_candidates(path: &std::ffi::OsStr) -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("/opt/homebrew/bin/gh"), PathBuf::from("/usr/local/bin/gh")];
    paths.extend(std::env::split_paths(path).filter(|p| !p.as_os_str().is_empty()).map(|p| p.join("gh")));
    paths
}

fn find_gh(path: &std::ffi::OsStr, executable: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    gh_candidates(path).into_iter().find(|p| executable(p))
}

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[derive(Deserialize)]
struct Run {
    status: String,
    conclusion: Option<String>,
    url: String,
    name: String,
}

fn shape_ci(raw: &str) -> Option<Value> {
    let runs: Vec<Run> = serde_json::from_str(raw).ok()?;
    let first = runs.first()?;
    if let Some(run) = runs.iter().find(|r| r.status != "completed") {
        return Some(json!({ "state": "running", "url": run.url }));
    }
    if let Some(run) = runs.iter().find(|r| matches!(r.conclusion.as_deref(),
        Some("failure" | "timed_out" | "cancelled" | "action_required" | "startup_failure" | "stale"))) {
        return Some(json!({ "state": "red", "failing": run.name, "url": run.url }));
    }
    let green = runs.iter().all(|r| matches!(r.conclusion.as_deref(), Some("success" | "neutral" | "skipped")))
        && runs.iter().any(|r| r.conclusion.as_deref() == Some("success"));
    Some(json!({ "state": if green { Some("green") } else { None }, "url": first.url }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Release {
    tag_name: String,
    published_at: Option<String>,
    #[serde(default)]
    is_draft: bool,
}

fn latest_release(raw: &str) -> Option<Release> {
    // #14268: `gh release list` puts the Latest-flagged release first, so pick the newest published one ourselves.
    serde_json::from_str::<Vec<Release>>(raw).ok()?.into_iter()
        .filter(|r| !r.tag_name.is_empty() && !r.is_draft)
        .max_by(|a, b| a.published_at.cmp(&b.published_at))
}

fn github_repo(remotes: &str) -> Option<String> {
    remotes.lines().find_map(|line| {
        let url = line.split_whitespace().nth(1)?;
        let repo = url.strip_prefix("git@github.com:")
            .or_else(|| url.strip_prefix("https://github.com/"))
            .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
        let repo = repo.trim_end_matches('/').trim_end_matches(".git");
        let parts: Vec<_> = repo.split('/').collect();
        (parts.len() == 2 && parts.iter().all(|p| !p.is_empty())).then(|| repo.to_string())
    })
}

fn snapshot(sha: Option<String>, release: Option<Release>, ci: Option<Value>, has_remote: bool, local_checkout: bool) -> String {
    let release = release.filter(|_| has_remote);
    json!({ "sha": sha, "tag": release.as_ref().map(|r| &r.tag_name),
        "tagPublishedAt": release.as_ref().and_then(|r| r.published_at.as_ref()),
        "ci": ci.filter(|_| has_remote), "hasRemote": has_remote, "localCheckout": local_checkout }).to_string()
}

async fn run_text(program: &Path, dir: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(Duration::from_secs(15), tokio::process::Command::new(program)
        .current_dir(dir).args(args).env("GH_PROMPT_DISABLED", "1").kill_on_drop(true).output()).await.ok()?.ok()?;
    if !output.status.success() { return None; }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

// #14268: query releases on the GitHub remote because local tags may never have been fetched.
async fn read_status(dir: &Path, git: &Path, gh: Option<&Path>) -> String {
    let (sha, tag, remotes, checkout) = tokio::join!(
        run_text(git, dir, &["rev-parse", "HEAD"]),
        run_text(git, dir, &["describe", "--tags", "--abbrev=0"]),
        run_text(git, dir, &["remote", "-v"]),
        run_text(git, dir, &["rev-parse", "--is-inside-work-tree"])
    );
    let local_checkout = checkout.as_deref() == Some("true");
    let has_remote = remotes.is_some();
    let repo = remotes.as_deref().and_then(github_repo);
    let (release, ci) = match (gh, repo.as_deref()) {
        (Some(gh), Some(repo)) => {
            tokio::join!(
                async { run_text(gh, dir, &["release", "list", "--limit", "10", "--json", "tagName,publishedAt,isDraft,isPrerelease", "--repo", repo])
                    .await.and_then(|raw| latest_release(&raw)) },
                async { match sha.as_deref() {
                    Some(commit) => run_text(gh, dir, &["run", "list", "--commit", commit, "--limit", "5",
                        "--json", "status,conclusion,url,name,databaseId", "--repo", repo]).await.and_then(|raw| shape_ci(&raw)),
                    None => None,
                } }
            )
        }
        _ => (None, None),
    };
    let release = match (release, tag.filter(|_| has_remote)) {
        (Some(release), _) => Some(release),
        (None, Some(tag_name)) => {
            let reference = format!("refs/tags/{tag_name}");
            let published_at = run_text(git, dir, &["for-each-ref", "--format=%(creatordate:iso-strict)", &reference]).await;
            Some(Release { tag_name, published_at, is_draft: false })
        }
        _ => None,
    };
    snapshot(sha, release, ci, has_remote, local_checkout)
}

#[tauri::command]
pub(crate) async fn ci_status(project: String) -> Result<String, String> {
    let Some(dir) = crate::hub::project_dir(&project) else { return Ok(snapshot(None, None, None, false, false)); };
    let path = std::env::var_os("PATH").unwrap_or_default();
    let gh = find_gh(&path, executable);
    Ok(read_status(&dir, Path::new("git"), gh.as_deref()).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn run(status: &str, conclusion: &str, name: &str) -> Value {
        json!({ "status": status, "conclusion": conclusion, "name": name, "url": "https://github.com/run/1", "databaseId": 1 })
    }

    #[test]
    fn ci_shapes_running_green_red_and_unknown() {
        let shape = |rows: Value| shape_ci(&rows.to_string()).unwrap();
        assert_eq!(shape(json!([run("in_progress", "", "Build")]))["state"], "running");
        assert_eq!(shape(json!([run("queued", "", "Build")]))["state"], "running");
        assert_eq!(shape(json!([run("completed", "success", "Build"), run("completed", "skipped", "Docs")]))["state"], "green");
        for failure in ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"] {
            let ci = shape(json!([run("completed", "success", "Build"), run("completed", failure, "Lint")]));
            assert_eq!(ci["state"], "red");
            assert_eq!(ci["failing"], "Lint");
            assert_eq!(ci["url"], "https://github.com/run/1");
        }
        assert!(shape(json!([run("completed", "", "Build")]))["state"].is_null());
        assert_eq!(shape_ci("[]"), None);
        assert_eq!(shape_ci("invalid"), None);
    }

    #[test]
    fn unavailable_ci_preserves_git_facts_only_with_a_remote() {
        let release = || Some(Release { tag_name: "v2".into(), published_at: None, is_draft: false });
        let value: Value = serde_json::from_str(&snapshot(Some("abc".into()), release(), None, true, true)).unwrap();
        assert_eq!(value["tag"], "v2");
        assert_eq!(value["sha"], "abc");
        assert!(value["ci"].is_null());
        let local: Value = serde_json::from_str(&snapshot(Some("abc".into()), release(), Some(json!({"state":"green"})), false, true)).unwrap();
        assert!(local["tag"].is_null());
        assert!(local["ci"].is_null());
        assert_eq!(local["hasRemote"], false);
        let missing: Value = serde_json::from_str(&snapshot(None, None, None, false, false)).unwrap();
        assert_eq!(missing["localCheckout"], false);
    }

    #[test]
    fn recognizes_github_remotes_without_matching_other_hosts() {
        for url in ["git@github.com:owner/app.git", "https://github.com/owner/app.git", "ssh://git@github.com/owner/app.git"] {
            assert_eq!(github_repo(&format!("origin {url} (fetch)")), Some("owner/app".into()));
        }
        assert_eq!(github_repo("origin https://github.com.evil/owner/app (fetch)"), None);
        assert_eq!(github_repo("origin https://gitlab.com/owner/app (fetch)"), None);
        assert_eq!(github_repo(""), None);
        assert!(latest_release("[]").is_none());
        assert!(latest_release("invalid").is_none());
    }

    // #14268: executable fixtures verify release commands and fallbacks without network access.
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("trantor-ci-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn script(&self, name: &str, body: &str) -> PathBuf {
            use std::os::unix::fs::PermissionsExt;
            let path = self.0.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[tokio::test]
    async fn prefers_remote_release_and_falls_back_to_local_tag() {
        let f = Fixture::new();
        let git = f.script("git", r#"
case "$*" in
  "rev-parse HEAD") echo abc ;;
  "rev-parse --is-inside-work-tree") echo true ;;
  "describe --tags --abbrev=0") echo cli-old ;;
  "remote -v") echo 'origin git@github.com:owner/app.git (fetch)' ;;
  "for-each-ref --format=%(creatordate:iso-strict) refs/tags/cli-old") echo '2025-01-01T00:00:00Z' ;;
  *) exit 1 ;;
esac"#);
        let gh = f.script("gh", r#"
case "$*" in
  "release list --limit 10 --json tagName,publishedAt,isDraft,isPrerelease --repo owner/app") echo '[{"tagName":"old-latest","publishedAt":"2026-10-01T00:00:00Z","isDraft":false},{"tagName":"draft","publishedAt":"2026-12-01T00:00:00Z","isDraft":true},{"tagName":"app-v2","publishedAt":"2026-11-01T00:00:00Z","isDraft":false}]' ;;
  "run list --commit abc --limit 5 --json status,conclusion,url,name,databaseId --repo owner/app") echo '[{"status":"completed","conclusion":"success","url":"https://github.com/run/1","name":"Build"}]' ;;
  *) exit 1 ;;
esac"#);
        let value: Value = serde_json::from_str(&read_status(&f.0, &git, Some(&gh)).await).unwrap();
        assert_eq!(value["tag"], "app-v2");
        assert_eq!(value["tagPublishedAt"], "2026-11-01T00:00:00Z");
        assert_eq!(value["ci"]["state"], "green");
        assert_eq!(value["localCheckout"], true);
        for response in ["exit 1", "echo '[]'", "echo invalid"] {
            f.script("gh", response);
            let value: Value = serde_json::from_str(&read_status(&f.0, &git, Some(&gh)).await).unwrap();
            assert_eq!(value["tag"], "cli-old");
            assert_eq!(value["tagPublishedAt"], "2025-01-01T00:00:00Z");
        }
        let value: Value = serde_json::from_str(&read_status(&f.0, &git, None).await).unwrap();
        assert_eq!(value["tag"], "cli-old");
    }

    #[tokio::test]
    async fn no_github_remote_skips_gh_and_missing_checkout_is_explicit() {
        let f = Fixture::new();
        let gh = f.script("gh", "touch called; exit 1");
        for remote in ["", "origin https://gitlab.com/owner/app.git"] {
            let git = f.script("git", &format!(r#"
case "$*" in
  "remote -v") echo '{remote}' ;;
  "rev-parse --is-inside-work-tree") echo true ;;
  "describe --tags --abbrev=0") echo cli-old ;;
  *) exit 1 ;;
esac"#));
            let value: Value = serde_json::from_str(&read_status(&f.0, &git, Some(&gh)).await).unwrap();
            assert_eq!(value["hasRemote"], !remote.is_empty());
            assert_eq!(value["tag"].is_null(), remote.is_empty());
            assert!(!f.0.join("called").exists());
        }
        let git = f.script("git", "exit 1");
        let value: Value = serde_json::from_str(&read_status(&f.0, &git, Some(&gh)).await).unwrap();
        assert_eq!(value["localCheckout"], false);
        assert_eq!(value["hasRemote"], false);
    }

    #[test]
    fn gh_search_prefers_known_locations_then_path() {
        let path = OsStr::new("/bin:/custom/bin");
        assert_eq!(find_gh(path, |_| true), Some(PathBuf::from("/opt/homebrew/bin/gh")));
        assert_eq!(find_gh(path, |p| p != Path::new("/opt/homebrew/bin/gh")), Some(PathBuf::from("/usr/local/bin/gh")));
        assert_eq!(find_gh(path, |p| p == Path::new("/custom/bin/gh")), Some(PathBuf::from("/custom/bin/gh")));
        assert_eq!(find_gh(OsStr::new(""), |_| false), None);
    }
}
