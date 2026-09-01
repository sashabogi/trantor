use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

static SESSION_INDEX: std::sync::Mutex<Option<HashMap<String, SessionRecord>>> =
    std::sync::Mutex::new(None);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRow {
    id: String,
    harness: String,
    title: String,
    last_message: String,
    message_count: usize,
    model: String,
    branch: String,
    updated_at: u64,
    cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct TranscriptMessage {
    role: String,
    text: String,
}

#[derive(Debug, Clone)]
struct SessionRecord {
    row: SessionRow,
    transcript: Option<PathBuf>,
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn file_mtime_ms(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn one_line(raw: &str) -> String {
    let clean = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > 220 {
        clean.chars().take(219).collect::<String>() + "…"
    } else {
        clean
    }
}

fn text_content(value: &Value) -> String {
    match value {
        Value::String(s) => one_line(s),
        Value::Array(items) => one_line(
            &items
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .or_else(|| part.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => String::new(),
    }
}

fn full_text_content(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .or_else(|| part.get("content"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

fn lines(path: &Path) -> Result<impl Iterator<Item = String>, String> {
    let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(BufReader::new(file).lines().map_while(Result::ok))
}

fn row_title(first_user: String, fallback: &str) -> String {
    if first_user.is_empty() {
        fallback.to_string()
    } else {
        first_user
    }
}

fn decode_claude(path: &Path) -> Result<SessionRecord, String> {
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let mut first_user = String::new();
    let mut last_message = String::new();
    let mut message_count = 0;
    let mut model = String::new();
    let mut branch = String::new();
    let mut cwd = String::new();
    for line in lines(path)? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(value_cwd) = value.get("cwd").and_then(Value::as_str) {
            cwd = value_cwd.to_string();
        }
        if let Some(value_branch) = value.get("gitBranch").and_then(Value::as_str) {
            branch = value_branch.to_string();
        }
        let Some(role) = value.get("type").and_then(Value::as_str) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        message_count += 1;
        let text = value
            .get("message")
            .and_then(|m| m.get("content"))
            .map(text_content)
            .unwrap_or_default();
        if role == "user" && first_user.is_empty() && !text.is_empty() {
            first_user = text.clone();
        }
        if !text.is_empty() {
            last_message = text;
        }
        if role == "assistant"
            && value
                .get("message")
                .and_then(|m| m.get("usage"))
                .is_some_and(|usage| !usage.is_null())
        {
            model = value
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
    }
    Ok(SessionRecord {
        row: SessionRow {
            id: id.clone(),
            harness: "claude".into(),
            title: row_title(first_user, &id),
            last_message,
            message_count,
            model,
            branch,
            updated_at: file_mtime_ms(path),
            cwd,
        },
        transcript: Some(path.to_path_buf()),
    })
}

fn decode_codex(path: &Path) -> Result<SessionRecord, String> {
    let fallback_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let mut id = fallback_id.clone();
    let mut first_user = String::new();
    let mut last_message = String::new();
    let mut message_count = 0;
    let mut model = String::new();
    let mut branch = String::new();
    let mut cwd = String::new();
    for line in lines(path)? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = value.get("payload").unwrap_or(&Value::Null);
        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(&fallback_id)
                    .to_string();
                cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                branch = payload
                    .get("git")
                    .and_then(|git| git.get("branch"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
            Some("turn_context") => {
                if let Some(value_cwd) = payload.get("cwd").and_then(Value::as_str) {
                    cwd = value_cwd.to_string();
                }
                if let Some(value_model) = payload.get("model").and_then(Value::as_str) {
                    model = value_model.to_string();
                }
            }
            Some("response_item") => {
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if role != "user" && role != "assistant" {
                    continue;
                }
                message_count += 1;
                let text = payload.get("content").map(text_content).unwrap_or_default();
                if role == "user" && first_user.is_empty() && !text.is_empty() {
                    first_user = text.clone();
                }
                if !text.is_empty() {
                    last_message = text;
                }
            }
            _ => {}
        }
    }
    Ok(SessionRecord {
        row: SessionRow {
            id: id.clone(),
            harness: "codex".into(),
            title: row_title(first_user, &id),
            last_message,
            message_count,
            model,
            branch,
            updated_at: file_mtime_ms(path),
            cwd,
        },
        transcript: Some(path.to_path_buf()),
    })
}

fn branch_from_cwd(cwd: &str) -> String {
    let parts = Path::new(cwd)
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    parts
        .windows(3)
        .find(|window| window[0] == "worktrees")
        .map(|window| format!("seat/{}", window[2]))
        .unwrap_or_default()
}

fn decode_kimi(path: &Path, cwd: String) -> Result<SessionRecord, String> {
    let id = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let mut first_user = String::new();
    let mut last_message = String::new();
    let mut message_count = 0;
    for line in lines(path)? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let role = value
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        message_count += 1;
        let text = value.get("content").map(text_content).unwrap_or_default();
        if role == "user" && first_user.is_empty() && !text.is_empty() {
            first_user = text.clone();
        }
        if !text.is_empty() {
            last_message = text;
        }
    }
    Ok(SessionRecord {
        row: SessionRow {
            id: id.clone(),
            harness: "kimi".into(),
            title: row_title(first_user, &id),
            last_message,
            message_count,
            model: String::new(),
            branch: branch_from_cwd(&cwd),
            updated_at: file_mtime_ms(path),
            cwd,
        },
        transcript: Some(path.to_path_buf()),
    })
}

fn visit_files(root: &Path, depth: usize, out: &mut Vec<PathBuf>, accept: fn(&Path) -> bool) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit_files(&path, depth - 1, out, accept);
        } else if accept(&path) {
            out.push(path);
        }
    }
}

fn project_cwds(project: &str, scope: &str) -> Vec<PathBuf> {
    let home = home_dir();
    let root = std::env::var("TRANTOR_DEV_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join("development"))
        .join(project);
    let mut paths = vec![root];
    if scope == "project" {
        let seats = home.join(".agent-bus/worktrees").join(project);
        if let Ok(entries) = std::fs::read_dir(seats) {
            paths.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir()),
            );
        }
    }
    paths
}

fn claude_cwd_slug(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

fn codex_session_cwd(path: &Path) -> String {
    let Ok(file_lines) = lines(path) else {
        return String::new();
    };
    for line in file_lines.take(8) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            return value
                .get("payload")
                .and_then(|payload| payload.get("cwd"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
    }
    String::new()
}

fn known_cwd_hashes() -> HashMap<String, String> {
    let home = home_dir();
    let mut candidates = Vec::new();
    for root in [home.join("development"), home.join(".agent-bus/worktrees")] {
        let Ok(level_one) = std::fs::read_dir(root) else {
            continue;
        };
        for first in level_one.flatten().filter(|entry| entry.path().is_dir()) {
            candidates.push(first.path());
            if let Ok(level_two) = std::fs::read_dir(first.path()) {
                candidates.extend(
                    level_two
                        .flatten()
                        .map(|entry| entry.path())
                        .filter(|path| path.is_dir()),
                );
            }
        }
    }
    candidates
        .into_iter()
        .map(|path| {
            let cwd = path.to_string_lossy().to_string();
            (format!("{:x}", md5::compute(cwd.as_bytes())), cwd)
        })
        .collect()
}

fn collect_file_sessions(project_scope: Option<(&str, &str)>) -> Vec<SessionRecord> {
    let home = home_dir();
    let mut records = Vec::new();
    let mut paths = Vec::new();
    if let Some((project, scope)) = project_scope {
        for cwd in project_cwds(project, scope) {
            visit_files(
                &home.join(".claude/projects").join(claude_cwd_slug(&cwd)),
                1,
                &mut paths,
                |path| path.extension().and_then(|s| s.to_str()) == Some("jsonl"),
            );
        }
    } else {
        visit_files(&home.join(".claude/projects"), 3, &mut paths, |path| {
            path.extension().and_then(|s| s.to_str()) == Some("jsonl")
                && path.parent().and_then(Path::parent).is_some()
        });
    }
    records.extend(paths.iter().filter_map(|path| decode_claude(path).ok()));

    paths.clear();
    visit_files(&home.join(".codex/sessions"), 6, &mut paths, |path| {
        path.extension().and_then(|s| s.to_str()) == Some("jsonl")
    });
    records.extend(paths.iter().filter_map(|path| {
        if let Some((project, scope)) = project_scope {
            let probe = SessionRow {
                id: String::new(),
                harness: "codex".into(),
                title: String::new(),
                last_message: String::new(),
                message_count: 0,
                model: String::new(),
                branch: String::new(),
                updated_at: 0,
                cwd: codex_session_cwd(path),
            };
            if !in_scope(&probe, project, scope) {
                return None;
            }
        }
        decode_codex(path).ok()
    }));

    let cwd_hashes = known_cwd_hashes();
    paths.clear();
    if let Some((project, scope)) = project_scope {
        for cwd in project_cwds(project, scope) {
            let hash = format!("{:x}", md5::compute(cwd.to_string_lossy().as_bytes()));
            visit_files(
                &home.join(".kimi/sessions").join(hash),
                2,
                &mut paths,
                |path| path.file_name().and_then(|s| s.to_str()) == Some("context.jsonl"),
            );
        }
    } else {
        visit_files(&home.join(".kimi/sessions"), 4, &mut paths, |path| {
            path.file_name().and_then(|s| s.to_str()) == Some("context.jsonl")
        });
    }
    records.extend(paths.iter().filter_map(|path| {
        let hash = path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        decode_kimi(path, cwd_hashes.get(hash).cloned().unwrap_or_default()).ok()
    }));
    records
}

fn cache_records(records: &[SessionRecord]) {
    let mut guard = SESSION_INDEX.lock().unwrap();
    let index = guard.get_or_insert_with(HashMap::new);
    for record in records {
        index.insert(
            format!("{}:{}", record.row.harness, record.row.id),
            record.clone(),
        );
    }
}

fn cached_record(harness: &str, id: &str) -> Option<SessionRecord> {
    SESSION_INDEX
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|index| index.get(&format!("{harness}:{id}")).cloned())
}

fn open_code_row(value: &Value) -> Option<SessionRecord> {
    let id = value.get("id")?.as_str()?.to_string();
    let cwd = value
        .get("directory")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let title = value
        .get("first_user")
        .or_else(|| value.get("title"))
        .and_then(Value::as_str)
        .map(one_line)
        .unwrap_or_else(|| id.clone());
    Some(SessionRecord {
        row: SessionRow {
            id,
            harness: "opencode".into(),
            title,
            last_message: value
                .get("last_message")
                .and_then(Value::as_str)
                .map(one_line)
                .unwrap_or_default(),
            message_count: value
                .get("message_count")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            model: value
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            branch: branch_from_cwd(&cwd),
            updated_at: value
                .get("updated_at")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            cwd,
        },
        transcript: None,
    })
}

const OPEN_CODE_LIST_SQL: &str = r#"
SELECT s.id,
       s.directory,
       s.title,
       COALESCE(json_extract(s.model, '$.id'), '') AS model,
       s.time_updated AS updated_at,
       (SELECT COUNT(*) FROM message m
         WHERE m.session_id = s.id
           AND json_extract(m.data, '$.role') IN ('user', 'assistant')) AS message_count,
       COALESCE((SELECT json_extract(p.data, '$.text')
                   FROM message m JOIN part p ON p.message_id = m.id
                  WHERE m.session_id = s.id
                    AND json_extract(m.data, '$.role') = 'user'
                    AND json_extract(p.data, '$.type') = 'text'
                  ORDER BY m.time_created, p.time_created LIMIT 1), s.title) AS first_user,
       COALESCE((SELECT json_extract(p.data, '$.text')
                   FROM message m JOIN part p ON p.message_id = m.id
                  WHERE m.session_id = s.id
                    AND json_extract(m.data, '$.role') IN ('user', 'assistant')
                    AND json_extract(p.data, '$.type') = 'text'
                  ORDER BY m.time_created DESC, p.time_created DESC LIMIT 1), '') AS last_message
  FROM session s
 ORDER BY s.time_updated DESC;
"#;

fn sqlite_json(sql: &str) -> Result<Value, String> {
    let db = home_dir().join(".local/share/opencode/opencode.db");
    if !db.exists() {
        return Ok(Value::Array(Vec::new()));
    }
    let output = Command::new("/usr/bin/sqlite3")
        .args(["-readonly", "-json"])
        .arg(&db)
        .arg(sql)
        .output()
        .map_err(|e| format!("{}: {e}", db.display()))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("OpenCode session store: {e}"))
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn collect_open_code(project_scope: Option<(&str, &str)>) -> Result<Vec<SessionRecord>, String> {
    let sql = if let Some((project, scope)) = project_scope {
        let cwds = project_cwds(project, scope);
        let where_clause = cwds
            .iter()
            .map(|cwd| {
                let cwd = cwd.to_string_lossy();
                format!(
                    "(s.directory = {} OR s.directory LIKE {})",
                    sql_string(&cwd),
                    sql_string(&format!("{cwd}/%")),
                )
            })
            .collect::<Vec<_>>()
            .join(" OR ");
        OPEN_CODE_LIST_SQL.replace(
            "  FROM session s\n ORDER",
            &format!("  FROM session s\n WHERE {where_clause}\n ORDER"),
        )
    } else {
        OPEN_CODE_LIST_SQL.to_string()
    };
    Ok(sqlite_json(&sql)?
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(open_code_row)
        .collect())
}

fn is_same_or_child(path: &str, root: &Path) -> bool {
    let path = Path::new(path);
    path == root || path.starts_with(root)
}

fn in_scope(row: &SessionRow, project: &str, scope: &str) -> bool {
    if scope == "all" {
        return true;
    }
    let home = home_dir();
    let project_root = std::env::var("TRANTOR_DEV_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join("development"))
        .join(project);
    if scope == "worktree" {
        return is_same_or_child(&row.cwd, &project_root);
    }
    let seats_root = home.join(".agent-bus/worktrees").join(project);
    is_same_or_child(&row.cwd, &project_root) || is_same_or_child(&row.cwd, &seats_root)
}

fn sessions_list_sync(project: String, scope: String) -> Result<String, String> {
    let project = project.trim();
    if project.is_empty() {
        return Err("project is required".into());
    }
    if !matches!(scope.as_str(), "worktree" | "project" | "all") {
        return Err("scope must be worktree, project, or all".into());
    }
    let project_scope = (scope != "all").then_some((project, scope.as_str()));
    let mut records = collect_file_sessions(project_scope);
    records.extend(collect_open_code(project_scope)?);
    cache_records(&records);
    let mut rows = records
        .into_iter()
        .map(|record| record.row)
        .filter(|row| in_scope(row, project, &scope))
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    serde_json::to_string(&rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sessions_list(project: String, scope: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || sessions_list_sync(project, scope))
        .await
        .map_err(|e| format!("session discovery task: {e}"))?
}

pub fn claude_transcript_path(_project: &str, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid Claude session id".into());
    }
    if let Some(record) = cached_record("claude", id) {
        return record
            .transcript
            .ok_or_else(|| "Claude transcript path is unavailable".to_string());
    }
    let mut paths = Vec::new();
    visit_files(
        &home_dir().join(".claude/projects"),
        3,
        &mut paths,
        |path| path.extension().and_then(|s| s.to_str()) == Some("jsonl"),
    );
    let record = paths
        .into_iter()
        .filter(|path| path.file_stem().and_then(|s| s.to_str()) == Some(id))
        .filter_map(|path| decode_claude(&path).ok())
        .next()
        .ok_or_else(|| "Claude session transcript was not found".to_string())?;
    record
        .transcript
        .ok_or_else(|| "Claude transcript path is unavailable".to_string())
}

fn transcript_messages(record: &SessionRecord) -> Result<Vec<TranscriptMessage>, String> {
    let path = record
        .transcript
        .as_deref()
        .ok_or_else(|| "transcript path is unavailable".to_string())?;
    let mut messages = Vec::new();
    for line in lines(path)? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let (role, content) = match record.row.harness.as_str() {
            "codex" => {
                if value.get("type").and_then(Value::as_str) != Some("response_item") {
                    continue;
                }
                let payload = value.get("payload").unwrap_or(&Value::Null);
                (
                    payload.get("role").and_then(Value::as_str),
                    payload.get("content"),
                )
            }
            "kimi" => (
                value.get("role").and_then(Value::as_str),
                value.get("content"),
            ),
            _ => continue,
        };
        let Some(role) = role.filter(|role| *role == "user" || *role == "assistant") else {
            continue;
        };
        let text = content.map(full_text_content).unwrap_or_default();
        if !text.is_empty() {
            messages.push(TranscriptMessage {
                role: role.to_string(),
                text,
            });
        }
    }
    Ok(messages)
}

fn open_code_transcript(id: &str) -> Result<Vec<TranscriptMessage>, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("invalid OpenCode session id".into());
    }
    let quoted = id.replace('\'', "''");
    let sql = format!(
        r#"SELECT json_extract(m.data, '$.role') AS role,
                  json_extract(p.data, '$.text') AS text
             FROM message m JOIN part p ON p.message_id = m.id
            WHERE m.session_id = '{quoted}'
              AND json_extract(m.data, '$.role') IN ('user', 'assistant')
              AND json_extract(p.data, '$.type') = 'text'
            ORDER BY m.time_created, p.time_created;"#,
    );
    Ok(sqlite_json(&sql)?
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let role = value.get("role")?.as_str()?;
            let text = value.get("text")?.as_str()?.trim().to_string();
            (!text.is_empty()).then(|| TranscriptMessage {
                role: role.to_string(),
                text,
            })
        })
        .collect())
}

fn session_transcript_sync(project: String, harness: String, id: String) -> Result<String, String> {
    if project.trim().is_empty() {
        return Err("project is required".into());
    }
    let messages = if harness == "opencode" {
        if cached_record("opencode", &id).is_none() {
            let records = collect_open_code(None)?;
            if !records.iter().any(|record| record.row.id == id) {
                return Err("OpenCode session was not found".into());
            }
            cache_records(&records);
        }
        open_code_transcript(&id)?
    } else {
        let record = cached_record(&harness, &id)
            .or_else(|| {
                collect_file_sessions(None)
                    .into_iter()
                    .find(|record| record.row.id == id && record.row.harness == harness)
            })
            .ok_or_else(|| "session was not found".to_string())?;
        transcript_messages(&record)?
    };
    serde_json::to_string(&messages).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_transcript(
    project: String,
    harness: String,
    id: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || session_transcript_sync(project, harness, id))
        .await
        .map_err(|e| format!("session transcript task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test-fixtures/sessions")
            .join(name)
    }

    #[test]
    fn claude_fixture_decodes_user_row_and_reported_branch() {
        let record = decode_claude(&fixture("claude.jsonl")).unwrap();
        assert_eq!(record.row.harness, "claude");
        assert_eq!(record.row.title, "Review the session store");
        assert_eq!(record.row.branch, "seat/codex");
        assert_eq!(record.row.model, "claude-fable-5");
        assert_eq!(record.row.message_count, 2);
    }

    #[test]
    fn codex_fixture_decodes_meta_context_and_messages() {
        let record = decode_codex(&fixture("codex.jsonl")).unwrap();
        assert_eq!(record.row.id, "codex-fixture");
        assert_eq!(record.row.title, "Build the Sessions pane");
        assert_eq!(record.row.model, "gpt-5.5");
        assert_eq!(record.row.branch, "seat/codex");
        assert_eq!(record.row.message_count, 2);
    }

    #[test]
    fn kimi_fixture_decodes_context_rows_without_inventing_model() {
        let record = decode_kimi(
            &fixture("kimi.jsonl"),
            "/Users/test/.agent-bus/worktrees/trantor/kimi".into(),
        )
        .unwrap();
        assert_eq!(record.row.title, "Inspect the board");
        assert_eq!(record.row.model, "");
        assert_eq!(record.row.branch, "seat/kimi");
        assert_eq!(record.row.message_count, 2);
    }

    #[test]
    fn opencode_fixture_decodes_exported_sqlite_row() {
        let raw = fs::read_to_string(fixture("opencode.jsonl")).unwrap();
        let value: Value = serde_json::from_str(raw.trim()).unwrap();
        let record = open_code_row(&value).unwrap();
        assert_eq!(record.row.title, "Stage the changes");
        assert_eq!(record.row.model, "glm-5.3-flash");
        assert_eq!(record.row.branch, "seat/glm");
        assert_eq!(record.row.message_count, 7);
    }

    #[test]
    fn scope_is_exact_and_rejects_similar_project_names() {
        let row = SessionRow {
            id: "s".into(),
            harness: "codex".into(),
            title: "t".into(),
            last_message: String::new(),
            message_count: 0,
            model: String::new(),
            branch: String::new(),
            updated_at: 0,
            cwd: format!(
                "{}/.agent-bus/worktrees/trantor/codex",
                home_dir().display()
            ),
        };
        assert!(in_scope(&row, "trantor", "project"));
        assert!(!in_scope(&row, "trantor-old", "project"));
    }

    #[test]
    fn transcript_content_preserves_line_breaks() {
        let value = serde_json::json!([
            {"type": "input_text", "text": "first line\nsecond line"},
            {"type": "output_text", "text": "third line"}
        ]);
        assert_eq!(
            full_text_content(&value),
            "first line\nsecond line\nthird line"
        );
    }
}
