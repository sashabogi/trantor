// The app starts the machine-local hub itself (#14322). A stranger who installs the DMG and the
// trantor CLI has no launchd service; without this nothing answers on 127.0.0.1:4477.
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

pub(crate) const LOCAL_HUB_URL: &str = "http://127.0.0.1:4477";
const WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum StartDecision {
    /// A project or the global default points at a non-loopback hub: this machine hosts nothing.
    Remote,
    /// Something already answers on the local port. Never start a second hub.
    AlreadyRunning,
    Start,
}

pub(crate) fn is_loopback_url(url: &str) -> bool {
    let rest = url.trim().split("://").last().unwrap_or("");
    let host = rest.split('/').next().unwrap_or("");
    let host = host.rsplit_once(':').map_or(host, |(h, _)| h);
    matches!(host.trim_matches(['[', ']']), "127.0.0.1" | "localhost" | "::1")
}

/// Pure: the pinned hub urls (per project and the global default) plus whether the local port
/// answers decide whether the app starts a hub.
pub(crate) fn decide(pinned_urls: &[String], local_answers: bool) -> StartDecision {
    if pinned_urls.iter().any(|u| !u.trim().is_empty() && !is_loopback_url(u)) {
        return StartDecision::Remote;
    }
    if local_answers {
        StartDecision::AlreadyRunning
    } else {
        StartDecision::Start
    }
}

pub(crate) fn pinned_urls(config: &Value) -> Vec<String> {
    let mut urls: Vec<String> = config
        .get("hubs")
        .and_then(Value::as_object)
        .map(|h| h.values().filter_map(|u| u.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if let Some(u) = config.get("url").and_then(Value::as_str) {
        urls.push(u.to_string());
    }
    urls
}

fn read_pinned() -> Vec<String> {
    std::fs::read_to_string(crate::desktop_bus_dir().join("config.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|v| pinned_urls(&v))
        .unwrap_or_default()
}

pub(crate) fn log_path() -> PathBuf {
    crate::desktop_bus_dir().join("hub.log")
}

#[derive(Serialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalHubState {
    /// running | started | remote | no_cli | failed
    pub state: &'static str,
    pub detail: Option<String>,
    pub log_path: String,
}

fn report(state: &'static str, detail: Option<String>) -> LocalHubState {
    LocalHubState { state, detail, log_path: log_path().to_string_lossy().into_owned() }
}

async fn answers() -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_millis(1200)).build() else {
        return false;
    };
    client
        .get(format!("{LOCAL_HUB_URL}/health"))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

fn spawn_hub() -> Result<tokio::process::Child, String> {
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let open = || std::fs::OpenOptions::new().create(true).append(true).open(&path);
    let out = open().map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let err = open().map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut command = crate::trantor_cli::async_command();
    command
        .arg("hub")
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(err)
        .kill_on_drop(false)
        .process_group(0);
    command.spawn().map_err(|e| format!("could not start trantor hub: {e}"))
}

static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Start the local hub when nothing serves it. Idempotent and serialized: concurrent callers
/// (app start plus a Retry) never race into two hubs, and a hub this call did not start is never
/// touched.
#[tauri::command]
pub(crate) async fn local_hub_ensure() -> LocalHubState {
    let _guard = START_LOCK.lock().await;
    let answering = answers().await;
    match decide(&read_pinned(), answering) {
        StartDecision::Remote => return report("remote", None),
        StartDecision::AlreadyRunning => return report("running", None),
        StartDecision::Start => {}
    }
    if crate::trantor_cli::version().await.is_none() {
        return report("no_cli", Some("The trantor CLI is not installed.".into()));
    }
    let mut child = match spawn_hub() {
        Ok(child) => child,
        Err(e) => return report("failed", Some(e)),
    };
    let deadline = tokio::time::Instant::now() + WAIT;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(POLL).await;
        if answers().await {
            return report("started", None);
        }
        if let Ok(Some(status)) = child.try_wait() {
            return report("failed", Some(format!("trantor hub exited early ({status})")));
        }
    }
    report("failed", Some("The hub did not answer within 10 seconds.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn urls(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_pins_and_a_silent_port_starts_a_hub() {
        assert_eq!(decide(&[], false), StartDecision::Start);
        assert_eq!(decide(&urls(&["http://127.0.0.1:4477"]), false), StartDecision::Start);
        assert_eq!(decide(&urls(&["http://localhost:4477/"]), false), StartDecision::Start);
    }

    #[test]
    fn an_answering_port_never_gets_a_second_hub() {
        assert_eq!(decide(&[], true), StartDecision::AlreadyRunning);
    }

    #[test]
    fn any_non_loopback_pin_means_no_local_hub() {
        assert_eq!(decide(&urls(&["https://hub.example.com"]), false), StartDecision::Remote);
        assert_eq!(
            decide(&urls(&["http://127.0.0.1:4477", "http://100.64.0.1:4477"]), true),
            StartDecision::Remote
        );
    }

    #[test]
    fn pins_come_from_hubs_and_the_global_url() {
        let cfg = json!({ "hubs": { "a": "http://x:1" }, "url": "http://y:2" });
        let mut got = pinned_urls(&cfg);
        got.sort();
        assert_eq!(got, urls(&["http://x:1", "http://y:2"]));
        assert!(pinned_urls(&json!({})).is_empty());
    }

    #[test]
    fn loopback_detection_handles_ports_paths_and_ipv6() {
        assert!(is_loopback_url("http://[::1]:4477"));
        assert!(is_loopback_url("127.0.0.1:4477"));
        assert!(!is_loopback_url("http://127.0.0.1.evil.com:4477"));
    }
}
