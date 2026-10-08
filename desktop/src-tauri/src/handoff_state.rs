use serde::Serialize;
use std::{collections::HashMap, path::Path, sync::Mutex};

#[derive(Clone, Serialize)]
pub(crate) struct HandoffState {
    project: String,
    id: String,
    state: &'static str,
    reason: Option<String>,
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
        let state = record["states"].as_array()
            .and_then(|states| states.iter().rev().find_map(|s| match s["state"].as_str()? {
                "armed" => Some("ARMED"), "writing" => Some("WRITING"),
                "written" => Some("WRITTEN"), "ended" => Some("ENDED"),
                "opened" => Some("OPENED"), "claimed" => Some("CLAIMED"),
                "recapped" => Some("RECAPPED"), "failed" => Some("FAILED"), _ => None,
            })).unwrap_or("WRITTEN");
        let state = if record["claim"].is_object() && !matches!(state, "RECAPPED" | "FAILED") {
            "CLAIMED"
        } else { state };
        let reason = record["states"].as_array().and_then(|states| states.last())
            .and_then(|s| s["reason"].as_str()).or(record["reason"].as_str()).map(str::to_string);
        let item = HandoffState { project: project.to_string(), id: stem.to_string(), state, reason };
        if latest.get(project).is_none_or(|(prior, _)| stamp > *prior) {
            latest.insert(project.to_string(), (stamp, item));
        }
    }
    latest.into_values().map(|(_, item)| item).collect()
}

struct ChainState { snapshot: HandoffState, previous_id: Option<String> }
static CHAINS: Mutex<Vec<ChainState>> = Mutex::new(Vec::new());

pub(crate) fn chain_stage(project: &str, state: &'static str, reason: Option<String>) {
    let mut chains = crate::lock_or_recover(&CHAINS);
    if let Some(chain) = chains.iter_mut().find(|c| c.snapshot.project == project) {
        chain.snapshot.state = state;
        chain.snapshot.reason = reason;
    }
}

pub(crate) fn chain_begin(project: &str) {
    let previous_id = read_states(&crate::desktop_bus_dir().join("handoffs"))
        .into_iter().find(|s| s.project == project).map(|s| s.id);
    let mut chains = crate::lock_or_recover(&CHAINS);
    chains.retain(|c| c.snapshot.project != project);
    chains.push(ChainState { previous_id, snapshot: HandoffState {
        project: project.to_string(), id: format!("{project}-live"), state: "WRITING", reason: None,
    }});
}

#[tauri::command]
pub(crate) fn handoff_states() -> Vec<HandoffState> {
    let records = read_states(&crate::desktop_bus_dir().join("handoffs"));
    let mut chains = crate::lock_or_recover(&CHAINS);
    chains.retain(|chain| !records.iter().any(|record| record.project == chain.snapshot.project
        && Some(&record.id) != chain.previous_id.as_ref() && record.state == "RECAPPED"));
    merge_states(records, &chains)
}

fn merge_states(mut records: Vec<HandoffState>, chains: &[ChainState]) -> Vec<HandoffState> {
    for chain in chains {
        let record = records.iter().find(|s| s.project == chain.snapshot.project);
        let successor = record.is_some_and(|s| Some(&s.id) != chain.previous_id.as_ref()
            && matches!(s.state, "CLAIMED" | "RECAPPED" | "FAILED"));
        if successor && chain.snapshot.state != "FAILED" { continue; }
        records.retain(|s| s.project != chain.snapshot.project);
        records.push(chain.snapshot.clone());
    }
    records
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
            (r#"{"states":[{"state":"armed"}]}"#, "ARMED"),
            (r#"{"states":[{"state":"armed"},{"state":"writing"}]}"#, "WRITING"),
            (r#"{"consumed":false,"states":[{"state":"written"}]}"#, "WRITTEN"),
            (r#"{"states":[{"state":"written"},{"state":"ended"}]}"#, "ENDED"),
            (r#"{"states":[{"state":"ended"},{"state":"opened"}]}"#, "OPENED"),
            (r#"{"states":[{"state":"opened"},{"state":"failed","reason":"open refused"}]}"#, "FAILED"),
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
            if expected == "FAILED" { assert_eq!(states[0].reason.as_deref(), Some("open refused")); }
        }
        std::fs::remove_dir_all(&dir).expect("fixture cleanup");
    }

    #[test]
    fn live_chain_ignores_prior_recap_and_yields_to_its_successor_record() {
        let fixture = |id: &str, state| HandoffState {
            project: "p".into(), id: id.into(), state, reason: None,
        };
        let mut chain = ChainState { previous_id: Some("p-1".into()), snapshot: fixture("p-live", "ARMED") };
        let prior = merge_states(vec![fixture("p-1", "RECAPPED")], std::slice::from_ref(&chain));
        assert_eq!(prior[0].state, "ARMED");
        for state in ["WRITING", "WRITTEN", "ENDED", "OPENED"] {
            chain.snapshot.state = state;
            let live = merge_states(vec![fixture("p-2", "WRITTEN")], std::slice::from_ref(&chain));
            assert_eq!(live.len(), 1);
            assert_eq!(live[0].state, state);
        }
        for state in ["CLAIMED", "RECAPPED"] {
            let successor = merge_states(vec![fixture("p-2", state)], std::slice::from_ref(&chain));
            assert_eq!(successor[0].state, state);
        }
        chain.snapshot.state = "FAILED";
        chain.snapshot.reason = Some("kickoff refused".into());
        let failure = merge_states(vec![fixture("p-2", "CLAIMED")], &[chain]);
        assert_eq!(failure[0].state, "FAILED");
        assert_eq!(failure[0].reason.as_deref(), Some("kickoff refused"));
    }

}
