// The chat composer's draft (#11665), in ~/.agent-bus/config.json under "composerDrafts": keyed by
// project so each remembers its own words and attachment paths across a restart, the same shape
// project_lens.rs keeps for the lens. A separate map, never a row inside another one: each map's
// reader validates only its own values. An empty draft removes the row.
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

fn config_path() -> PathBuf {
    crate::desktop_bus_dir().join("config.json")
}

fn map_from(config: &Value) -> HashMap<String, Value> {
    config
        .get("composerDrafts")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn with_map(config: &Value, map: &HashMap<String, Value>) -> Result<Value, String> {
    let mut config = config.clone();
    let obj = config
        .as_object_mut()
        .ok_or_else(|| "config.json is not an object".to_string())?;
    obj.insert(
        "composerDrafts".into(),
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

pub fn get(project: String) -> Result<Option<Value>, String> {
    Ok(map_from(&read_config()).get(&project).cloned())
}

/// `draft` is the JSON the frontend stringified: an object to store, or null to forget.
pub fn set(project: String, draft: String) -> Result<(), String> {
    let value: Value = serde_json::from_str(&draft).map_err(|e| e.to_string())?;
    let config = read_config();
    let mut map = map_from(&config);
    if value.is_object() {
        map.insert(project, value);
    } else {
        map.remove(&project);
    }
    write_config(&with_map(&config, &map)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn with_map_preserves_other_keys_and_other_maps() {
        let mut map = HashMap::new();
        map.insert("p".into(), json!({ "text": "hi", "chips": [] }));
        let config = with_map(&json!({ "projectLens": { "p": "graph" } }), &map).unwrap();
        assert_eq!(map_from(&config), map);
        assert_eq!(config.get("projectLens"), Some(&json!({ "p": "graph" })));
    }

    #[test]
    fn with_map_refuses_a_non_object_config() {
        assert!(with_map(&json!([1]), &HashMap::new()).is_err());
    }

    /// The real path against actual disk in a temp bus dir: two projects keep separate drafts
    /// through a fresh read (a relaunch), and an empty draft forgets only its own row.
    #[test]
    fn the_real_path_drafts_survive_a_relaunch_and_clear_alone() {
        let _guard = crate::BUS_DIR_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prior = std::env::var("AGENT_BUS_DIR").ok();
        let base = std::env::temp_dir().join(format!("trantor-composerdraft-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        unsafe { std::env::set_var("AGENT_BUS_DIR", &base) };

        assert!(get("a".into()).unwrap().is_none());
        let a = json!({ "text": "for a", "chips": [{ "path": "/x/shot.png", "size": 10 }] });
        let b = json!({ "text": "for b", "chips": [] });
        set("a".into(), a.to_string()).unwrap();
        set("b".into(), b.to_string()).unwrap();
        assert_eq!(get("a".into()).unwrap().unwrap(), a);
        assert_eq!(get("b".into()).unwrap().unwrap(), b);

        set("a".into(), "null".into()).unwrap();
        assert!(get("a".into()).unwrap().is_none(), "an emptied draft is forgotten");
        assert_eq!(get("b".into()).unwrap().unwrap(), b, "the other project's draft stays");
        assert!(set("a".into(), "not json".into()).is_err());

        match prior {
            Some(v) => unsafe { std::env::set_var("AGENT_BUS_DIR", v) },
            None => unsafe { std::env::remove_var("AGENT_BUS_DIR") },
        }
        let _ = fs::remove_dir_all(&base);
    }
}
