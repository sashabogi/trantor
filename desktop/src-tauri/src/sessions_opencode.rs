// OpenCode's session store: one SQLite database read through the system sqlite3, as JSON.
use super::*;

pub(super) fn open_code_row(value: &Value) -> Option<SessionRecord> {
    let id = value.get("id")?.as_str()?.to_string();
    let cwd = value
        .get("directory")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let messages = value
        .get("messages")
        .and_then(|messages| match messages {
            Value::Array(items) => Some(items.clone()),
            Value::String(raw) => serde_json::from_str::<Vec<Value>>(raw).ok(),
            _ => None,
        })
        .unwrap_or_default();
    let display_text = |message: &Value| {
        let role = message.get("role").and_then(Value::as_str)?;
        let content = message.get("text").unwrap_or(&Value::Null);
        real_message_text(message, role, content)
    };
    let mut first_user = String::new();
    let mut first_assistant = String::new();
    for message in messages.iter() {
        let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
        if let Some(text) = display_text(message) {
            if role == "user" && first_user.is_empty() {
                first_user = text;
            } else if role == "assistant" && first_assistant.is_empty() {
                first_assistant = text;
            }
        }
    }
    // The store-field fallback carries the LAST ROW'S REAL ROLE (#5842 residual): the runner's
    // message envelope lands as a user row, and attributing it "assistant" silently skipped the
    // injection check that filters it from lastMessage.
    let last_role = value
        .get("last_role")
        .and_then(Value::as_str)
        .unwrap_or("assistant");
    let last_message = messages
        .iter()
        .rev()
        .find_map(display_text)
        .or_else(|| {
            value
                .get("last_message")
                .and_then(Value::as_str)
                .and_then(|text| {
                    real_message_text(&Value::Null, last_role, &Value::String(text.into()))
                })
        })
        .unwrap_or_default();
    // The title ladder (#5842): real user text, then the store's own first-user field (still
    // injection-filtered — the crew boot prompt pools there), then real assistant text, then the
    // last real message, then "untitled". The session id is NEVER a title, and OpenCode's own
    // `title` field is never trusted raw: it is exactly where the boot prompt pooled.
    let stored_first_user = value
        .get("first_user")
        .and_then(Value::as_str)
        .and_then(|text| real_message_text(&Value::Null, "user", &Value::String(text.into())));
    let title = if !first_user.is_empty() {
        first_user
    } else if let Some(text) = stored_first_user {
        text
    } else if !first_assistant.is_empty() {
        first_assistant
    } else if !last_message.is_empty() {
        last_message.clone()
    } else {
        "untitled".to_string()
    };
    Some(SessionRecord {
        row: SessionRow {
            id,
            harness: "opencode".into(),
            title,
            last_message,
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

pub(super) const OPEN_CODE_LIST_SQL: &str = r#"
SELECT s.id,
       s.directory,
       s.title,
       COALESCE(json_extract(s.model, '$.id'), '') AS model,
       s.time_updated AS updated_at,
       (SELECT COUNT(*) FROM message m
         WHERE m.session_id = s.id
           AND json_extract(m.data, '$.role') IN ('user', 'assistant')) AS message_count,
       COALESCE((SELECT json_group_array(json_object(
                            'role', rows.role,
                            'text', rows.text,
                            'isMeta', rows.is_meta))
                   FROM (SELECT json_extract(m.data, '$.role') AS role,
                                json_extract(p.data, '$.text') AS text,
                                json_extract(m.data, '$.isMeta') AS is_meta
                           FROM message m JOIN part p ON p.message_id = m.id
                          WHERE m.session_id = s.id
                            AND json_extract(m.data, '$.role') IN ('user', 'assistant')
                            AND json_extract(p.data, '$.type') = 'text'
                          ORDER BY m.time_created, p.time_created) AS rows), '[]') AS messages,
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
                   ORDER BY m.time_created DESC, p.time_created DESC LIMIT 1), '') AS last_message,
       COALESCE((SELECT json_extract(m.data, '$.role')
                    FROM message m JOIN part p ON p.message_id = m.id
                   WHERE m.session_id = s.id
                     AND json_extract(m.data, '$.role') IN ('user', 'assistant')
                     AND json_extract(p.data, '$.type') = 'text'
                   ORDER BY m.time_created DESC, p.time_created DESC LIMIT 1), 'assistant') AS last_role
  FROM session s
 ORDER BY s.time_updated DESC;
"#;

pub(super) fn sqlite_json(sql: &str) -> Result<Value, String> {
    sqlite_json_at(&home_dir().join(".local/share/opencode/opencode.db"), sql)
}

/// A missing or zero-byte database holds no sessions; anything sqlite3 refuses is the store's error.
pub(super) fn sqlite_json_at(db: &Path, sql: &str) -> Result<Value, String> {
    if db.metadata().map_or(true, |m| m.len() == 0) {
        return Ok(Value::Array(Vec::new()));
    }
    let output = Command::new("/usr/bin/sqlite3")
        .args(["-readonly", "-json"])
        .arg(db)
        .arg(sql)
        .output()
        .map_err(|e| format!("{}: {e}", db.display()))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    parse_sqlite_json(&output.stdout)
}

/// `sqlite3 -json` prints NOTHING for zero rows, so empty output is an empty list (#13987 drill:
/// parsing it raised "EOF while parsing" and blanked every harness's sessions).
pub(super) fn parse_sqlite_json(stdout: &[u8]) -> Result<Value, String> {
    if stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Array(Vec::new()));
    }
    serde_json::from_slice(stdout).map_err(|e| format!("OpenCode session store: {e}"))
}

pub(super) fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(super) fn collect_open_code(project_scope: Option<(&str, &str)>) -> Result<Vec<SessionRecord>, String> {
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

pub(super) fn open_code_transcript(id: &str) -> Result<Vec<TranscriptMessage>, String> {
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


#[cfg(test)]
mod store_tests {
    // #13987 drill: one unreadable harness store must not blank the sessions of the others.
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trantor-oc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn healthy() -> SessionRecord {
        let value = serde_json::json!({"id": "ses_ok", "directory": "/tmp/acme", "messages": [
            {"role": "user", "text": "Fix the list"}], "message_count": 1, "updated_at": 5});
        open_code_row(&value).unwrap()
    }

    #[test]
    fn zero_rows_print_nothing_and_read_as_no_sessions() {
        assert_eq!(parse_sqlite_json(b"").unwrap(), Value::Array(Vec::new()));
        assert_eq!(parse_sqlite_json(b"\n").unwrap(), Value::Array(Vec::new()));
        assert!(parse_sqlite_json(b"[{\"id\":").is_err());
    }

    #[test]
    fn an_empty_or_missing_store_file_is_no_sessions() {
        let dir = tmp("empty");
        let db = dir.join("opencode.db");
        std::fs::write(&db, b"").unwrap();
        assert_eq!(sqlite_json_at(&db, OPEN_CODE_LIST_SQL).unwrap(), Value::Array(Vec::new()));
        assert_eq!(sqlite_json_at(&dir.join("absent.db"), OPEN_CODE_LIST_SQL).unwrap(), Value::Array(Vec::new()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_store_with_no_matching_rows_is_no_sessions() {
        if !Path::new("/usr/bin/sqlite3").exists() {
            return; // the reader shells to the system sqlite3; without it there is no store to read
        }
        let dir = tmp("zero");
        let db = dir.join("opencode.db");
        let made = Command::new("/usr/bin/sqlite3").arg(&db).arg("CREATE TABLE t(id TEXT);").status().unwrap();
        assert!(made.success());
        assert_eq!(sqlite_json_at(&db, "SELECT id FROM t;").unwrap(), Value::Array(Vec::new()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_store_is_a_warning_beside_the_healthy_sessions() {
        let dir = tmp("corrupt");
        let db = dir.join("opencode.db");
        std::fs::write(&db, b"this is not a sqlite database").unwrap();
        let corrupt = sqlite_json_at(&db, OPEN_CODE_LIST_SQL).map(|_| Vec::new());
        assert!(corrupt.is_err());
        let (records, warnings) = merge_store_reads(vec![
            ("files", Ok(vec![healthy()])),
            ("opencode", corrupt),
            ("kimi", Ok(Vec::new())),
        ]);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].row.id, "ses_ok");
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].store, "opencode");
        assert!(!warnings[0].message.is_empty());
        let listing = SessionsListing { sessions: vec![records[0].row.clone()], warnings };
        let json: Value = serde_json::from_str(&serde_json::to_string(&listing).unwrap()).unwrap();
        assert_eq!(json["sessions"][0]["id"], "ses_ok");
        assert_eq!(json["warnings"][0]["store"], "opencode");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
