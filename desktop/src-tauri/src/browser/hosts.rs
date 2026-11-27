//! Which hosts an agent may drive, per project. Localhost never asks.

use super::types::{Ask, Rect};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;

pub fn is_local(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost") || h == "127.0.0.1" || h == "[::1]" || h == "::1"
}

pub fn norm(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    Allow,
    Denied,
    /// A fresh ask was opened; the caller emits it.
    Ask(Ask),
    /// An ask for this host is already open.
    Waiting,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Choice {
    Once,
    Site,
    Deny,
}

impl Choice {
    pub fn parse(s: &str) -> Option<Choice> {
        match s {
            "once" => Some(Choice::Once),
            "site" => Some(Choice::Site),
            "deny" => Some(Choice::Deny),
            _ => None,
        }
    }
}

#[derive(Default)]
pub struct HostRules {
    path: Option<PathBuf>,
    allowed: HashMap<String, BTreeSet<String>>,
    once: HashSet<(String, String)>,
    denied: HashSet<(String, String)>,
    eval_once: HashSet<(String, String)>,
    eval_denied: HashSet<(String, String)>,
    pending: Vec<Ask>,
}

impl HostRules {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::default()
    }

    /// Loads the persisted allow list; a missing or unreadable file starts empty.
    pub fn load(path: PathBuf) -> Self {
        let allowed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<HashMap<String, BTreeSet<String>>>(&t).ok())
            .unwrap_or_default();
        HostRules { path: Some(path), allowed, ..Self::default() }
    }

    pub fn allowed_for(&self, project: &str) -> Vec<String> {
        self.allowed.get(project).map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn check(&mut self, project: &str, host: &str, session: &str, label: &str, new_id: impl FnOnce() -> String) -> Decision {
        let host = norm(host);
        let key = (project.to_string(), host.clone());
        // a script grant is for the visit: any drive on another host ends it
        self.eval_once.retain(|(p, h)| p != project || *h == host);
        if host.is_empty() || is_local(&host) || self.allowed.get(project).is_some_and(|s| s.contains(&host)) {
            return Decision::Allow;
        }
        // "once" is one visit: it holds while the agent stays on this host and ends when it moves.
        self.once.retain(|(p, h)| p != project || *h == host);
        if self.once.contains(&key) {
            return Decision::Allow;
        }
        if self.denied.remove(&key) {
            return Decision::Denied;
        }
        if self.pending.iter().any(|a| a.project == project && a.host == host && a.kind.is_none()) {
            return Decision::Waiting;
        }
        let ask = Ask { project: project.into(), id: new_id(), session: session.into(), label: label.into(), host, kind: None };
        self.pending.push(ask.clone());
        Decision::Ask(ask)
    }

    /// Running a script always asks once per host (a granted `site` does not cover it), and the
    /// grant lasts for the visit like `once`. Localhost never asks.
    pub fn check_eval(&mut self, project: &str, host: &str, session: &str, label: &str, new_id: impl FnOnce() -> String) -> Decision {
        let host = norm(host);
        let key = (project.to_string(), host.clone());
        if host.is_empty() || is_local(&host) {
            return Decision::Allow;
        }
        self.eval_once.retain(|(p, h)| p != project || *h == host);
        if self.eval_once.contains(&key) {
            return Decision::Allow;
        }
        if self.eval_denied.remove(&key) {
            return Decision::Denied;
        }
        if self.pending.iter().any(|a| a.project == project && a.host == host && a.kind.is_some()) {
            return Decision::Waiting;
        }
        let ask = Ask { project: project.into(), id: new_id(), session: session.into(), label: label.into(), host, kind: Some("evaluate".into()) };
        self.pending.push(ask.clone());
        Decision::Ask(ask)
    }

    /// Resolves an open ask. `once` lasts for the visit, `deny` answers the next op on that host.
    pub fn answer(&mut self, id: &str, choice: Choice) -> Result<Ask, String> {
        let pos = self.pending.iter().position(|a| a.id == id).ok_or_else(|| format!("no open ask {id}"))?;
        let ask = self.pending.remove(pos);
        let key = (ask.project.clone(), ask.host.clone());
        if ask.kind.is_some() {
            // an evaluate grant is never persisted: once and site both cover this visit
            match choice {
                Choice::Deny => self.eval_denied.insert(key),
                _ => self.eval_once.insert(key),
            };
            return Ok(ask);
        }
        match choice {
            Choice::Once => {
                self.once.insert(key);
            }
            Choice::Deny => {
                self.denied.insert(key);
            }
            Choice::Site => {
                self.allowed.entry(ask.project.clone()).or_default().insert(ask.host.clone());
                self.save();
            }
        }
        Ok(ask)
    }

    /// Ends every "once" grant for a project (its browser closed).
    pub fn end_visit(&mut self, project: &str) {
        self.once.retain(|(p, _)| p != project);
        self.eval_once.retain(|(p, _)| p != project);
    }

    pub fn revoke(&mut self, project: &str, host: &str) {
        if let Some(set) = self.allowed.get_mut(project) {
            set.remove(&norm(host));
        }
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&self.allowed) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

/// Remembered popped-out window frame per project.
pub struct FrameStore {
    path: Option<PathBuf>,
    frames: HashMap<String, Rect>,
}

impl FrameStore {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        FrameStore { path: None, frames: HashMap::new() }
    }

    pub fn load(path: PathBuf) -> Self {
        let frames = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        FrameStore { path: Some(path), frames }
    }

    pub fn get(&self, project: &str) -> Option<Rect> {
        self.frames.get(project).copied()
    }

    pub fn set(&mut self, project: &str, frame: Rect) {
        self.frames.insert(project.to_string(), frame);
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&self.frames) {
            let _ = std::fs::write(path, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> String {
        "a1".to_string()
    }

    #[test]
    fn localhost_never_asks() {
        let mut r = HostRules::in_memory();
        for h in ["localhost", "127.0.0.1", "[::1]", "app.localhost", "LOCALHOST."] {
            assert_eq!(r.check("p", h, "s", "l", id), Decision::Allow, "{h}");
        }
        assert!(!is_local("localhost.evil.com"));
        assert!(matches!(r.check("p", "localhost.evil.com", "s", "l", id), Decision::Ask(_)));
    }

    #[test]
    fn once_lasts_for_the_visit_and_ends_when_the_agent_moves_on() {
        let mut r = HostRules::in_memory();
        let Decision::Ask(ask) = r.check("p", "Example.com", "s", "codex", id) else { panic!("should ask") };
        assert_eq!(ask.host, "example.com");
        assert_eq!(r.check("p", "example.com", "s", "l", id), Decision::Waiting);
        r.answer(&ask.id, Choice::Once).expect("answer");
        for _ in 0..3 {
            assert_eq!(r.check("p", "example.com", "s", "l", id), Decision::Allow);
        }
        // Another host ends the visit; coming back asks again.
        assert!(matches!(r.check("p", "other.test", "s", "l", || "a2".into()), Decision::Ask(_)));
        assert!(matches!(r.check("p", "example.com", "s", "l", || "a4".into()), Decision::Ask(_)));
        let Decision::Ask(ask) = r.check("q", "example.com", "s", "l", || "a5".into()) else { panic!("per project") };
        r.answer(&ask.id, Choice::Once).expect("answer");
        r.end_visit("q");
        assert!(matches!(r.check("q", "example.com", "s", "l", || "a6".into()), Decision::Ask(_)));
    }

    #[test]
    fn site_is_per_project_and_persists() {
        let dir = std::env::temp_dir().join(format!("trantor-hosts-{}", std::process::id()));
        let path = dir.join("hosts.json");
        let _ = std::fs::remove_dir_all(&dir);
        let mut r = HostRules::load(path.clone());
        let Decision::Ask(ask) = r.check("p", "example.com", "s", "l", id) else { panic!("should ask") };
        r.answer(&ask.id, Choice::Site).expect("answer");
        assert_eq!(r.check("p", "example.com", "s", "l", id), Decision::Allow);
        assert!(matches!(r.check("other", "example.com", "s", "l", id), Decision::Ask(_)));
        let mut again = HostRules::load(path);
        assert_eq!(again.allowed_for("p"), vec!["example.com".to_string()]);
        assert_eq!(again.check("p", "example.com", "s", "l", id), Decision::Allow);
        again.revoke("p", "example.com");
        assert!(matches!(again.check("p", "example.com", "s", "l", id), Decision::Ask(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deny_answers_the_next_op_then_asks_again() {
        let mut r = HostRules::in_memory();
        let Decision::Ask(ask) = r.check("p", "bank.example", "s", "l", id) else { panic!("should ask") };
        r.answer(&ask.id, Choice::Deny).expect("answer");
        assert_eq!(r.check("p", "bank.example", "s", "l", id), Decision::Denied);
        assert!(matches!(r.check("p", "bank.example", "s", "l", || "a3".into()), Decision::Ask(_)));
    }

    #[test]
    fn answering_an_unknown_ask_is_an_error() {
        assert!(HostRules::in_memory().answer("nope", Choice::Once).is_err());
        assert_eq!(Choice::parse("site"), Some(Choice::Site));
        assert_eq!(Choice::parse("always"), None);
    }

    #[test]
    fn frames_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("trantor-frames-{}", std::process::id()));
        let path = dir.join("frames.json");
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = FrameStore::load(path.clone());
        assert_eq!(s.get("p"), None);
        s.set("p", Rect { x: 10.0, y: 20.0, w: 800.0, h: 600.0 });
        assert_eq!(FrameStore::load(path).get("p"), Some(Rect { x: 10.0, y: 20.0, w: 800.0, h: 600.0 }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
