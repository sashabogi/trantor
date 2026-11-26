// Per-machine checkout locations share the existing ~/.agent-bus/config.json preferences.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Read}, path::{Path, PathBuf}, sync::Mutex};

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    projects_root: Option<PathBuf>,
    #[serde(default)]
    project_folders: HashMap<String, PathBuf>,
}

#[derive(Serialize)]
pub(crate) struct ResolvedRoot {
    pub path: PathBuf,
    source: &'static str,
}

// Keyed by config path so independent bus directories never share a preference. Reads take only
// this lock; successful writes replace the cached value before returning to the webview.
static CACHE: Mutex<Option<(PathBuf, Preferences)>> = Mutex::new(None);

fn config_path() -> PathBuf { crate::desktop_bus_dir().join("config.json") }
fn home() -> PathBuf { PathBuf::from(std::env::var_os("HOME").unwrap_or_default()) }

fn read_config(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

fn preferences(path: &Path) -> Preferences {
    let mut cache = crate::lock_or_recover(&CACHE);
    if let Some((key, prefs)) = cache.as_ref() {
        if key == path { return prefs.clone(); }
    }
    let prefs = read_config(path).ok().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    *cache = Some((path.to_owned(), prefs));
    cache.as_ref().map(|(_, p)| p.clone()).unwrap_or_default()
}

fn resolve_root(env: Option<PathBuf>, saved: Option<PathBuf>, home: &Path) -> ResolvedRoot {
    if let Some(path) = env { return ResolvedRoot { path, source: "TRANTOR_DEV_ROOT" }; }
    if let Some(path) = saved.filter(|p| p.is_absolute()) { return ResolvedRoot { path, source: "setting" }; }
    ResolvedRoot { path: home.join("development"), source: "default" }
}

pub(crate) fn resolved_root() -> ResolvedRoot {
    resolve_root(std::env::var_os("TRANTOR_DEV_ROOT").map(PathBuf::from), preferences(&config_path()).projects_root, &home())
}

fn validate_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_dir() { return Err("Choose an existing folder with an absolute path".into()); }
    Ok(())
}

fn valid_project(project: &str) -> bool {
    !project.is_empty() && project.len() <= 80 && !project.contains("..")
        && project.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn save(path: &Path, project: Option<&str>, directory: Option<PathBuf>) -> Result<(), String> {
    if let Some(dir) = directory.as_ref() { validate_directory(dir)?; }
    if project.is_some_and(|id| !valid_project(id)) { return Err("Invalid project id".into()); }
    let mut cache = crate::lock_or_recover(&CACHE);
    let mut config = read_config(path)?;
    let object = config.as_object_mut().ok_or("config.json is not an object")?;
    if let Some(project) = project {
        let folders = object.entry("projectFolders").or_insert_with(|| json!({}));
        let folders = folders.as_object_mut().ok_or("projectFolders is not an object")?;
        if let Some(dir) = directory { folders.insert(project.into(), json!(dir)); }
        else { folders.remove(project); }
    } else if let Some(dir) = directory { object.insert("projectsRoot".into(), json!(dir)); }
    else { object.remove("projectsRoot"); }
    let prefs = serde_json::from_value(config.clone()).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let temp = path.with_extension("projects.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())?;
    *cache = Some((path.to_owned(), prefs));
    Ok(())
}

#[tauri::command]
pub(crate) fn projects_root_get() -> ResolvedRoot { resolved_root() }

#[tauri::command]
pub(crate) fn projects_root_set(path: Option<PathBuf>) -> Result<ResolvedRoot, String> {
    save(&config_path(), None, path)?;
    Ok(resolved_root())
}

#[tauri::command]
pub(crate) fn project_folder_set(project: String, path: PathBuf) -> Result<(), String> {
    save(&config_path(), Some(&project), Some(path))
}

pub(crate) fn project_dir(project: &str) -> Option<PathBuf> {
    let prefs = preferences(&config_path());
    let root = resolve_root(std::env::var_os("TRANTOR_DEV_ROOT").map(PathBuf::from), prefs.projects_root.clone(), &home());
    find_project(&root.path, &prefs.project_folders, &home(), project)
}

fn find_project(root: &Path, overrides: &HashMap<String, PathBuf>, home: &Path, project: &str) -> Option<PathBuf> {
    if !valid_project(project) { return None; }
    crate::identity::checkout_for(root, project)
        .or_else(|| overrides.get(project).filter(|p| p.is_absolute() && p.is_dir()).cloned())
        .or_else(|| claude_checkout(home, project))
}

fn claude_checkout(home: &Path, project: &str) -> Option<PathBuf> {
    // Slugs are lossy (a dash might be a separator or part of a filename). Only transcript cwds
    // are authoritative. Bound directory entries, total transcripts, bytes and lines read.
    let mut remaining = 256usize;
    for dir in fs::read_dir(home.join(".claude/projects")).ok()?.take(200).flatten() {
        if !dir.file_type().is_ok_and(|t| t.is_dir()) { continue; }
        let Ok(files) = fs::read_dir(dir.path()) else { continue };
        for file in files.take(32).flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            if !file.file_type().is_ok_and(|t| t.is_file()) { continue; }
            if remaining == 0 { return None; }
            remaining -= 1;
            let Ok(file) = fs::File::open(path) else { continue };
            for line in BufReader::new(file.take(64 * 1024)).lines().take(20).map_while(Result::ok) {
                let Ok(record) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(cwd) = record.get("cwd").and_then(Value::as_str).map(PathBuf::from) else { continue };
                if !cwd.is_absolute() || !cwd.is_dir() { continue; }
                let matches = match crate::identity::project_id_of(&cwd) {
                    Some(id) => id == project,
                    None => cwd.file_name().and_then(|s| s.to_str()) == Some(project),
                };
                if matches { return Some(cwd); }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("projects-folder-{}-{}", std::process::id(), rand::random::<u64>()));
            fs::create_dir_all(&path).unwrap(); Self(path)
        }
        fn dir(&self, name: &str) -> PathBuf { let p = self.0.join(name); fs::create_dir_all(&p).unwrap(); p }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn resolution_order_env_setting_default() {
        let t = Temp::new(); let env = t.dir("env"); let saved = t.dir("code");
        let r = resolve_root(Some(env.clone()), Some(saved.clone()), &t.0);
        assert_eq!(r.path, env); assert_eq!(r.source, "TRANTOR_DEV_ROOT");
        let r = resolve_root(None, Some(saved.clone()), &t.0);
        assert_eq!(r.path, saved); assert_eq!(r.source, "setting");
        let r = resolve_root(None, None, &t.0);
        assert_eq!(r.path, t.0.join("development")); assert_eq!(r.source, "default");
    }

    #[test]
    fn saves_root_and_override_preserving_config_and_refreshing_cache() {
        let t = Temp::new(); let config = t.0.join("config.json");
        fs::write(&config, r#"{"url":"http://hub","projectLens":{"demo":"code"}}"#).unwrap();
        assert!(preferences(&config).projects_root.is_none());
        let root = t.dir("code"); let odd = t.dir("elsewhere/renamed");
        save(&config, None, Some(root.clone())).unwrap();
        save(&config, Some("demo"), Some(odd.clone())).unwrap();
        let prefs = preferences(&config);
        assert_eq!(prefs.projects_root, Some(root.clone()));
        assert_eq!(find_project(&root, &prefs.project_folders, &t.0, "demo"), Some(odd));
        let direct = t.dir("code/demo");
        assert_eq!(find_project(&root, &prefs.project_folders, &t.0, "demo"), Some(direct));
        save(&config, None, None).unwrap();
        assert!(preferences(&config).projects_root.is_none());
        let reread = read_config(&config).unwrap();
        assert_eq!(reread["url"], "http://hub"); assert_eq!(reread["projectLens"]["demo"], "code");
        assert_eq!(reread["projectFolders"]["demo"], json!(t.0.join("elsewhere/renamed")));
    }

    #[test]
    fn rejects_files_missing_and_relative_paths_without_writing() {
        let t = Temp::new(); let config = t.0.join("config.json"); let file = t.0.join("file");
        fs::write(&file, "not a directory").unwrap();
        for path in [file, t.0.join("missing"), PathBuf::from("relative")] {
            assert!(save(&config, None, Some(path.clone())).is_err());
            assert!(save(&config, Some("demo"), Some(path)).is_err());
        }
        assert!(!config.exists());
    }

    #[test]
    fn claude_records_use_cwd_basename_or_marker_not_lossy_slug() {
        let t = Temp::new(); let root = t.dir("empty-root");
        let records = t.dir(".claude/projects/-a-lossy-slug"); let cwd = t.dir("outside/my-app");
        let transcript = records.join("session.jsonl");
        fs::write(&transcript, format!("not json\n{{\"type\":\"summary\"}}\n{}\n", json!({"cwd":cwd}))).unwrap();
        assert_eq!(find_project(&root, &HashMap::new(), &t.0, "my-app"), Some(cwd.clone()));
        fs::create_dir_all(cwd.join(".trantor")).unwrap();
        fs::write(cwd.join(".trantor/project.json"), r#"{"id":"canonical"}"#).unwrap();
        assert_eq!(find_project(&root, &HashMap::new(), &t.0, "canonical"), Some(cwd));
        assert_eq!(find_project(&root, &HashMap::new(), &t.0, "my-app"), None);
        assert_eq!(find_project(&root, &HashMap::new(), &t.0, "../escape"), None);
        fs::write(transcript, format!("{}{}\n", "{}\n".repeat(20), json!({"cwd": t.0.join("outside/my-app")}))).unwrap();
        assert_eq!(find_project(&root, &HashMap::new(), &t.0, "canonical"), None);
    }
}
