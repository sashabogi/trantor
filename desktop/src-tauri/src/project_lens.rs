// The project lens the app reopens on (#11597), in ~/.agent-bus/config.json under "projectLens":
// keyed by project so each remembers its own lens, the same shape right_panel.rs keeps for the
// mode pane's tab. A separate map, never a row inside "rightPanel": rightPanelState's validation
// would drop an unknown tab and silently break that pane's own restore.
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

fn config_path() -> PathBuf {
    crate::desktop_bus_dir().join("config.json")
}

fn map_from(config: &Value) -> HashMap<String, String> {
    config
        .get("projectLens")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn with_map(config: &Value, map: &HashMap<String, String>) -> Result<Value, String> {
    let mut config = config.clone();
    let obj = config
        .as_object_mut()
        .ok_or_else(|| "config.json is not an object".to_string())?;
    obj.insert(
        "projectLens".into(),
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

pub fn get(project: String) -> Result<Option<String>, String> {
    Ok(map_from(&read_config()).get(&project).cloned())
}

pub fn set(project: String, lens: String) -> Result<String, String> {
    let config = read_config();
    let mut map = map_from(&config);
    map.insert(project, lens.clone());
    write_config(&with_map(&config, &map)?)?;
    Ok(lens)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn set_upserts_a_single_project_row() {
        let config = json!({});
        let mut map = map_from(&config);
        map.insert("trantor".into(), "graph".into());
        let config = with_map(&config, &map).unwrap();
        map.insert("trantor".into(), "board".into());
        let config = with_map(&config, &map).unwrap();
        let after = map_from(&config);
        assert_eq!(after.len(), 1, "the same project's row is replaced, not duplicated");
        assert_eq!(after.get("trantor").unwrap(), "board");
    }

    #[test]
    fn with_map_round_trips_and_preserves_other_keys() {
        let mut map = HashMap::new();
        map.insert("p".into(), "graph".into());
        let config = with_map(&json!({ "hubs": {} }), &map).unwrap();
        assert_eq!(map_from(&config), map);
        assert_eq!(config.get("hubs"), Some(&json!({})));
        assert_eq!(config.get("rightPanel"), None, "right_panel's rows stay untouched");
    }

    #[test]
    fn with_map_refuses_a_non_object_config() {
        assert!(with_map(&json!([1, 2]), &HashMap::new()).is_err());
    }

    /// The real path end to end, against actual disk: two projects each save a different lens,
    /// read back with a FRESH read (simulating the app relaunching and re-parsing config.json
    /// from scratch) — each keeps its own lens, and one project's write never touches the
    /// other's. Holds BUS_DIR_TEST_LOCK like right_panel's real-path test (shared AGENT_BUS_DIR).
    #[test]
    fn the_real_path_two_projects_survive_a_simulated_relaunch() {
        let _guard = crate::BUS_DIR_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prior = std::env::var("AGENT_BUS_DIR").ok();
        let base = std::env::temp_dir().join(format!("trantor-projectlens-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        unsafe { std::env::set_var("AGENT_BUS_DIR", &base) };

        assert!(get("trantor".into()).unwrap().is_none(), "a fresh install has nothing stored");

        set("trantor".into(), "graph".into()).unwrap();
        set("crebral-health".into(), "code".into()).unwrap();

        // Relaunch = re-reading config.json from a clean call, not carrying any in-memory state.
        assert_eq!(get("trantor".into()).unwrap().unwrap(), "graph");
        assert_eq!(get("crebral-health".into()).unwrap().unwrap(), "code");

        // Updating one project's lens never disturbs the other's.
        set("trantor".into(), "feed".into()).unwrap();
        assert_eq!(get("trantor".into()).unwrap().unwrap(), "feed");
        assert_eq!(get("crebral-health".into()).unwrap().unwrap(), "code");

        match prior {
            Some(v) => unsafe { std::env::set_var("AGENT_BUS_DIR", v) },
            None => unsafe { std::env::remove_var("AGENT_BUS_DIR") },
        }
        let _ = fs::remove_dir_all(&base);
    }
}
