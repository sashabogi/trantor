// Read-only view of an orchestrator session's sub-agent transcripts, for live Workspace tabs (#14265).
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::chat::{complete_lines, decode_chat_lines, orch_session_id, text_content};
use crate::hub::project_dir;
use crate::local_sessions::transcript_dir_for_project_dir;
use crate::transcript_facts::row_ts;

const ACTIVE_WINDOW_MS: u64 = 2 * 60 * 60 * 1000;
const RUNNING_WINDOW_MS: u64 = 60 * 1000;
const DESCRIPTION_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentRow {
    pub(crate) id: String,
    pub(crate) description: String,
    pub(crate) subagent_type: Option<String>,
    pub(crate) started_ms: Option<u64>,
    pub(crate) last_activity_ms: u64,
    pub(crate) rows: usize,
    /// "running" or "done".
    pub(crate) state: String,
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(m.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The `subagents` folder of the preferred session, else of the newest session folder that has one.
fn subagents_dir(tdir: &Path, preferred: Option<&str>) -> Option<PathBuf> {
    if let Some(sid) = preferred.filter(|s| valid_id(s)) {
        let d = tdir.join(sid).join("subagents");
        if d.is_dir() {
            return Some(d);
        }
    }
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(tdir).ok()?.flatten() {
        let d = entry.path().join("subagents");
        if !d.is_dir() {
            continue;
        }
        let stamp = mtime_ms(&d).unwrap_or(0);
        if best.as_ref().is_none_or(|(s, _)| stamp > *s) {
            best = Some((stamp, d));
        }
    }
    best.map(|(_, d)| d)
}

fn message_row_is_final(v: &Value) -> Option<bool> {
    let kind = v.get("type").and_then(Value::as_str)?;
    if kind != "user" && kind != "assistant" {
        return None;
    }
    if kind == "user" {
        return Some(false);
    }
    let calls_tool = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .is_some_and(|blocks| blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")));
    Some(!calls_tool)
}

fn first_prompt(lines: &[&str]) -> Option<String> {
    for line in lines.iter().take(20) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let text = text_content(v.get("message")?.get("content")?);
        let text = text.trim();
        if !text.is_empty() {
            return Some(text.chars().take(DESCRIPTION_CHARS).collect());
        }
    }
    None
}

fn row_for(jsonl: &Path, now_ms: u64) -> Option<SubagentRow> {
    let name = jsonl.file_name()?.to_str()?;
    let id = name.strip_prefix("agent-")?.strip_suffix(".jsonl")?.to_string();
    let last_activity_ms = mtime_ms(jsonl)?;
    if now_ms.saturating_sub(last_activity_ms) > ACTIVE_WINDOW_MS {
        return None;
    }
    let len = std::fs::metadata(jsonl).ok()?.len();
    let parsed = parsed_cached(jsonl, last_activity_ms, len, || parse_file(jsonl, &id))?;
    let fresh = now_ms.saturating_sub(last_activity_ms) <= RUNNING_WINDOW_MS;
    Some(SubagentRow {
        description: parsed.description,
        subagent_type: parsed.subagent_type,
        id,
        started_ms: parsed.started_ms,
        last_activity_ms,
        rows: parsed.rows,
        state: if fresh && !parsed.finished && !parsed.last_is_final { "running" } else { "done" }.into(),
    })
}

/// What a transcript says, independent of the clock; cached by mtime and size so the 12 s list poll
/// re-reads a file only when it grew (#14265: whole-file reads of every active transcript each poll).
#[derive(Clone)]
struct Parsed { description: String, subagent_type: Option<String>, started_ms: Option<u64>, rows: usize, last_is_final: bool, finished: bool }

fn parsed_cached(path: &Path, mtime: u64, len: u64, parse: impl FnOnce() -> Option<Parsed>) -> Option<Parsed> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    type Cache = Mutex<HashMap<PathBuf, (u64, u64, Parsed)>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((m, l, p)) = cache.lock().ok().and_then(|c| c.get(path).cloned()) {
        if m == mtime && l == len {
            return Some(p);
        }
    }
    let fresh = parse()?;
    if let Ok(mut c) = cache.lock() {
        c.insert(path.to_path_buf(), (mtime, len, fresh.clone()));
    }
    Some(fresh)
}

fn parse_file(jsonl: &Path, id: &str) -> Option<Parsed> {
    let raw = std::fs::read_to_string(jsonl).ok()?;
    let lines = complete_lines(&raw);
    let meta: Value = std::fs::read_to_string(jsonl.with_file_name(format!("agent-{id}.meta.json")))
        .ok()
        .and_then(|m| serde_json::from_str(&m).ok())
        .unwrap_or(Value::Null);
    let meta_text = |k: &str| meta.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let started_ms = lines.first().and_then(|l| serde_json::from_str::<Value>(l).ok()).and_then(|v| row_ts(&v));
    let last_is_final = lines
        .iter()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l).ok().and_then(|v| message_row_is_final(&v)))
        .unwrap_or(false);
    let finished = meta.get("finished").and_then(Value::as_bool).unwrap_or(false);
    Some(Parsed {
        description: meta_text("description").or_else(|| first_prompt(&lines)).unwrap_or_else(|| id.to_string()),
        subagent_type: meta_text("agentType"),
        started_ms,
        rows: lines.len(),
        last_is_final,
        finished,
    })
}

pub(crate) fn list_in(tdir: &Path, preferred: Option<&str>, now_ms: u64) -> Vec<SubagentRow> {
    let Some(dir) = subagents_dir(tdir, preferred) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut rows: Vec<SubagentRow> = entries.flatten().filter_map(|e| row_for(&e.path(), now_ms)).collect();
    rows.sort_by(|a, b| a.started_ms.cmp(&b.started_ms).then_with(|| a.id.cmp(&b.id)));
    rows
}

/// The same `(turns, results, total, meta, receipts)` answer `orchestrator_chat` gives, for rows after line `after`.
pub(crate) fn tail_in(tdir: &Path, preferred: Option<&str>, id: &str, after: usize) -> Result<String, String> {
    if !valid_id(id) {
        return Err("invalid sub-agent id".into());
    }
    let dir = subagents_dir(tdir, preferred).ok_or_else(|| "no sub-agents for this project".to_string())?;
    let raw = std::fs::read_to_string(dir.join(format!("agent-{id}.jsonl"))).map_err(|e| e.to_string())?;
    let lines = complete_lines(&raw);
    let total = lines.len();
    let snap = decode_chat_lines(lines.into_iter().skip(after), total);
    serde_json::to_string(&(snap.turns, snap.results, snap.total, snap.meta, snap.receipt_texts)).map_err(|e| e.to_string())
}

fn project_tdir(project: &str) -> Result<PathBuf, String> {
    let dir = project_dir(project).ok_or_else(|| format!("no local checkout for {project}"))?;
    Ok(transcript_dir_for_project_dir(&dir))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tauri::command]
pub(crate) fn subagents_list(project: String) -> Result<String, String> {
    let tdir = project_tdir(&project)?;
    serde_json::to_string(&list_in(&tdir, orch_session_id(&project).as_deref(), now_ms())).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn subagent_tail(project: String, id: String, after: usize) -> Result<String, String> {
    let tdir = project_tdir(&project)?;
    tail_in(&tdir, orch_session_id(&project).as_deref(), &id, after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const NOW: u64 = 1_800_000_000_000;

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("trantor-subagents-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).expect("temp dir");
        d
    }

    fn user(ts: &str, text: &str) -> String {
        serde_json::json!({"type":"user","timestamp":ts,"message":{"role":"user","content":text}}).to_string()
    }

    fn assistant(ts: &str, blocks: Value) -> String {
        serde_json::json!({"type":"assistant","timestamp":ts,"message":{"role":"assistant","content":blocks}}).to_string()
    }

    fn put(tdir: &Path, sid: &str, id: &str, rows: &[String], meta: Option<&str>, age_ms: u64) {
        let dir = tdir.join(sid).join("subagents");
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join(format!("agent-{id}.jsonl"));
        fs::write(&path, rows.join("\n") + "\n").expect("rows");
        if let Some(m) = meta {
            fs::write(dir.join(format!("agent-{id}.meta.json")), m).expect("meta");
        }
        let when = UNIX_EPOCH + std::time::Duration::from_millis(NOW - age_ms);
        fs::File::options().write(true).open(&path).expect("open").set_modified(when).expect("mtime");
    }

    fn working() -> Vec<String> {
        vec![
            user("2026-11-25T09:00:00.000Z", "Review the diff and report findings"),
            assistant("2026-11-25T09:00:05.000Z", serde_json::json!([{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a"}}])),
        ]
    }

    #[test]
    fn a_fresh_unfinished_agent_is_running_and_a_final_message_is_done() {
        let t = temp();
        put(&t, "s1", "run", &working(), Some(r#"{"description":"Review slice","agentType":"general-purpose"}"#), 5_000);
        let mut done = working();
        done.push(assistant("2026-11-25T09:01:00.000Z", serde_json::json!([{"type":"text","text":"All good.\nDetails follow."}])));
        put(&t, "s1", "fin", &done, None, 5_000);
        let rows = list_in(&t, Some("s1"), NOW);
        let run = rows.iter().find(|r| r.id == "run").expect("run row");
        assert_eq!((run.state.as_str(), run.rows, run.description.as_str()), ("running", 2, "Review slice"));
        assert_eq!(run.subagent_type.as_deref(), Some("general-purpose"));
        assert!(run.started_ms.is_some());
        let fin = rows.iter().find(|r| r.id == "fin").expect("fin row");
        assert_eq!(fin.state, "done");
        assert_eq!(fin.description, "Review the diff and report findings");
    }

    #[test]
    fn a_quiet_agent_is_done_and_a_stale_one_is_not_listed() {
        let t = temp();
        put(&t, "s1", "quiet", &working(), Some(r#"{"finished":false}"#), 90_000);
        put(&t, "s1", "marked", &working(), Some(r#"{"finished":true}"#), 1_000);
        put(&t, "s1", "old", &working(), None, 3 * 60 * 60 * 1000);
        let rows = list_in(&t, Some("s1"), NOW);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.state == "done"));
        assert!(rows.iter().all(|r| r.id != "old"));
    }

    #[test]
    fn the_orchestrators_session_wins_else_the_newest_session_with_sub_agents() {
        let t = temp();
        put(&t, "mine", "a", &working(), None, 1_000);
        put(&t, "other", "b", &working(), None, 1_000);
        assert_eq!(list_in(&t, Some("mine"), NOW)[0].id, "a");
        assert_eq!(list_in(&t, Some("../x"), NOW).len(), 1);
        assert!(list_in(&t.join("missing"), None, NOW).is_empty());
    }

    #[test]
    fn the_tail_returns_only_rows_after_the_offset_and_refuses_bad_ids() {
        let t = temp();
        put(&t, "s1", "a", &working(), None, 1_000);
        let all: (Vec<Value>, Vec<Value>, usize, Value, Vec<String>) = serde_json::from_str(&tail_in(&t, Some("s1"), "a", 0).expect("tail")).expect("json");
        assert_eq!((all.0.len(), all.2), (2, 2));
        let rest: (Vec<Value>, Vec<Value>, usize, Value, Vec<String>) = serde_json::from_str(&tail_in(&t, Some("s1"), "a", 1).expect("tail")).expect("json");
        assert_eq!((rest.0.len(), rest.2), (1, 2));
        let none: (Vec<Value>, Vec<Value>, usize, Value, Vec<String>) = serde_json::from_str(&tail_in(&t, Some("s1"), "a", 2).expect("tail")).expect("json");
        assert_eq!((none.0.len(), none.2), (0, 2));
        assert!(tail_in(&t, Some("s1"), "../a", 0).is_err());
        assert!(tail_in(&t, Some("s1"), "nope", 0).is_err());
    }
}
