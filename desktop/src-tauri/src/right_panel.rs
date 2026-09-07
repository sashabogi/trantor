// The right mode pane's tab + dock state — persisted in ~/.agent-bus/config.json under
// "rightPanel", mirroring dismissals.rs's and onboarding.rs's config.json convention.
//
// #6499: the panel always opened on Files after a restart because nothing remembered where you
// left it, so a question already waiting in Chat could sit unseen. Keyed by project — each
// project remembers its own tab, the way `seat`/file selections already work per project.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RightPanelState {
    pub tab: String,
    pub dock: String,
}

fn config_path() -> PathBuf {
    crate::desktop_bus_dir().join("config.json")
}

fn map_from(config: &Value) -> HashMap<String, RightPanelState> {
    config
        .get("rightPanel")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn with_map(config: &Value, map: &HashMap<String, RightPanelState>) -> Result<Value, String> {
    let mut config = config.clone();
    let obj = config
        .as_object_mut()
        .ok_or_else(|| "config.json is not an object".to_string())?;
    obj.insert(
        "rightPanel".into(),
        serde_json::to_value(map).map_err(|e| e.to_string())?,
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

pub fn get(project: String) -> Result<Option<RightPanelState>, String> {
    Ok(map_from(&read_config()).get(&project).cloned())
}

pub fn set(project: String, tab: String, dock: String) -> Result<RightPanelState, String> {
    let config = read_config();
    let mut map = map_from(&config);
    let state = RightPanelState { tab, dock };
    map.insert(project, state.clone());
    write_config(&with_map(&config, &map)?)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn set_upserts_a_single_project_row() {
        let config = json!({});
        let mut map = map_from(&config);
        map.insert(
            "trantor".into(),
            RightPanelState { tab: "files".into(), dock: "pane".into() },
        );
        let config = with_map(&config, &map).unwrap();
        map.insert(
            "trantor".into(),
            RightPanelState { tab: "chat".into(), dock: "pane".into() },
        );
        let config = with_map(&config, &map).unwrap();
        let after = map_from(&config);
        assert_eq!(after.len(), 1, "the same project's row is replaced, not duplicated");
        assert_eq!(after.get("trantor").unwrap().tab, "chat");
    }

    #[test]
    fn with_map_round_trips_and_preserves_other_keys() {
        let mut map = HashMap::new();
        map.insert("p".into(), RightPanelState { tab: "git".into(), dock: "pane".into() });
        let config = with_map(&json!({ "hubs": {} }), &map).unwrap();
        assert_eq!(map_from(&config), map);
        assert_eq!(config.get("hubs"), Some(&json!({})));
    }

    #[test]
    fn with_map_refuses_a_non_object_config() {
        assert!(with_map(&json!([1, 2]), &HashMap::new()).is_err());
    }

    /// The real path end to end, against actual disk: two projects each save a different tab,
    /// read back with a FRESH read (simulating the app relaunching and re-parsing config.json
    /// from scratch) — each keeps its own tab, and setting one project's tab never touches the
    /// other's.
    #[test]
    fn the_real_path_two_projects_survive_a_simulated_relaunch() {
        // Held for the WHOLE body: right_panel, onboarding and dismissals each repoint
        // AGENT_BUS_DIR for their own real-path test, and set_var/remove_var on the shared
        // process environ block is not safe to run concurrently across them (crate::BUS_DIR_TEST_LOCK).
        let _guard = crate::BUS_DIR_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prior = std::env::var("AGENT_BUS_DIR").ok();
        let base = std::env::temp_dir().join(format!("trantor-rightpanel-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        unsafe { std::env::set_var("AGENT_BUS_DIR", &base) };

        assert!(get("trantor".into()).unwrap().is_none(), "a fresh install has nothing stored");

        set("trantor".into(), "chat".into(), "pane".into()).unwrap();
        set("crebral-health".into(), "git".into(), "pane".into()).unwrap();

        // Relaunch = re-reading config.json from a clean call, not carrying any in-memory state.
        let trantor_after = get("trantor".into()).unwrap().unwrap();
        assert_eq!(trantor_after.tab, "chat");
        let other_after = get("crebral-health".into()).unwrap().unwrap();
        assert_eq!(other_after.tab, "git");

        // Updating one project's tab never disturbs the other's.
        set("trantor".into(), "files".into(), "pane".into()).unwrap();
        assert_eq!(get("trantor".into()).unwrap().unwrap().tab, "files");
        assert_eq!(get("crebral-health".into()).unwrap().unwrap().tab, "git");

        match prior {
            Some(v) => unsafe { std::env::set_var("AGENT_BUS_DIR", v) },
            None => unsafe { std::env::remove_var("AGENT_BUS_DIR") },
        }
        let _ = fs::remove_dir_all(&base);
    }
}
