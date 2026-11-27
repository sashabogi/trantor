//! The browser's brain: per-project state, take-over gating, host rules, the driver line and the
//! agent ops. It talks to the page only through `Backend`, so it runs headless in tests.

use super::hosts::{Choice, Decision, FrameStore, HostRules};
use super::scripts;
use super::types::*;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

pub type Sink = Arc<dyn Fn(&str, BackendEvent) + Send + Sync>;

/// The webview layer. macOS implements it over WKWebView, other targets answer "not supported".
pub trait Backend: Send + Sync {
    fn set_sink(&self, sink: Sink);
    fn exists(&self, project: &str) -> bool;
    fn open(&self, project: &str, url: &str, rect: Rect, visible: bool) -> BrowserResult<()>;
    fn set_rect(&self, project: &str, rect: Rect) -> BrowserResult<()>;
    fn set_visible(&self, project: &str, visible: bool) -> BrowserResult<()>;
    fn navigate(&self, project: &str, url: &str) -> BrowserResult<()>;
    /// Runs a script and waits for its JSON result.
    fn eval(&self, project: &str, js: &str, timeout: Duration) -> BrowserResult<String>;
    /// Runs a script without waiting (back, forward and reload may unload the page first).
    fn run_script(&self, project: &str, js: &str) -> BrowserResult<()>;
    fn history(&self, project: &str) -> (bool, bool);
    fn snapshot(&self, project: &str, clip: Option<Rect>) -> BrowserResult<Vec<u8>>;
    fn pop_out(&self, project: &str, frame: Option<Rect>) -> BrowserResult<()>;
    /// Returns the popped-out window's frame so the core can remember it.
    fn put_back(&self, project: &str, rect: Rect) -> BrowserResult<Option<Rect>>;
    fn close(&self, project: &str) -> BrowserResult<Option<Rect>>;
}

/// Where state changes go (Tauri events in the app, a recorder in tests).
pub trait Emitter: Send + Sync {
    fn state(&self, state: &BrowserState);
    fn ask(&self, ask: &Ask);
    /// An agent opened a page: the Browser tab should come forward and report its rect.
    fn reveal(&self, project: &str);
}

struct Proj {
    state: BrowserState,
    rect: Rect,
    visible: bool,
    steps: Vec<Step>,
    driver_gen: u64,
}

impl Proj {
    fn new(project: &str) -> Self {
        Proj {
            state: BrowserState { project: project.to_string(), ..Default::default() },
            rect: Rect::DEFAULT,
            visible: false,
            steps: Vec::new(),
            driver_gen: 0,
        }
    }
}

const MAX_STEPS: usize = 200;

pub struct BrowserCore {
    backend: Arc<dyn Backend>,
    emitter: Arc<dyn Emitter>,
    hosts: Mutex<HostRules>,
    frames: Mutex<FrameStore>,
    projects: Mutex<HashMap<String, Proj>>,
    changed: Condvar,
    bus_dir: PathBuf,
    linger: Duration,
    load_timeout: Duration,
    eval_timeout: Duration,
    me: Weak<BrowserCore>,
}

pub struct CoreConfig {
    pub bus_dir: PathBuf,
    pub linger: Duration,
    pub load_timeout: Duration,
    pub eval_timeout: Duration,
}

impl CoreConfig {
    pub fn new(bus_dir: PathBuf) -> Self {
        CoreConfig {
            bus_dir,
            linger: Duration::from_secs(2),
            load_timeout: Duration::from_secs(15),
            eval_timeout: Duration::from_secs(10),
        }
    }
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    let auth = auth.rsplit('@').next().unwrap_or("");
    if auth.starts_with('[') {
        return auth.split(']').next().map(|h| format!("{h}]")).unwrap_or_default().to_ascii_lowercase();
    }
    auth.split(':').next().unwrap_or("").to_ascii_lowercase()
}

/// Accepts http(s) only; a bare host gets https (http for localhost).
pub fn normalize_url(raw: &str) -> BrowserResult<String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err(BrowserError::new("bad_request", "url is empty"));
    }
    if let Some((scheme, _)) = t.split_once("://") {
        return match scheme.to_ascii_lowercase().as_str() {
            "http" | "https" => Ok(t.to_string()),
            other => Err(BrowserError::new("bad_request", format!("the browser opens http and https pages, not {other}"))),
        };
    }
    if t.contains(':') && !t.split(':').nth(1).is_some_and(|p| p.chars().next().is_some_and(|c| c.is_ascii_digit())) {
        return Err(BrowserError::new("bad_request", "the browser opens http and https pages only"));
    }
    let scheme = if super::hosts::is_local(&host_of(t)) { "http" } else { "https" };
    Ok(format!("{scheme}://{t}"))
}

impl BrowserCore {
    pub fn new(backend: Arc<dyn Backend>, emitter: Arc<dyn Emitter>, hosts: HostRules, frames: FrameStore, cfg: CoreConfig) -> Arc<Self> {
        let core = Arc::new_cyclic(|me| BrowserCore {
            backend: backend.clone(),
            emitter,
            hosts: Mutex::new(hosts),
            frames: Mutex::new(frames),
            projects: Mutex::new(HashMap::new()),
            changed: Condvar::new(),
            bus_dir: cfg.bus_dir,
            linger: cfg.linger,
            load_timeout: cfg.load_timeout,
            eval_timeout: cfg.eval_timeout,
            me: me.clone(),
        });
        let weak = Arc::downgrade(&core);
        backend.set_sink(Arc::new(move |project, ev| {
            if let Some(core) = weak.upgrade() {
                core.apply_event(project, ev);
            }
        }));
        core
    }

    pub fn bus_dir(&self) -> &PathBuf {
        &self.bus_dir
    }

    /// Applies a change to one project, then wakes waiters and emits the new state.
    fn update<F: FnOnce(&mut Proj)>(&self, project: &str, f: F) -> BrowserState {
        let state = {
            let mut g = lock(&self.projects);
            let p = g.entry(project.to_string()).or_insert_with(|| Proj::new(project));
            f(p);
            p.state.clone()
        };
        self.changed.notify_all();
        self.emitter.state(&state);
        state
    }

    fn peek<T>(&self, project: &str, f: impl FnOnce(&Proj) -> T) -> Option<T> {
        lock(&self.projects).get(project).map(f)
    }

    pub fn state(&self, project: &str) -> BrowserState {
        self.peek(project, |p| p.state.clone()).unwrap_or_else(|| BrowserState { project: project.to_string(), ..Default::default() })
    }

    pub fn steps(&self, project: &str) -> Vec<Step> {
        self.peek(project, |p| p.steps.clone()).unwrap_or_default()
    }

    // ---- page events -------------------------------------------------------------------------

    pub fn apply_event(&self, project: &str, ev: BackendEvent) {
        match ev {
            BackendEvent::Navigated(url) => {
                self.update(project, |p| p.state.url = url);
            }
            BackendEvent::LoadStarted(url) => {
                self.update(project, |p| {
                    p.state.url = url;
                    p.state.loading = true;
                });
            }
            BackendEvent::LoadFinished(url) => {
                self.update(project, |p| {
                    p.state.url = url;
                    p.state.loading = false;
                });
                let (core, project) = (self.me.upgrade(), project.to_string());
                if let Some(core) = core {
                    std::thread::spawn(move || core.refresh_history(&project));
                }
            }
            BackendEvent::Title(title) => {
                self.update(project, |p| p.state.title = title);
            }
            BackendEvent::NewWindow(url) => {
                let (core, project) = (self.me.upgrade(), project.to_string());
                if let Some(core) = core {
                    std::thread::spawn(move || {
                        let _ = core.navigate(&project, &url);
                    });
                }
            }
            BackendEvent::PopoutClosed => {
                let (core, project) = (self.me.upgrade(), project.to_string());
                if let Some(core) = core {
                    std::thread::spawn(move || {
                        let rect = core.peek(&project, |p| p.rect).unwrap_or(Rect::DEFAULT);
                        let _ = core.put_back(&project, rect);
                    });
                }
            }
        }
    }

    pub fn refresh_history(&self, project: &str) {
        let (back, fwd) = self.backend.history(project);
        self.update(project, |p| {
            p.state.can_back = back;
            p.state.can_forward = fwd;
        });
    }

    // ---- commands ----------------------------------------------------------------------------

    pub fn open(&self, project: &str, url: Option<String>, rect: Rect) -> BrowserResult<BrowserState> {
        let rect = rect.sane();
        let url = url.as_deref().map(normalize_url).transpose()?;
        if self.backend.exists(project) {
            // a blank page stays hidden so the tab's "Nothing open" shows through
            let show = url.is_some() || !self.state(project).url.is_empty();
            self.backend.set_rect(project, rect)?;
            self.backend.set_visible(project, show)?;
            self.update(project, |p| {
                p.rect = rect;
                p.visible = show;
            });
            if let Some(url) = url {
                self.navigate(project, &url)?;
            }
        } else {
            let blank = url.is_none();
            let first = url.unwrap_or_else(|| "about:blank".to_string());
            self.update(project, |p| {
                p.rect = rect;
                p.visible = !blank;
                // "" is the contract's "no page"
                p.state.url = if blank { String::new() } else { first.clone() };
                p.state.loading = !blank;
            });
            if let Err(e) = self.backend.open(project, &first, rect, !blank) {
                self.update(project, |p| p.state.loading = false);
                return Err(e);
            }
        }
        Ok(self.state(project))
    }

    pub fn set_rect(&self, project: &str, rect: Rect) -> BrowserResult<()> {
        let rect = rect.sane();
        self.update_quiet(project, |p| p.rect = rect);
        if self.backend.exists(project) && !self.peek(project, |p| p.state.popped_out).unwrap_or(false) {
            self.backend.set_rect(project, rect)?;
        }
        Ok(())
    }

    pub fn set_visible(&self, project: &str, visible: bool) -> BrowserResult<()> {
        self.update_quiet(project, |p| p.visible = visible);
        if self.backend.exists(project) && !self.peek(project, |p| p.state.popped_out).unwrap_or(false) {
            self.backend.set_visible(project, visible)?;
        }
        Ok(())
    }

    /// Changes remembered layout without emitting a state event (rects change every frame).
    fn update_quiet<F: FnOnce(&mut Proj)>(&self, project: &str, f: F) {
        let mut g = lock(&self.projects);
        f(g.entry(project.to_string()).or_insert_with(|| Proj::new(project)));
    }

    pub fn navigate(&self, project: &str, url: &str) -> BrowserResult<()> {
        let url = normalize_url(url)?;
        self.require_page(project)?;
        self.update(project, |p| {
            p.state.loading = true;
            p.state.url = url.clone();
        });
        self.backend.navigate(project, &url)
    }

    pub fn back(&self, project: &str) -> BrowserResult<()> {
        self.require_page(project)?;
        self.backend.run_script(project, "history.back()")
    }

    pub fn forward(&self, project: &str) -> BrowserResult<()> {
        self.require_page(project)?;
        self.backend.run_script(project, "history.forward()")
    }

    pub fn reload(&self, project: &str) -> BrowserResult<()> {
        self.require_page(project)?;
        self.backend.run_script(project, "location.reload()")
    }

    pub fn pop_out(&self, project: &str) -> BrowserResult<()> {
        self.require_page(project)?;
        let frame = lock(&self.frames).get(project);
        self.backend.pop_out(project, frame)?;
        self.update(project, |p| p.state.popped_out = true);
        Ok(())
    }

    pub fn put_back(&self, project: &str, rect: Rect) -> BrowserResult<()> {
        let rect = rect.sane();
        if !self.peek(project, |p| p.state.popped_out).unwrap_or(false) {
            return Ok(());
        }
        let frame = self.backend.put_back(project, rect)?;
        if let Some(frame) = frame {
            lock(&self.frames).set(project, frame);
        }
        self.update(project, |p| {
            p.rect = rect;
            p.visible = true;
            p.state.popped_out = false;
        });
        Ok(())
    }

    pub fn close(&self, project: &str) -> BrowserResult<()> {
        lock(&self.hosts).end_visit(project);
        if self.backend.exists(project) {
            if let Some(frame) = self.backend.close(project)? {
                lock(&self.frames).set(project, frame);
            }
        }
        self.update(project, |p| {
            p.state = BrowserState { project: project.to_string(), held_by_user: p.state.held_by_user, ..Default::default() };
            p.visible = false;
        });
        Ok(())
    }

    pub fn take_over(&self, project: &str) {
        self.update(project, |p| {
            p.state.held_by_user = true;
            p.state.driver = None;
        });
    }

    pub fn give_back(&self, project: &str) {
        self.update(project, |p| p.state.held_by_user = false);
    }

    pub fn answer(&self, id: &str, choice: &str) -> Result<(), String> {
        let choice = Choice::parse(choice).ok_or_else(|| format!("choice must be once, site or deny, not {choice}"))?;
        lock(&self.hosts).answer(id, choice)?;
        self.changed.notify_all();
        Ok(())
    }

    #[cfg(test)]
    pub fn allowed_hosts(&self, project: &str) -> Vec<String> {
        lock(&self.hosts).allowed_for(project)
    }

    fn require_page(&self, project: &str) -> BrowserResult<()> {
        if self.backend.exists(project) {
            Ok(())
        } else {
            Err(BrowserError::new("not_found", "no page is open in this project's browser"))
        }
    }

    // ---- agent socket ------------------------------------------------------------------------

    /// One socket line in, one response line out.
    pub fn handle_line(self: &Arc<Self>, line: &str) -> String {
        let resp = match serde_json::from_str::<Value>(line) {
            Ok(v) if v.is_object() => self.handle_request(&v),
            Ok(_) => error_response(&Value::Null, &BrowserError::new("bad_request", "a request is a JSON object")),
            Err(e) => error_response(&Value::Null, &BrowserError::new("bad_request", format!("not JSON: {e}"))),
        };
        resp.to_string()
    }

    pub fn handle_request(self: &Arc<Self>, req: &Value) -> Value {
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        match self.run_op(req) {
            Ok(Value::Object(mut m)) => {
                m.insert("id".into(), id);
                m.insert("ok".into(), Value::Bool(true));
                Value::Object(m)
            }
            Ok(other) => json!({ "id": id, "ok": true, "result": other }),
            Err(e) => error_response(&id, &e),
        }
    }

    fn run_op(self: &Arc<Self>, req: &Value) -> BrowserResult<Value> {
        let s = |k: &str| req.get(k).and_then(Value::as_str).map(str::to_string);
        let project = s("project").filter(|p| !p.is_empty()).ok_or_else(|| BrowserError::new("bad_request", "project is required"))?;
        let op = s("op").ok_or_else(|| BrowserError::new("bad_request", "op is required"))?;
        let session = s("session").unwrap_or_else(|| "unknown".into());
        let label = s("label").unwrap_or_else(|| session.clone());

        if op == "state" {
            return to_value(&self.state(&project));
        }
        if self.state(&project).held_by_user {
            return Err(BrowserError::new("held_by_user", "the operator has taken over the browser; wait for it to be given back"));
        }
        let who = (session.as_str(), label.as_str());
        match op.as_str() {
            "open" => {
                let url = normalize_url(&s("url").ok_or_else(|| BrowserError::new("bad_request", "url is required"))?)?;
                let host = host_of(&url);
                self.gate(&project, who, &host)?;
                self.with_driver(&project, who, format!("opening {host}"), |me| me.op_open(&project, &url))
            }
            "read" => {
                self.require_page(&project)?;
                self.gate_current(&project, who)?;
                let max = req.get("max_chars").and_then(Value::as_u64).unwrap_or(20000) as usize;
                self.with_driver(&project, who, "reading the page".into(), |me| me.op_read(&project, max))
            }
            "click" => {
                self.require_page(&project)?;
                self.gate_current(&project, who)?;
                let target = target_of(req)?;
                let desc = describe(&target);
                self.with_driver(&project, who, format!("clicking {desc}"), |me| {
                    let r = me.run_script(&project, &scripts::click(&target))?;
                    me.name_step(&project, who, "clicking", &r);
                    Ok(json!({}))
                })
            }
            "type" => {
                self.require_page(&project)?;
                self.gate_current(&project, who)?;
                let mut target = target_of(req)?;
                let text = s("text").ok_or_else(|| BrowserError::new("bad_request", "text is required"))?;
                target["text"] = Value::String(text);
                target["submit"] = Value::Bool(req.get("submit").and_then(Value::as_bool).unwrap_or(false));
                let desc = describe(&target);
                self.with_driver(&project, who, format!("typing into {desc}"), |me| {
                    let r = me.run_script(&project, &scripts::type_text(&target))?;
                    me.name_step(&project, who, "typing into", &r);
                    Ok(json!({}))
                })
            }
            "scroll" => {
                self.require_page(&project)?;
                self.gate_current(&project, who)?;
                let dy = req.get("dy").and_then(Value::as_f64).ok_or_else(|| BrowserError::new("bad_request", "dy is required"))?;
                self.with_driver(&project, who, "scrolling".into(), |me| {
                    me.run_script(&project, &scripts::scroll(dy))?;
                    Ok(json!({}))
                })
            }
            "screenshot" => {
                self.require_page(&project)?;
                self.gate_current(&project, who)?;
                let element = s("element");
                self.with_driver(&project, who, "taking a screenshot".into(), |me| me.op_screenshot(&project, element))
            }
            other => Err(BrowserError::new("bad_request", format!("unknown op {other}"))),
        }
    }

    fn op_open(&self, project: &str, url: &str) -> BrowserResult<Value> {
        if self.backend.exists(project) {
            self.navigate(project, url)?;
        } else {
            let (rect, visible) = self.peek(project, |p| (p.rect, p.visible)).unwrap_or((Rect::DEFAULT, false));
            self.update(project, |p| {
                p.state.url = url.to_string();
                p.state.loading = true;
            });
            self.backend.open(project, url, rect, visible)?;
            if !visible {
                self.emitter.reveal(project);
            }
        }
        if !self.wait_loaded(project, self.load_timeout) {
            return Err(BrowserError::new("timeout", format!("{url} did not finish loading")));
        }
        let st = self.state(project);
        Ok(json!({ "url": st.url, "title": st.title }))
    }

    fn op_read(&self, project: &str, max: usize) -> BrowserResult<Value> {
        self.wait_loaded(project, Duration::from_secs(5));
        let v = self.run_script(project, &scripts::read(max))?;
        Ok(json!({
            "url": v["url"], "title": v["title"], "text": v["text"], "outline": v["outline"],
        }))
    }

    fn op_screenshot(&self, project: &str, element: Option<String>) -> BrowserResult<Value> {
        self.wait_loaded(project, Duration::from_secs(5));
        let clip = match element {
            Some(r) => {
                let v = self.run_script(project, &scripts::element_rect(&json!({ "ref": r })))?;
                serde_json::from_value::<Rect>(v["rect"].clone()).ok().map(Rect::sane)
            }
            None => None,
        };
        let png = self.backend.snapshot(project, clip)?;
        let dir = self.bus_dir.join("browser-shots");
        std::fs::create_dir_all(&dir).map_err(|e| BrowserError::new("timeout", format!("cannot write screenshots: {e}")))?;
        let safe: String = project.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
        let path = dir.join(format!("{}-{safe}.png", now_ms()));
        std::fs::write(&path, png).map_err(|e| BrowserError::new("timeout", format!("cannot write screenshot: {e}")))?;
        Ok(json!({ "path": path.to_string_lossy() }))
    }

    /// Runs a page script and maps its `{ok:false,error}` answers to errors.
    fn run_script(&self, project: &str, js: &str) -> BrowserResult<Value> {
        let raw = self.backend.eval(project, js, self.eval_timeout)?;
        let v = scripts::parse_result(&raw).ok_or_else(|| BrowserError::new("timeout", "the page returned no result"))?;
        if v["ok"].as_bool() == Some(false) {
            let code = if v["error"].as_str() == Some("not_found") { "not_found" } else { "timeout" };
            return Err(BrowserError::new(code, v["message"].as_str().unwrap_or("the page refused").to_string()));
        }
        Ok(v)
    }

    fn wait_loaded(&self, project: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut g = lock(&self.projects);
        loop {
            if !g.get(project).is_some_and(|p| p.state.loading) {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            g = self.changed.wait_timeout(g, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    // ---- hosts -------------------------------------------------------------------------------

    fn gate_current(&self, project: &str, who: (&str, &str)) -> BrowserResult<()> {
        let host = host_of(&self.state(project).url);
        self.gate(project, who, &host)
    }

    fn gate(&self, project: &str, (session, label): (&str, &str), host: &str) -> BrowserResult<()> {
        let decision = lock(&self.hosts).check(project, host, session, label, || format!("{:016x}", rand::random::<u64>()));
        match decision {
            Decision::Allow => Ok(()),
            Decision::Denied => Err(BrowserError::new("denied", format!("the operator did not allow {host}"))),
            Decision::Waiting => Err(BrowserError::new("waiting_for_approval", format!("waiting for the operator to answer for {host}"))),
            Decision::Ask(ask) => {
                self.emitter.ask(&ask);
                Err(BrowserError::new("waiting_for_approval", format!("asked the operator about {host}")))
            }
        }
    }

    // ---- driver line -------------------------------------------------------------------------

    /// Shows the agent as driver while `f` runs and for the linger after, and logs the step.
    fn with_driver<T>(self: &Arc<Self>, project: &str, (session, label): (&str, &str), action: String, f: impl FnOnce(&Arc<Self>) -> BrowserResult<T>) -> BrowserResult<T> {
        let token = {
            let mut g = lock(&self.projects);
            let p = g.entry(project.to_string()).or_insert_with(|| Proj::new(project));
            p.driver_gen += 1;
            p.driver_gen
        };
        self.update(project, |p| {
            p.state.driver = Some(Driver { session: session.into(), label: label.into(), action: action.clone(), since: now_ms() });
            p.driver_gen = token;
        });
        let result = f(self);
        let action = self.peek(project, |p| p.state.driver.as_ref().map(|d| d.action.clone())).flatten().unwrap_or(action);
        self.update(project, |p| {
            p.steps.push(Step { session: session.into(), label: label.into(), action, at: now_ms(), ok: result.is_ok() });
            let extra = p.steps.len().saturating_sub(MAX_STEPS);
            p.steps.drain(..extra);
        });
        let (me, project) = (self.clone(), project.to_string());
        std::thread::spawn(move || {
            std::thread::sleep(me.linger);
            let still_ours = me.peek(&project, |p| p.driver_gen == token).unwrap_or(false);
            if still_ours {
                me.update(&project, |p| p.state.driver = None);
            }
        });
        result
    }

    /// Rewrites the driver's action with the element's name once the page has said what it is.
    fn name_step(&self, project: &str, (session, _): (&str, &str), verb: &str, result: &Value) {
        let Some(name) = result["name"].as_str().filter(|n| !n.is_empty()) else { return };
        self.update(project, |p| {
            if let Some(d) = p.state.driver.as_mut().filter(|d| d.session == session) {
                d.action = format!("{verb} \"{name}\"");
            }
        });
    }
}

fn to_value<T: serde::Serialize>(v: &T) -> BrowserResult<Value> {
    serde_json::to_value(v).map_err(|e| BrowserError::new("timeout", e.to_string()))
}

fn error_response(id: &Value, e: &BrowserError) -> Value {
    json!({ "id": id, "ok": false, "error": e.code, "message": e.message })
}

/// `ref`, `selector`, or a point given as top-level `x`/`y` or as `point: {x, y}`.
fn target_of(req: &Value) -> BrowserResult<Value> {
    let mut t = Map::new();
    if let Some(r) = req.get("ref").and_then(Value::as_str) {
        t.insert("ref".into(), r.into());
    } else if let Some(sel) = req.get("selector").and_then(Value::as_str) {
        t.insert("selector".into(), sel.into());
    } else {
        let src = req.get("point").filter(|p| p.is_object()).unwrap_or(req);
        match (src.get("x").and_then(Value::as_f64), src.get("y").and_then(Value::as_f64)) {
            (Some(x), Some(y)) => {
                t.insert("x".into(), x.into());
                t.insert("y".into(), y.into());
            }
            _ => return Err(BrowserError::new("bad_request", "give a ref, a selector or x and y")),
        }
    }
    Ok(Value::Object(t))
}

fn describe(target: &Value) -> String {
    if let Some(r) = target["ref"].as_str() {
        r.to_string()
    } else if let Some(s) = target["selector"].as_str() {
        s.to_string()
    } else {
        format!("({}, {})", target["x"], target["y"])
    }
}

#[cfg(test)]
#[path = "core_tests.rs"]
mod tests;
