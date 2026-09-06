//! Live AskUserQuestion state exported by the Claude hook (docs/CONTRACT-ask.md).
use notify::Watcher;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

static WATCHING: AtomicBool = AtomicBool::new(false);
static DRILL_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static DRILL_WORKSPACES: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
const STALE_AFTER_MS: u64 = 30_000;

#[derive(Clone, Debug, Deserialize)]
struct AskSidecar {
    session_id: String,
    #[allow(dead_code)]
    project: String,
    cwd: String,
    tool_use_id: Option<String>,
    questions: Vec<AskQuestion>,
    #[serde(default)]
    event: String,
    #[serde(default)]
    visible_ts: Option<u64>,
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
    visible: bool,
    questions: Vec<AskQuestion>,
    #[serde(skip_serializing)]
    ts: u64,
    #[serde(skip_serializing)]
    visible_ts: Option<u64>,
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
        visible: ask.visible_ts.is_some() || ask.event == "PermissionRequest",
        questions: ask.questions,
        ts: ask.ts,
        visible_ts: ask.visible_ts,
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
    let found = scan_with(
        dir,
        |ask| resolve_project_with(ask, &session_rows, &bus_dir, &dev_root),
        |line| crate::app_trace(&line),
    )?;
    Ok(prune_stale_with(
        found,
        epoch_millis(),
        live_pane_for_session,
        |line| crate::app_trace(&line),
    ))
}

fn epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn prune_stale_with(
    mut found: AskMap,
    now_ms: u64,
    pane_for: impl Fn(&str) -> Option<String>,
    log: impl Fn(String),
) -> AskMap {
    found.retain(|path, ask| {
        if now_ms.saturating_sub(ask.ts) <= STALE_AFTER_MS || pane_for(&ask.session_id).is_some() {
            return true;
        }
        match std::fs::remove_file(path) {
            Ok(()) => {
                log(format!(
                    "ask stale removed session={} path={}",
                    ask.session_id,
                    path.display(),
                ));
                false
            }
            Err(error) => {
                log(format!(
                    "ask stale remove failed session={} path={} error={error}",
                    ask.session_id,
                    path.display(),
                ));
                true
            }
        }
    });
    found
}

fn reconcile(previous: &AskMap, current: &AskMap) -> Vec<OrchAsk> {
    let mut events = Vec::new();
    for (path, old) in previous {
        if current.get(path) != Some(old)
            && current.get(path).is_none_or(|ask| {
                ask.session_id != old.session_id || ask.tool_use_id != old.tool_use_id
            })
        {
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
        "ask received: project={} session={} tool={} open={} visible={}",
        ask.project,
        ask.session_id,
        ask.tool_use_id.as_deref().unwrap_or("null"),
        ask.open,
        ask.visible,
    ));
    if ask.open && ask.visible {
        crate::app_trace(&format!(
            "ask visible session={} via=permission-request ts={}",
            ask.session_id,
            ask.visible_ts.unwrap_or_else(epoch_millis),
        ));
    }
    window.emit("orch-ask", ask).is_ok()
}

fn ask_emitter(window: tauri::Window) -> tokio::sync::mpsc::UnboundedSender<OrchAsk> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<OrchAsk>();
    tauri::async_runtime::spawn(async move {
        while let Some(ask) = rx.recv().await {
            if !emit(&window, ask) {
                crate::app_trace("ask emit failed");
            }
        }
    });
    tx
}

#[tauri::command]
pub fn ask_watch(window: tauri::Window) -> Result<(), String> {
    let dir = crate::desktop_bus_dir().join("asks");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let replay = scan(&dir)?;
    let emit_tx = ask_emitter(window);
    for ask in replay.values().cloned() {
        if emit_tx.send(ask).is_err() {
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
        loop {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(()) => {
                    std::thread::sleep(Duration::from_millis(20));
                    while rx.try_recv().is_ok() {}
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
            let Ok(current) = scan(&dir) else { continue };
            let changes = reconcile(&known, &current);
            known = current;
            if changes.into_iter().any(|ask| emit_tx.send(ask).is_err()) {
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

fn answer_session_with(
    session_id: &str,
    data: &str,
    pane_for: impl Fn(&str) -> Option<String>,
    send: impl Fn(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    let pane = pane_for(session_id)
        .ok_or_else(|| "No pane hosts this session — answer it in its terminal.".to_string())?;
    send(&pane, data)
}

fn answer_session_blocking(session_id: String, data: String) -> Result<(), String> {
    answer_session_with(
        session_id.trim(),
        &data,
        live_pane_for_session,
        |pane, text| crate::ask_answer(pane.to_string(), text.to_string()),
    )
}

#[tauri::command]
pub async fn ask_answer_session(session_id: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || answer_session_blocking(session_id, data))
        .await
        .map_err(|error| format!("question answer task failed: {error}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskDrillSession {
    workspace: String,
    pane: String,
    agent: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskDrillProbe {
    session_id: Option<String>,
    sidecar_exists: bool,
    sidecar_ts: Option<u64>,
    transcript_lines: usize,
    trace_seen: bool,
    open_events: usize,
    webview_event_ts: Option<u64>,
    card_mount_ts: Option<u64>,
    picker_visible: bool,
    buttons_enabled_ts: Option<u64>,
    answer_clicked_ts: Option<u64>,
    answer_resolved_ts: Option<u64>,
    answer_rejected: Option<String>,
    tool_result_matches: bool,
    pane_advanced: bool,
}

fn drill_enabled(project: &str) -> Result<(), String> {
    match std::env::var("TRANTOR_ASK_DRILL") {
        Ok(expected) if expected.trim() == project => Ok(()),
        _ => Err("ask drill is disabled for this project".into()),
    }
}

fn herdr_output(args: &[&str], cwd: &Path) -> Result<serde_json::Value, String> {
    let output = crate::identity_env::command("herdr")
        .args(args)
        .current_dir(cwd)
        .env("PATH", crate::terminal_path())
        .output()
        .map_err(|error| format!("herdr {}: {error}", args.join(" ")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("herdr {}: {}", args.join(" "), stderr.trim()));
    }
    serde_json::from_str(stdout.trim())
        .map_err(|error| format!("herdr {} returned invalid JSON: {error}", args.join(" ")))
}

fn workspace_ids(value: &serde_json::Value) -> Option<(String, String)> {
    let result = value.get("result")?;
    let workspace = result
        .get("workspace")?
        .get("workspace_id")?
        .as_str()?
        .to_string();
    let pane = result
        .get("root_pane")?
        .get("pane_id")?
        .as_str()?
        .to_string();
    Some((workspace, pane))
}

fn close_workspace(workspace: &str, cwd: &Path) {
    let _ = herdr_output(&["workspace", "close", workspace], cwd);
}

fn ask_drill_start_blocking(project: String, marker: String) -> Result<AskDrillSession, String> {
    let project = project.trim();
    drill_enabled(project)?;
    if marker.is_empty()
        || marker.len() > 80
        || !marker
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("ask drill marker is invalid".into());
    }
    let cwd =
        crate::project_dir(project).ok_or_else(|| format!("no local checkout for {project}"))?;
    let label = format!("trantor:ask-drill:{marker}");
    let created = herdr_output(
        &[
            "workspace",
            "create",
            "--cwd",
            cwd.to_string_lossy().as_ref(),
            "--label",
            &label,
            "--no-focus",
        ],
        &cwd,
    )?;
    let (workspace, pane) = workspace_ids(&created)
        .ok_or_else(|| "herdr workspace create returned no workspace or root pane".to_string())?;
    let sequence = DRILL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let agent = format!("askdrill{}{}", std::process::id(), sequence);
    let question = format!("TRANTOR ASK DRILL {marker}: continue?");
    let advanced = format!("ASK-DRILL-ADVANCED {marker} Continue");
    let prompt = format!(
        "Call AskUserQuestion exactly once now. Ask the exact question '{question}' with header 'Drill' and two options: 'Continue' (description 'Advance the drill') and 'Stop' (description 'Stop the drill'). Print nothing before the tool call. After the operator answers, print exactly '{advanced}' and no other text."
    );
    let started = herdr_output(
        &[
            "agent",
            "start",
            &agent,
            "--kind",
            "claude",
            "--pane",
            &pane,
            "--timeout",
            "60000",
            "--",
            "--model",
            "haiku",
        ],
        &cwd,
    );
    if let Err(error) = started {
        close_workspace(&workspace, &cwd);
        return Err(error);
    }
    if let Err(error) = herdr_output(&["agent", "prompt", &agent, &prompt], &cwd) {
        close_workspace(&workspace, &cwd);
        return Err(error);
    }
    DRILL_WORKSPACES
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .map_err(|_| "ask drill workspace registry is poisoned".to_string())?
        .insert(workspace.clone());
    Ok(AskDrillSession {
        workspace,
        pane,
        agent,
    })
}

#[tauri::command]
pub async fn ask_drill_start(project: String, marker: String) -> Result<AskDrillSession, String> {
    tauri::async_runtime::spawn_blocking(move || ask_drill_start_blocking(project, marker))
        .await
        .map_err(|error| format!("ask drill start task failed: {error}"))?
}

fn value_contains(value: &serde_json::Value, needle: &str) -> bool {
    match value {
        serde_json::Value::String(text) => text.contains(needle),
        serde_json::Value::Array(items) => items.iter().any(|item| value_contains(item, needle)),
        serde_json::Value::Object(fields) => {
            fields.values().any(|item| value_contains(item, needle))
        }
        _ => false,
    }
}

fn transcript_facts(raw: &str, marker: &str) -> (bool, bool) {
    let mut ask_id = None;
    let mut answered = false;
    let advanced = format!("ASK-DRILL-ADVANCED {marker} Continue");
    for value in raw
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
    {
        let content = value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(|content| content.as_array());
        for item in content.into_iter().flatten() {
            if item.get("type").and_then(|kind| kind.as_str()) == Some("tool_use")
                && item.get("name").and_then(|name| name.as_str()) == Some("AskUserQuestion")
                && value_contains(
                    item.get("input").unwrap_or(&serde_json::Value::Null),
                    marker,
                )
            {
                ask_id = item
                    .get("id")
                    .and_then(|id| id.as_str())
                    .map(str::to_string);
            }
            if item.get("type").and_then(|kind| kind.as_str()) == Some("tool_result")
                && item.get("tool_use_id").and_then(|id| id.as_str()) == ask_id.as_deref()
                && value_contains(item, "Continue")
            {
                answered = true;
            }
        }
    }
    (answered, raw.contains(&advanced))
}

fn claude_transcript(cwd: &Path, session_id: &str) -> PathBuf {
    let slug: String = cwd
        .to_string_lossy()
        .chars()
        .map(|character| {
            if character == '/' || character == '.' {
                '-'
            } else {
                character
            }
        })
        .collect();
    Path::new(&std::env::var("HOME").unwrap_or_default())
        .join(".claude/projects")
        .join(slug)
        .join(format!("{session_id}.jsonl"))
}

fn find_sidecar(marker: &str) -> Option<(PathBuf, AskSidecar)> {
    let dir = crate::desktop_bus_dir().join("asks");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let raw = std::fs::read_to_string(&path).ok()?;
            let ask = serde_json::from_str::<AskSidecar>(&raw).ok()?;
            ask.questions
                .iter()
                .any(|question| question.question.contains(marker))
                .then_some((path, ask))
        })
        .next()
}

fn trace_timestamp(trace: &str, prefix: &str, session_id: &str) -> Option<u64> {
    trace
        .lines()
        .filter(|line| line.contains(prefix) && line.contains(&format!("session={session_id}")))
        .filter_map(|line| {
            line.split_whitespace()
                .find_map(|part| part.strip_prefix("ts="))?
                .parse::<u64>()
                .ok()
        })
        .min()
}

#[tauri::command]
pub fn ask_drill_probe(
    project: String,
    marker: String,
    session_id: Option<String>,
) -> Result<AskDrillProbe, String> {
    let project = project.trim();
    drill_enabled(project)?;
    let found = find_sidecar(&marker);
    let resolved_session = session_id
        .filter(|value| !value.trim().is_empty())
        .or_else(|| found.as_ref().map(|(_, ask)| ask.session_id.clone()));
    let sidecar_ts = found.as_ref().map(|(_, ask)| ask.ts);
    let sidecar_exists = resolved_session.as_ref().is_some_and(|sid| {
        crate::desktop_bus_dir()
            .join("asks")
            .join(format!("{sid}.json"))
            .is_file()
    });
    let cwd =
        crate::project_dir(project).ok_or_else(|| format!("no local checkout for {project}"))?;
    let transcript = resolved_session
        .as_deref()
        .and_then(|sid| std::fs::read_to_string(claude_transcript(&cwd, sid)).ok())
        .unwrap_or_default();
    let (tool_result_matches, pane_advanced) = transcript_facts(&transcript, &marker);
    let trace =
        std::fs::read_to_string(crate::desktop_bus_dir().join("app-trace.log")).unwrap_or_default();
    let trace_seen = resolved_session.as_deref().is_some_and(|sid| {
        trace.contains(&format!("ask received: project={project} session={sid}"))
    });
    let open_events = resolved_session.as_deref().map_or(0, |sid| {
        trace
            .lines()
            .filter(|line| {
                line.contains(&format!("ask received: project={project} session={sid}"))
                    && line.contains("open=true")
                    && line.contains("visible=false")
            })
            .count()
    });
    let webview_event_ts = resolved_session
        .as_deref()
        .and_then(|sid| trace_timestamp(&trace, "ask event in webview", sid));
    let card_mount_ts = resolved_session
        .as_deref()
        .and_then(|sid| trace_timestamp(&trace, "ask card mounted", sid));
    let picker_visible = resolved_session.as_deref().is_some_and(|sid| {
        trace
            .lines()
            .any(|line| line.contains("ask visible") && line.contains(&format!("session={sid}")))
    });
    let buttons_enabled_ts = resolved_session
        .as_deref()
        .and_then(|sid| trace_timestamp(&trace, "ask buttons enabled", sid));
    let answer_clicked_ts = resolved_session
        .as_deref()
        .and_then(|sid| trace_timestamp(&trace, "ask answer clicked", sid));
    let answer_resolved_ts = resolved_session
        .as_deref()
        .and_then(|sid| trace_timestamp(&trace, "ask answer resolved", sid));
    let answer_rejected = resolved_session.as_deref().and_then(|sid| {
        trace
            .lines()
            .rev()
            .find(|line| {
                line.contains("ask answer rejected") && line.contains(&format!("session={sid}"))
            })
            .map(str::to_string)
    });
    Ok(AskDrillProbe {
        session_id: resolved_session,
        sidecar_exists,
        sidecar_ts,
        transcript_lines: transcript.lines().count(),
        trace_seen,
        open_events,
        webview_event_ts,
        card_mount_ts,
        picker_visible,
        buttons_enabled_ts,
        answer_clicked_ts,
        answer_resolved_ts,
        answer_rejected,
        tool_result_matches,
        pane_advanced,
    })
}

#[tauri::command]
pub fn ask_drill_close(project: String, workspace: String) -> Result<(), String> {
    let project = project.trim();
    drill_enabled(project)?;
    let removed = DRILL_WORKSPACES
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .map_err(|_| "ask drill workspace registry is poisoned".to_string())?
        .remove(workspace.trim());
    if !removed {
        return Err("refusing to close a workspace this drill did not create".into());
    }
    let cwd =
        crate::project_dir(project).ok_or_else(|| format!("no local checkout for {project}"))?;
    herdr_output(&["workspace", "close", workspace.trim()], &cwd).map(|_| ())
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
            "event": "PreToolUse",
            "visible_ts": null,
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

        let mut visible_value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        visible_value["event"] = serde_json::json!("PermissionRequest");
        visible_value["visible_ts"] = serde_json::json!(2);
        fs::write(&path, visible_value.to_string()).unwrap();
        let visible = scan_with(&dir, project_for, |_| {}).unwrap();
        let visibility_update = reconcile(&first, &visible);
        assert_eq!(visibility_update.len(), 1);
        assert!(visibility_update[0].open);
        assert!(visibility_update[0].visible);

        write_ask(&dir, "sid-one", Some("tool-two"), "/tmp/trantor");
        let replaced = scan_with(&dir, project_for, |_| {}).unwrap();
        let replacement = reconcile(&visible, &replaced);
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
    fn stale_dead_session_is_deleted_and_reconciles_closed() {
        let dir = temp_dir();
        let stale_path = write_ask(&dir, "stale-session", None, "/tmp/trantor");
        let live_path = write_ask(&dir, "live-session", None, "/tmp/trantor");
        let previous = scan_with(&dir, |_| Some("trantor".to_string()), |_| {}).unwrap();
        let logs = std::cell::RefCell::new(Vec::new());
        let current = prune_stale_with(
            previous.clone(),
            STALE_AFTER_MS + 2,
            |session| (session == "live-session").then(|| "w2:p19".to_string()),
            |line| logs.borrow_mut().push(line),
        );
        assert!(!stale_path.exists());
        assert!(live_path.exists());
        assert_eq!(current.len(), 1);
        let closed = reconcile(&previous, &current);
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].session_id, "stale-session");
        assert!(!closed[0].open);
        assert!(logs.into_inner()[0].contains("ask stale removed"));
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
            event: "PreToolUse".into(),
            visible_ts: None,
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

    #[test]
    fn answer_routes_by_session_and_sends_immediately() {
        let steps = std::cell::RefCell::new(Vec::new());
        answer_session_with(
            "session-one",
            "\r",
            |_| {
                steps.borrow_mut().push("resolve".to_string());
                Some("w2:p19".to_string())
            },
            |pane, _| {
                steps.borrow_mut().push(format!("send:{pane}"));
                Ok(())
            },
        )
        .unwrap();
        let steps = steps.into_inner();
        assert_eq!(steps[0], "resolve");
        assert_eq!(steps[1], "send:w2:p19");
    }

    #[test]
    fn drill_reads_real_herdr_workspace_shape() {
        let value = serde_json::json!({
            "result": {
                "workspace": { "workspace_id": "w9" },
                "root_pane": { "pane_id": "w9:p1" }
            }
        });
        assert_eq!(workspace_ids(&value), Some(("w9".into(), "w9:p1".into())));
    }

    #[test]
    fn drill_reads_webview_and_mount_timestamps_from_trace() {
        let trace = concat!(
            "x ask event in webview session=s1 open=true ts=110\n",
            "x ask card mounted session=s1 tool=t1 ts=125\n",
        );
        assert_eq!(
            trace_timestamp(trace, "ask event in webview", "s1"),
            Some(110)
        );
        assert_eq!(trace_timestamp(trace, "ask card mounted", "s1"), Some(125));
    }

    #[test]
    fn drill_matches_the_ask_result_and_post_answer_advance() {
        let raw = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_drill","name":"AskUserQuestion","input":{"questions":[{"question":"TRANTOR ASK DRILL warm-1: continue?"}]}}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_drill","content":"Continue"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ASK-DRILL-ADVANCED warm-1 Continue"}]}}"#,
            "\n",
        );
        assert_eq!(transcript_facts(raw, "warm-1"), (true, true));
        assert_eq!(transcript_facts(raw, "cold-1"), (false, false));
    }
}
