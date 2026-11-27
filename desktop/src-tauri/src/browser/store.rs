//! Small per-project JSON stores (prefs, history, favorites) under the app data dir.

use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub struct Store<T> {
    path: Option<PathBuf>,
    data: HashMap<String, T>,
}

impl<T: Serialize + DeserializeOwned + Clone + Default> Store<T> {
    pub fn in_memory() -> Self {
        Store { path: None, data: HashMap::new() }
    }

    /// A missing or unreadable file starts empty.
    pub fn load(path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Store { path: Some(path), data }
    }

    pub fn get(&self, project: &str) -> T {
        self.data.get(project).cloned().unwrap_or_default()
    }

    pub fn set(&mut self, project: &str, value: T) {
        self.data.insert(project.to_string(), value);
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string(&self.data) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_round_trip_through_disk_and_default_when_absent() {
        let dir = std::env::temp_dir().join(format!("trantor-store-{}", std::process::id()));
        let path = dir.join("s.json");
        let _ = std::fs::remove_dir_all(&dir);
        let mut s: Store<Vec<String>> = Store::load(path.clone());
        assert!(s.get("p").is_empty());
        s.set("p", vec!["a".into()]);
        assert_eq!(Store::<Vec<String>>::load(path).get("p"), vec!["a".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
