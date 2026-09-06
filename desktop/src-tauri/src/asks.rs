//! Live AskUserQuestion state exported by the Claude hook (docs/CONTRACT-ask.md).
use notify::Watcher;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Emitter;

static WATCHING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Deserialize)]
struct AskSidecar {
    session_id: String,
    #[allow(dead_code)]
    project: String,
    cwd: String,
    tool_use_id: Option<String>,
    questions: Vec<AskQuestion>,
    #[allow(dead_code)]
    ts: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskQuestion {
    question: String,
    #[serde(default)]
    header: String,
    #[serde(default)]
    multi_select: bool,
    options: Vec<AskOption>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct AskOption {
    label: String,
    #[serde(default)]
    description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OrchAsk {
    project: String,
    session_id: String,
    tool_use_id: Option<String>,
    open: bool,
    questions: Vec<AskQuestion>,
}

type AskMap = BTreeMap<PathBuf, OrchAsk>;

fn cwd_project(cwd: &str, bus_dir: &Path, dev_root: &str) -> Option<String> {
    let path = Path::new(cwd);
    if let Ok(relative) = path.strip_prefix(bus_dir.join("worktrees")) {
        let project = relative.components().next()?.as_os_str().to_str()?.trim();
        if !project.is_empty() && !project.starts_with('.') {
            return Some(project.to_string());
        }
    }
    crate::project_of_cwd(cwd, dev_root)
}

fn resolve_project_with(
    ask: &AskSidecar,
    session_rows: &str,
    bus_dir: &Path,
    dev_root: &str,
) -> Option<String> {
    session_rows
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let project = fields.next()?.trim();
            let session_id = fields.next()?.trim();
            (!project.is_empty() && session_id == ask.session_id).then(|| project.to_string())
        })
        .next_back()
        .or_else(|| cwd_project(&ask.cwd, bus_dir, dev_root))
}

fn read_sidecar(
    path: &Path,
    project_for: impl Fn(&AskSidecar) -> Option<String>,
) -> Result<OrchAsk, String> {
    let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let ask: AskSidecar = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if path.file_stem().and_then(|name| name.to_str()) != Some(ask.session_id.as_str()) {
        return Err("filename does not match session_id".into());
    }
    if ask.session_id.trim().is_empty() || ask.questions.is_empty() {
        return Err("session_id and questions are required".into());
    }
    let project =
        project_for(&ask).ok_or_else(|| "session and cwd resolve no project".to_string())?;
    Ok(OrchAsk {
        project,
        session_id: ask.session_id,
        tool_use_id: ask.tool_use_id,
        open: true,
        questions: ask.questions,
    })
}

fn scan_with(
    dir: &Path,
    project_for: impl Fn(&AskSidecar) -> Option<String> + Copy,
    log: impl Fn(String),
) -> Result<AskMap, String> {
    let mut found = AskMap::new();
    let entries = std::fs::read_dir(dir).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        match read_sidecar(&path, project_for) {
            Ok(ask) => {
                found.insert(path, ask);
            }
            Err(error) => log(format!("ask ignored path={} error={error}", path.display())),
        }
    }
    Ok(found)
}

fn scan(dir: &Path) -> Result<AskMap, String> {
    let bus_dir = crate::desktop_bus_dir();
    let session_rows =
        std::fs::read_to_string(bus_dir.join("orch-sessions.txt")).unwrap_or_default();
    let dev_root = std::env::var("TRANTOR_DEV_ROOT")
        .unwrap_or_else(|_| format!("{}/development", std::env::var("HOME").unwrap_or_default()));
    scan_with(
        dir,
        |ask| resolve_project_with(ask, &session_rows, &bus_dir, &dev_root),
        |line| crate::app_trace(&line),
    )
}

fn reconcile(previous: &AskMap, current: &AskMap) -> Vec<OrchAsk> {
    let mut events = Vec::new();
    for (path, old) in previous {
        if current.get(path) != Some(old) {
            let mut closed = old.clone();
            closed.open = false;
            events.push(closed);
        }
    }
    for (path, ask) in current {
        if previous.get(path) != Some(ask) {
            events.push(ask.clone());
        }
    }
    events
}

fn emit(window: &tauri::Window, ask: OrchAsk) -> bool {
    crate::app_trace(&format!(
        "ask received: project={} session={} tool={} open={}",
        ask.project,
        ask.session_id,
        ask.tool_use_id.as_deref().unwrap_or("null"),
        ask.open,
    ));
    window.emit("orch-ask", ask).is_ok()
}

#[tauri::command]
pub fn ask_watch(window: tauri::Window) -> Result<(), String> {
    let dir = crate::desktop_bus_dir().join("asks");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let replay = scan(&dir)?;
    for ask in replay.values().cloned() {
        if !emit(&window, ask) {
            return Err("failed to emit orch-ask replay".into());
        }
    }
    if WATCHING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok() {
            let _ = tx.send(());
        }
    })
    .map_err(|error| {
        WATCHING.store(false, Ordering::SeqCst);
        error.to_string()
    })?;
    watcher
        .watch(&dir, notify::RecursiveMode::NonRecursive)
        .map_err(|error| {
            WATCHING.store(false, Ordering::SeqCst);
            error.to_string()
        })?;

    std::thread::spawn(move || {
        let mut known = replay;
        while rx.recv().is_ok() {
            std::thread::sleep(Duration::from_millis(20));
            while rx.try_recv().is_ok() {}
            let Ok(current) = scan(&dir) else { continue };
            let changes = reconcile(&known, &current);
            known = current;
            if changes.into_iter().any(|ask| !emit(&window, ask)) {
                break;
            }
        }
        drop(watcher);
        WATCHING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

fn pane_for_session(raw: &str, session_id: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    value
        .get("result")?
        .get("agents")?
        .as_array()?
        .iter()
        .filter(|agent| {
            agent
                .get("agent_session")
                .and_then(|session| session.get("kind"))
                .and_then(|kind| kind.as_str())
                == Some("id")
                && agent
                    .get("agent_session")
                    .and_then(|session| session.get("value"))
                    .and_then(|value| value.as_str())
                    == Some(session_id)
        })
        .filter_map(|agent| agent.get("pane_id").and_then(|pane| pane.as_str()))
        .next_back()
        .map(str::to_string)
}

fn live_pane_for_session(session_id: &str) -> Option<String> {
    let output = crate::identity_env::command("herdr")
        .args(["agent", "list"])
        .env("PATH", crate::terminal_path())
        .output()
        .ok()?;
    pane_for_session(&String::from_utf8_lossy(&output.stdout), session_id)
}

#[tauri::command]
pub fn ask_target(session_id: String) -> Option<String> {
    live_pane_for_session(session_id.trim())
}

#[tauri::command]
pub fn ask_answer_session(session_id: String, data: String) -> Result<(), String> {
    let pane = live_pane_for_session(session_id.trim())
        .ok_or_else(|| "No pane hosts this session — answer it in its terminal.".to_string())?;
    crate::ask_answer(pane, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("trantor-asks-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_ask(dir: &Path, sid: &str, tool_id: Option<&str>, cwd: &str) -> PathBuf {
        let path = dir.join(format!("{sid}.json"));
        let value = serde_json::json!({
            "session_id": sid,
            "project": "diagnostic-only",
            "cwd": cwd,
            "tool_use_id": tool_id,
            "questions": [{
                "question": "Ship it?", "header": "Ship", "multiSelect": false,
                "options": [{ "label": "Yes", "description": "Proceed" }]
            }],
            "ts": 1,
        });
        fs::write(&path, value.to_string()).unwrap();
        path
    }

    #[test]
    fn temp_directory_reconciles_create_replace_and_delete() {
        let dir = temp_dir();
        let project_for = |_: &AskSidecar| Some("trantor".to_string());
        let empty = scan_with(&dir, project_for, |_| {}).unwrap();
        let path = write_ask(&dir, "sid-one", Some("tool-one"), "/tmp/trantor");
        let first = scan_with(&dir, project_for, |_| {}).unwrap();
        let opened = reconcile(&empty, &first);
        assert_eq!(opened.len(), 1);
        assert!(opened[0].open);

        write_ask(&dir, "sid-one", Some("tool-two"), "/tmp/trantor");
        let replaced = scan_with(&dir, project_for, |_| {}).unwrap();
        let replacement = reconcile(&first, &replaced);
        assert_eq!(replacement.len(), 2);
        assert!(!replacement[0].open);
        assert!(replacement[1].open);
        assert_eq!(replacement[1].tool_use_id.as_deref(), Some("tool-two"));

        fs::remove_file(path).unwrap();
        let gone = scan_with(&dir, project_for, |_| {}).unwrap();
        let closed = reconcile(&replaced, &gone);
        assert_eq!(closed.len(), 1);
        assert!(!closed[0].open);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_replacement_closes_cached_state_instead_of_sticking_open() {
        let dir = temp_dir();
        let project_for = |_: &AskSidecar| Some("trantor".to_string());
        let path = write_ask(&dir, "sid-one", None, "/tmp/trantor");
        let valid = scan_with(&dir, project_for, |_| {}).unwrap();
        fs::write(path, "not json").unwrap();
        let malformed = scan_with(&dir, project_for, |_| {}).unwrap();
        assert!(malformed.is_empty());
        assert_eq!(reconcile(&valid, &malformed).len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn session_map_wins_then_cwd_falls_back_for_checkout_and_worktree() {
        let ask = AskSidecar {
            session_id: "mapped-session".into(),
            project: "untrusted".into(),
            cwd: "/dev/other/deep/path".into(),
            tool_use_id: None,
            questions: Vec::new(),
            ts: 0,
        };
        assert_eq!(
            resolve_project_with(
                &ask,
                "other\tother-session\ntrantor\tmapped-session\n",
                Path::new("/bus"),
                "/dev",
            )
            .as_deref(),
            Some("trantor"),
        );

        let mut checkout = ask.clone();
        checkout.session_id = "unmapped".into();
        checkout.cwd = "/dev/trantor/apps/desktop".into();
        assert_eq!(
            resolve_project_with(&checkout, "", Path::new("/bus"), "/dev").as_deref(),
            Some("trantor"),
        );
        checkout.cwd = "/bus/worktrees/trantor/codex".into();
        assert_eq!(
            resolve_project_with(&checkout, "", Path::new("/bus"), "/dev").as_deref(),
            Some("trantor"),
        );
    }

    #[test]
    fn herdr_agent_list_routes_by_reported_session() {
        let raw = r#"{"result":{"agents":[
          {"pane_id":"w2:p8","agent_session":{"kind":"id","value":"orch"}},
          {"pane_id":"w2:p19","agent_session":{"kind":"id","value":"drill"}}
        ]}}"#;
        assert_eq!(pane_for_session(raw, "drill").as_deref(), Some("w2:p19"));
        assert_eq!(pane_for_session(raw, "missing"), None);
    }
}
