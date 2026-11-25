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

fn snapshot(sha: Option<String>, tag: Option<String>, ci: Option<Value>) -> String {
    json!({ "sha": sha, "tag": tag, "ci": ci }).to_string()
}

async fn run_text(program: &Path, dir: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(Duration::from_secs(15), tokio::process::Command::new(program)
        .current_dir(dir).args(args).env("GH_PROMPT_DISABLED", "1").kill_on_drop(true).output()).await.ok()?.ok()?;
    if !output.status.success() { return None; }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

#[tauri::command]
pub(crate) async fn ci_status(project: String) -> Result<String, String> {
    let Some(dir) = crate::hub::project_dir(&project) else { return Ok(snapshot(None, None, None)); };
    let (sha, tag) = tokio::join!(
        run_text(Path::new("git"), &dir, &["rev-parse", "HEAD"]),
        run_text(Path::new("git"), &dir, &["describe", "--tags", "--abbrev=0"])
    );
    let path = std::env::var_os("PATH").unwrap_or_default();
    let gh = find_gh(&path, executable);
    let ci = match (gh, sha.as_deref()) {
        (Some(gh), Some(commit)) => run_text(&gh, &dir, &["run", "list", "--commit", commit, "--limit", "5",
            "--json", "status,conclusion,url,name,databaseId"]).await.and_then(|raw| shape_ci(&raw)),
        _ => None,
    };
    Ok(snapshot(sha, tag, ci))
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
    fn unavailable_ci_preserves_git_facts() {
        let value: Value = serde_json::from_str(&snapshot(Some("abc".into()), Some("v2".into()), None)).unwrap();
        assert_eq!(value, json!({ "sha": "abc", "tag": "v2", "ci": null }));
        assert_eq!(serde_json::from_str::<Value>(&snapshot(None, None, None)).unwrap(), json!({ "sha": null, "tag": null, "ci": null }));
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
