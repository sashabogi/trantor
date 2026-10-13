// The chat model picker is per project (#11657). Claude Code persists `/model <v>` to the USER file
// ~/.claude/settings.json, so one pick used to change the model of every project's next session.
// A pick now (1) snapshots the user file's "model", (2) lands in <checkout>/.claude/settings.local.json
// where Claude Code reads it for that project only, and (3) after the /model has gone to the pane,
// puts the user file's "model" back to what it was if Claude Code rewrote it.
//
// Every function takes the home and checkout it works on, so tests run against temp dirs and never
// near the real ~/.claude.
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long after a pick the user file is watched for Claude Code's rewrite. The pane handles the
/// slash command within a second or two; the window is generous because a late write that is not
/// undone is exactly the bug.
pub const RESTORE_WINDOW: Duration = Duration::from_secs(8);
const POLL_EVERY: Duration = Duration::from_millis(250);

fn global_file(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}

fn local_file(checkout: &Path) -> PathBuf {
    checkout.join(".claude").join("settings.local.json")
}

/// The file as an object. A missing or unreadable file is an empty object; a file that exists but
/// is not an object is an error, so a write never replaces something we do not understand.
fn read_object(path: &Path) -> Result<Map<String, Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(format!("{} is not a JSON object", path.display())),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn write_object(path: &Path, obj: &Map<String, Value>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(obj.clone())).map_err(|e| e.to_string())?;
    // Write beside and rename, so Claude Code never reads a half-written settings file.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, format!("{text}\n")).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn model_of(obj: &Map<String, Value>) -> Option<String> {
    obj.get("model").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The model a project's next session starts on: the project's local setting over the user file's.
/// The second field names where it came from ("local" / "global"), None when neither sets one.
pub fn effective(home: &Path, checkout: Option<&Path>) -> (Option<String>, Option<&'static str>) {
    if let Some(m) = checkout.and_then(|c| read_object(&local_file(c)).ok()).as_ref().and_then(model_of) {
        return (Some(m), Some("local"));
    }
    match read_object(&global_file(home)).ok().as_ref().and_then(model_of) {
        Some(m) => (Some(m), Some("global")),
        None => (None, None),
    }
}

/// The user file's "model" key exactly as it stood (None = the key was absent).
pub fn snapshot_global(home: &Path) -> Option<Value> {
    read_object(&global_file(home)).ok().and_then(|o| o.get("model").cloned())
}

/// Put the user file's "model" back to `before` if it differs now. Returns whether it rewrote.
/// Every other key is carried through untouched; an unreadable file is left alone.
pub fn restore_global(home: &Path, before: &Option<Value>) -> bool {
    let path = global_file(home);
    let Ok(mut obj) = read_object(&path) else { return false };
    if obj.get("model") == before.as_ref() {
        return false;
    }
    match before {
        Some(v) => { obj.insert("model".into(), v.clone()); }
        None => { obj.remove("model"); }
    }
    write_object(&path, &obj).is_ok()
}

/// Write the pick into the project's local settings: `Some(v)` sets {"model": v}, `None` (the
/// "default" pick) removes the key. Every other key in the file is kept.
pub fn write_local(checkout: &Path, model: Option<&str>) -> Result<(), String> {
    let path = local_file(checkout);
    let mut obj = read_object(&path)?;
    match model {
        Some(v) => { obj.insert("model".into(), Value::String(v.to_string())); }
        None => {
            if obj.remove("model").is_none() {
                return Ok(());
            }
        }
    }
    write_object(&path, &obj)
}

/// "default" is the picker's way of saying "no override": it removes the local key.
pub fn pick_value(picked: &str) -> Option<&str> {
    let v = picked.trim();
    if v.is_empty() || v == "default" { None } else { Some(v) }
}

/// The user-file value to restore to, shared by overlapping picks: a second pick inside the first
/// one's window would otherwise snapshot the model Claude Code had just rewritten and "restore" to
/// it. While a window is open the baseline from before the first pick stands.
pub struct Baseline {
    before: Option<Value>,
    until: Instant,
}
pub type BaselineSlot = Mutex<Option<Baseline>>;
pub static BASELINE: BaselineSlot = Mutex::new(None);

pub fn claim_baseline(slot: &BaselineSlot, home: &Path, now: Instant, window: Duration) -> Option<Value> {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    let before = match guard.as_ref() {
        Some(b) if b.until > now => b.before.clone(),
        _ => snapshot_global(home),
    };
    *guard = Some(Baseline { before: before.clone(), until: now + window });
    before
}

/// Watch the user file until `deadline` and put "model" back whenever Claude Code has rewritten it.
/// Blocking: the command runs it on its own thread. Returns how many times it had to restore.
pub fn settle(home: &Path, before: &Option<Value>, deadline: Instant, every: Duration) -> usize {
    let mut restored = 0;
    loop {
        if restore_global(home, before) {
            restored += 1;
        }
        if Instant::now() >= deadline {
            return restored;
        }
        std::thread::sleep(every);
    }
}

/// The whole pick, minus the pane send: claim the baseline, write the project's local setting, and
/// start the watcher. The caller sends `/model <v>` after this returns, so the snapshot always
/// precedes Claude Code's rewrite. A missing checkout skips the local write but still protects the
/// user file.
pub fn begin_pick(home: PathBuf, checkout: Option<PathBuf>, picked: &str) -> Result<(), String> {
    let before = claim_baseline(&BASELINE, &home, Instant::now(), RESTORE_WINDOW);
    if let Some(dir) = checkout.as_deref() {
        write_local(dir, pick_value(picked))?;
    }
    let deadline = Instant::now() + RESTORE_WINDOW;
    std::thread::spawn(move || { settle(&home, &before, deadline, POLL_EVERY); });
    Ok(())
}

pub fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A throwaway HOME and checkout; nothing here is ever the real ~/.claude.
    struct Sandbox {
        root: PathBuf,
    }
    impl Sandbox {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("trantor-projectmodel-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(root.join("home/.claude")).unwrap();
            fs::create_dir_all(root.join("checkout")).unwrap();
            Sandbox { root }
        }
        fn home(&self) -> PathBuf { self.root.join("home") }
        fn checkout(&self) -> PathBuf { self.root.join("checkout") }
        fn put_global(&self, v: Value) {
            fs::write(global_file(&self.home()), v.to_string()).unwrap();
        }
        fn global(&self) -> Value {
            serde_json::from_str(&fs::read_to_string(global_file(&self.home())).unwrap()).unwrap()
        }
        fn local(&self) -> Option<Value> {
            fs::read_to_string(local_file(&self.checkout())).ok().map(|s| serde_json::from_str(&s).unwrap())
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
    }

    #[test]
    fn a_pick_writes_the_local_file_and_leaves_the_user_file_untouched() {
        let sb = Sandbox::new("local");
        let global = json!({ "model": "sonnet", "theme": "dark" });
        sb.put_global(global.clone());
        fs::create_dir_all(sb.checkout().join(".claude")).unwrap();
        fs::write(local_file(&sb.checkout()), r#"{"permissions":{"allow":["Bash(ls)"]}}"#).unwrap();

        write_local(&sb.checkout(), pick_value("opus")).unwrap();

        assert_eq!(sb.local().unwrap(), json!({ "model": "opus", "permissions": { "allow": ["Bash(ls)"] } }), "other keys kept");
        assert_eq!(sb.global(), global, "writing the local file never touches the user file");
    }

    #[test]
    fn the_user_file_is_restored_after_claude_code_rewrites_it() {
        let sb = Sandbox::new("restore");
        sb.put_global(json!({ "model": "sonnet", "theme": "dark" }));
        let before = claim_baseline(&Mutex::new(None), &sb.home(), Instant::now(), RESTORE_WINDOW);
        assert_eq!(before, Some(json!("sonnet")));

        // Claude Code handles /model opus and persists it to the user file, adding its own key too.
        sb.put_global(json!({ "model": "opus", "theme": "dark", "other": 1 }));
        let restored = settle(&sb.home(), &before, Instant::now() + Duration::from_millis(60), Duration::from_millis(10));

        assert!(restored >= 1);
        assert_eq!(sb.global(), json!({ "model": "sonnet", "theme": "dark", "other": 1 }), "only model goes back");
    }

    #[test]
    fn a_late_rewrite_inside_the_window_is_still_undone() {
        let sb = Sandbox::new("late");
        sb.put_global(json!({ "model": "sonnet" }));
        let before = snapshot_global(&sb.home());
        let home = sb.home();
        let writer = std::thread::spawn({
            let home = home.clone();
            move || {
                std::thread::sleep(Duration::from_millis(40));
                fs::write(global_file(&home), json!({ "model": "fable" }).to_string()).unwrap();
            }
        });
        settle(&home, &before, Instant::now() + Duration::from_millis(300), Duration::from_millis(10));
        writer.join().unwrap();
        assert_eq!(sb.global(), json!({ "model": "sonnet" }));
    }

    #[test]
    fn an_absent_user_model_is_removed_again() {
        let sb = Sandbox::new("absent");
        sb.put_global(json!({ "theme": "dark" }));
        let before = snapshot_global(&sb.home());
        assert_eq!(before, None);
        sb.put_global(json!({ "theme": "dark", "model": "opus" }));
        assert!(restore_global(&sb.home(), &before));
        assert_eq!(sb.global(), json!({ "theme": "dark" }));
        assert!(!restore_global(&sb.home(), &before), "nothing to undo the second time");
    }

    #[test]
    fn an_overlapping_pick_keeps_the_baseline_from_before_the_first() {
        let sb = Sandbox::new("overlap");
        sb.put_global(json!({ "model": "sonnet" }));
        let slot = Mutex::new(None);
        let t0 = Instant::now();
        assert_eq!(claim_baseline(&slot, &sb.home(), t0, Duration::from_secs(8)), Some(json!("sonnet")));
        sb.put_global(json!({ "model": "opus" })); // the first pick's rewrite
        assert_eq!(claim_baseline(&slot, &sb.home(), t0 + Duration::from_secs(2), Duration::from_secs(8)), Some(json!("sonnet")));
        // Once the window has lapsed the next pick snapshots afresh.
        assert_eq!(claim_baseline(&slot, &sb.home(), t0 + Duration::from_secs(60), Duration::from_secs(8)), Some(json!("opus")));
    }

    #[test]
    fn the_effective_model_is_local_over_global() {
        let sb = Sandbox::new("effective");
        assert_eq!(effective(&sb.home(), Some(&sb.checkout())), (None, None));
        sb.put_global(json!({ "model": "sonnet" }));
        assert_eq!(effective(&sb.home(), Some(&sb.checkout())), (Some("sonnet".into()), Some("global")));
        write_local(&sb.checkout(), Some("opus")).unwrap();
        assert_eq!(effective(&sb.home(), Some(&sb.checkout())), (Some("opus".into()), Some("local")));
        // Another project's checkout, with no local file, still reads the global value.
        let other = sb.root.join("other");
        fs::create_dir_all(&other).unwrap();
        assert_eq!(effective(&sb.home(), Some(&other)), (Some("sonnet".into()), Some("global")));
        assert_eq!(effective(&sb.home(), None), (Some("sonnet".into()), Some("global")));
    }

    #[test]
    fn default_removes_the_local_key_and_keeps_the_rest() {
        let sb = Sandbox::new("default");
        sb.put_global(json!({ "model": "sonnet" }));
        fs::create_dir_all(sb.checkout().join(".claude")).unwrap();
        fs::write(local_file(&sb.checkout()), r#"{"model":"opus","env":{"A":"1"}}"#).unwrap();

        write_local(&sb.checkout(), pick_value("default")).unwrap();

        assert_eq!(sb.local().unwrap(), json!({ "env": { "A": "1" } }));
        assert_eq!(effective(&sb.home(), Some(&sb.checkout())), (Some("sonnet".into()), Some("global")));
        // "default" with no local file creates nothing.
        let fresh = sb.root.join("fresh");
        write_local(&fresh, None).unwrap();
        assert!(!local_file(&fresh).exists());
    }

    #[test]
    fn a_settings_file_that_is_not_an_object_is_never_overwritten() {
        let sb = Sandbox::new("notobject");
        fs::create_dir_all(sb.checkout().join(".claude")).unwrap();
        fs::write(local_file(&sb.checkout()), "[1,2]").unwrap();
        assert!(write_local(&sb.checkout(), Some("opus")).is_err());
        assert_eq!(fs::read_to_string(local_file(&sb.checkout())).unwrap(), "[1,2]");
    }
}
