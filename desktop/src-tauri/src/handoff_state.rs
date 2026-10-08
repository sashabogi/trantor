use serde::Serialize;
use std::{collections::HashMap, path::Path};

#[derive(Clone, Serialize)]
pub(crate) struct HandoffState {
    project: String,
    id: String,
    state: &'static str,
}

fn read_states(dir: &Path) -> Vec<HandoffState> {
    let mut latest: HashMap<String, (u64, HandoffState)> = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("recap-pending-") { continue; }
        let Some(stem) = name.strip_suffix(".json") else { continue };
        let Some((project, stamp)) = stem.rsplit_once('-') else { continue };
        let Ok(stamp) = stamp.parse::<u64>() else { continue };
        let Ok(body) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(record) = serde_json::from_str::<serde_json::Value>(&body) else { continue };
        let recapped = record["states"].as_array().is_some_and(|states| {
            states.iter().any(|s| s["state"].as_str() == Some("recapped"))
        });
        let claimed = record["claim"].is_object() || record["states"].as_array().is_some_and(|states| {
            states.iter().any(|s| s["state"].as_str() == Some("claimed"))
        });
        let state = if recapped {
            "RECAPPED"
        } else if claimed { "CLAIMED" } else { "WRITTEN" };
        let item = HandoffState { project: project.to_string(), id: stem.to_string(), state };
        if latest.get(project).is_none_or(|(prior, _)| stamp > *prior) {
            latest.insert(project.to_string(), (stamp, item));
        }
    }
    latest.into_values().map(|(_, item)| item).collect()
}

#[tauri::command]
pub(crate) fn handoff_states() -> Vec<HandoffState> {
    read_states(&crate::desktop_bus_dir().join("handoffs"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_survive_app_restart_and_latest_state_wins() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.agent-bus-out");
        let dir = root.join(format!("handoff-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("fixture directory");
        let file = dir.join("my-project-200.json");
        std::fs::write(dir.join("my-project-100.json"), r#"{"consumed":false}"#).expect("older record");
        std::fs::write(dir.join("recap-pending-123.json"), "{}").expect("stamp");
        for (body, expected) in [
            (r#"{"consumed":false,"states":[{"state":"written"}]}"#, "WRITTEN"),
            (r#"{"consumed":false,"claim":{"session_id":"successor","expiresAt":1}}"#, "CLAIMED"),
            (r#"{"consumed":true,"states":[{"state":"claimed"}]}"#, "CLAIMED"),
            (r#"{"consumed":true,"states":[{"state":"recapped"}]}"#, "RECAPPED"),
        ] {
            std::fs::write(&file, body).expect("handoff record");
            let states = read_states(&dir);
            assert_eq!(states.len(), 1);
            assert_eq!(states[0].project, "my-project");
            assert_eq!(states[0].id, "my-project-200");
            assert_eq!(states[0].state, expected);
        }
        std::fs::remove_dir_all(&dir).expect("fixture cleanup");
    }
}
