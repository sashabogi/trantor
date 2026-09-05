// Interrupted-session dismissals — persisted in ~/.agent-bus/config.json under
// "dismissedSessions", mirroring onboarding.rs's config.json convention.
//
// #6476: a dismissal used to live in React state only, so every launch rebuilt the Interrupted
// strip from crew-windows.txt and a dismissed dead session (tiny-timer, hive-digital) popped
// right back up. A dismissal is a decision, not a snooze — it must survive a restart. It is keyed
// on (project, sessionId) rather than project alone so a NEW dead session for the same project
// (a fresh orch pane handle) still shows: dismissing the old one must never hide the new one.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DismissedSession {
    pub project: String,
    pub session_id: String,
    pub ts: u64,
}

fn config_path() -> PathBuf {
    crate::desktop_bus_dir().join("config.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn list_from(config: &Value) -> Vec<DismissedSession> {
    config
        .get("dismissedSessions")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn with_list(config: &Value, list: &[DismissedSession]) -> Result<Value, String> {
    let mut config = config.clone();
    let obj = config
        .as_object_mut()
        .ok_or_else(|| "config.json is not an object".to_string())?;
    obj.insert(
        "dismissedSessions".into(),
        serde_json::to_value(list).map_err(|e| e.to_string())?,
    );
    Ok(config)
}

fn read_config() -> Value {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

fn write_config(v: &Value) -> Result<(), String> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

pub fn list() -> Result<Vec<DismissedSession>, String> {
    Ok(list_from(&read_config()))
}

/// Pure half of `dismiss`: upserts (project, sessionId) with a fresh timestamp rather than
/// accumulating duplicate rows for the same dead session across repeated clicks.
fn dismiss_into(list: &[DismissedSession], project: &str, session_id: &str) -> Vec<DismissedSession> {
    let mut out: Vec<DismissedSession> = list
        .iter()
        .filter(|d| !(d.project == project && d.session_id == session_id))
        .cloned()
        .collect();
    out.push(DismissedSession {
        project: project.to_string(),
        session_id: session_id.to_string(),
        ts: now_ms(),
    });
    out
}

pub fn dismiss(project: String, session_id: String) -> Result<Vec<DismissedSession>, String> {
    let config = read_config();
    let next = dismiss_into(&list_from(&config), &project, &session_id);
    write_config(&with_list(&config, &next)?)?;
    Ok(next)
}

/// Pure half of `clear_project`: a real Wake means the project has a live session again, so every
/// dismissal recorded for it — whichever dead session it was against — drops out.
fn clear_project_from(list: &[DismissedSession], project: &str) -> Vec<DismissedSession> {
    list.iter().filter(|d| d.project != project).cloned().collect()
}

pub fn clear_project(project: String) -> Result<Vec<DismissedSession>, String> {
    let config = read_config();
    let next = clear_project_from(&list_from(&config), &project);
    write_config(&with_list(&config, &next)?)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dismiss_into_upserts_by_project_and_session() {
        let first = dismiss_into(&[], "tiny-timer", "wM:p1");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].project, "tiny-timer");
        assert_eq!(first[0].session_id, "wM:p1");

        // Dismissing the SAME (project, sessionId) again replaces the row, not duplicates it.
        let again = dismiss_into(&first, "tiny-timer", "wM:p1");
        assert_eq!(again.len(), 1);

        // A DIFFERENT session for the same project is a separate row.
        let two = dismiss_into(&again, "tiny-timer", "wM:p2");
        assert_eq!(two.len(), 2);
    }

    #[test]
    fn clear_project_from_drops_every_row_for_that_project_only() {
        let list = vec![
            DismissedSession { project: "tiny-timer".into(), session_id: "wM:p1".into(), ts: 1 },
            DismissedSession { project: "hive-digital".into(), session_id: "wN:p1".into(), ts: 2 },
        ];
        let cleared = clear_project_from(&list, "tiny-timer");
        assert_eq!(cleared, vec![DismissedSession { project: "hive-digital".into(), session_id: "wN:p1".into(), ts: 2 }]);
    }

    #[test]
    fn with_list_round_trips_and_preserves_other_keys() {
        let list = vec![DismissedSession { project: "p".into(), session_id: "s".into(), ts: 42 }];
        let config = with_list(&json!({ "hubs": {} }), &list).unwrap();
        assert_eq!(list_from(&config), list);
        assert_eq!(config.get("hubs"), Some(&json!({})));
    }

    #[test]
    fn with_list_refuses_a_non_object_config() {
        assert!(with_list(&json!([1, 2]), &[]).is_err());
    }

    /// The real path end to end, against actual disk: dismiss two sessions, read the list back
    /// with a FRESH read (simulating the app relaunching and re-parsing config.json from
    /// scratch) — both stay dismissed. Clearing one project's dismissal removes only that row. A
    /// new session id for the same project is a separate row the clear never touched.
    #[test]
    fn the_real_path_two_dismissed_sessions_survive_a_simulated_relaunch() {
        let base = std::env::temp_dir().join(format!("trantor-dismissals-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // SAFETY: this is the crate's only test touching AGENT_BUS_DIR for dismissals (grepped
        // alongside onboarding.rs's equivalent test before adding it) — no other test in this
        // module observes or races this process-wide mutation.
        unsafe { std::env::set_var("AGENT_BUS_DIR", &base) };

        assert!(list().unwrap().is_empty(), "a fresh install has nothing dismissed");

        dismiss("tiny-timer".into(), "wM:p1".into()).unwrap();
        dismiss("hive-digital".into(), "wN:p1".into()).unwrap();

        // Relaunch = re-reading config.json from a clean call, not carrying any in-memory state.
        let after_relaunch = list().unwrap();
        assert_eq!(after_relaunch.len(), 2, "both dismissals must survive a simulated relaunch");
        assert!(after_relaunch.iter().any(|d| d.project == "tiny-timer" && d.session_id == "wM:p1"));
        assert!(after_relaunch.iter().any(|d| d.project == "hive-digital" && d.session_id == "wN:p1"));

        // A real Wake on tiny-timer clears its dismissal — hive-digital's is untouched.
        let after_wake = clear_project("tiny-timer".into()).unwrap();
        assert_eq!(after_wake, vec![DismissedSession { project: "hive-digital".into(), session_id: "wN:p1".into(), ts: after_wake[0].ts }]);

        // A NEW dead session for tiny-timer (a fresh pane handle) is a different row — dismissing
        // the old one never hides it.
        dismiss("tiny-timer".into(), "wM:p9".into()).unwrap();
        let final_list = list().unwrap();
        assert!(final_list.iter().any(|d| d.project == "tiny-timer" && d.session_id == "wM:p9"));
        assert!(!final_list.iter().any(|d| d.project == "tiny-timer" && d.session_id == "wM:p1"), "the cleared session must not reappear");

        unsafe { std::env::remove_var("AGENT_BUS_DIR") };
        let _ = fs::remove_dir_all(&base);
    }
}
