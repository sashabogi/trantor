//! The browser's brain: per-project pages and state, take-over gating, host rules, the driver line
//! and the agent ops. It talks to the pages only through `Backend`, so it runs headless in tests.

use super::device::{self, Device};
use super::hosts::{Choice, Decision, FrameStore, HostRules};
use super::scripts;
use super::store::Store;
use super::types::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

/// Events carry the project and the page they came from ("" for the project's pop-out window).
pub type Sink = Arc<dyn Fn(&str, &str, BackendEvent) + Send + Sync>;

/// How a page is created: the frame is already the letterboxed one, `ua` the full string.
pub struct PageSpec {
    pub rect: Rect,
    pub visible: bool,
    pub ua: String,
    pub popup: bool,
    pub zoom: f64,
}

/// The webview layer. macOS implements it over WKWebView, other targets answer "not supported".
pub trait Backend: Send + Sync {
    fn set_sink(&self, sink: Sink);
    fn open_page(&self, project: &str, page: &str, url: &str, spec: PageSpec) -> BrowserResult<()>;
    fn set_rect(&self, project: &str, page: &str, rect: Rect) -> BrowserResult<()>;
    fn set_visible(&self, project: &str, page: &str, visible: bool) -> BrowserResult<()>;
    fn navigate(&self, project: &str, page: &str, url: &str) -> BrowserResult<()>;
    /// Runs a script and waits for its JSON result.
    fn eval(&self, project: &str, page: &str, js: &str, timeout: Duration) -> BrowserResult<String>;
    /// Runs a script without waiting (back, forward and reload may unload the page first).
    fn run_script(&self, project: &str, page: &str, js: &str) -> BrowserResult<()>;
    fn history(&self, project: &str, page: &str) -> (bool, bool);
    fn snapshot(&self, project: &str, page: &str, clip: Option<Rect>) -> BrowserResult<Vec<u8>>;
    /// Moves every page of the project into its own window.
    fn pop_out(&self, project: &str, frame: Option<Rect>) -> BrowserResult<()>;
    /// Returns the popped-out window's frame so the core can remember it.
    fn put_back(&self, project: &str, rect: Rect) -> BrowserResult<Option<Rect>>;
    /// Closes one page; the frame comes back when it was the last page and a pop-out window went with it.
    fn close_page(&self, project: &str, page: &str) -> BrowserResult<Option<Rect>>;
    fn close(&self, project: &str) -> BrowserResult<Option<Rect>>;
    fn set_zoom(&self, project: &str, page: &str, zoom: f64) -> BrowserResult<()>;
    fn find(&self, project: &str, page: &str, text: &str, backwards: bool) -> BrowserResult<bool>;
    fn find_clear(&self, project: &str, page: &str) -> BrowserResult<()>;
    fn inspect(&self, project: &str, page: &str) -> BrowserResult<()>;
    fn set_user_agent(&self, project: &str, page: &str, ua: &str) -> BrowserResult<()>;
    /// Removes cookies, storage and cache of the project's data store.
    fn clear_storage(&self, project: &str) -> BrowserResult<()>;
}

/// Where state changes go (Tauri events in the app, a recorder in tests).
pub trait Emitter: Send + Sync {
    fn state(&self, state: &BrowserState);
    fn ask(&self, ask: &Ask);
    /// An agent opened a page: the Browser tab should come forward and report its rect.
    fn reveal(&self, project: &str);
}

/// Settings that persist per project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub zoom: f64,
    pub user_agent: String,
    pub emulation: Option<Device>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { zoom: 1.0, user_agent: device::DEFAULT_UA.to_string(), emulation: None }
    }
}

/// The pages of one project that survive a relaunch (popups are left out).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SavedPages {
    pub pages: Vec<SavedPage>,
    pub active: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedPage {
    pub url: String,
    pub title: String,
}

#[derive(Clone)]
struct PageRec {
    st: PageState,
    /// Saved from a past run: listed in the state but no webview yet.
    restored: bool,
    can_back: bool,
    can_forward: bool,
    popup: bool,
    shown: bool,
    /// Set when a navigation was issued; a "not loading" sample inside the settle window is stale.
    awaiting: Option<Instant>,
    /// The url whose document reported ready while WebKit still said loading (a page that
    /// streams media never clears isLoading); loading samples for it are ignored.
    settled_url: Option<String>,
    driver_gen: u64,
    applied_rect: Option<Rect>,
    applied_zoom: f64,
    applied_ua: String,
}

struct Proj {
    state: BrowserState,
    pages: Vec<PageRec>,
    active: String,
    prefs: Prefs,
    rect: Rect,
    visible: bool,
    steps: Vec<Step>,
    next_page: u32,
}

impl Proj {
    fn new(project: &str, prefs: Prefs, saved: SavedPages) -> Self {
        let mut p = Proj {
            state: BrowserState { project: project.to_string(), ..Default::default() },
            pages: Vec::new(),
            active: String::new(),
            prefs,
            rect: Rect::DEFAULT,
            visible: false,
            steps: Vec::new(),
            next_page: 0,
        };
        for s in saved.pages.iter().filter(|s| real_url(&s.url)) {
            p.next_page += 1;
            let mut rec = PageRec::blank(&format!("pg{}", p.next_page));
            rec.restored = true;
            rec.st.url = s.url.clone();
            rec.st.title = s.title.clone();
            rec.st.restored = true;
            p.pages.push(rec);
        }
        p.active = p.pages.get(saved.active).or(p.pages.first()).map(|r| r.st.id.clone()).unwrap_or_default();
        p.sync();
        p
    }

    /// What survives a relaunch: real, non-popup pages and the active one's place among them.
    fn saved(&self, prior_active: usize) -> SavedPages {
        let keep: Vec<&PageRec> = self.pages.iter().filter(|r| !r.popup && real_url(&r.st.url)).collect();
        let active = keep.iter().position(|r| r.st.id == self.active).unwrap_or(prior_active.min(keep.len().saturating_sub(1)));
        SavedPages { pages: keep.iter().map(|r| SavedPage { url: r.st.url.clone(), title: r.st.title.clone() }).collect(), active }
    }

    /// Rebuilds the published state: the page list, and the top-level fields from the active page.
    fn sync(&mut self) {
        self.state.pages = self.pages.iter().map(|p| p.st.clone()).collect();
        self.state.active_page = self.active.clone();
        let blank = PageRec::blank("");
        let a = self.pages.iter().find(|p| p.st.id == self.active).unwrap_or(&blank);
        self.state.url = a.st.url.clone();
        self.state.title = a.st.title.clone();
        self.state.loading = a.st.loading;
        self.state.driver = a.st.driver.clone();
        self.state.can_back = a.can_back;
        self.state.can_forward = a.can_forward;
        self.state.zoom = self.prefs.zoom;
        self.state.user_agent = self.prefs.user_agent.clone();
        self.state.emulation = self.prefs.emulation.clone();
    }

    fn page(&self, id: &str) -> Option<&PageRec> {
        self.pages.iter().find(|p| p.st.id == id)
    }

    fn page_mut(&mut self, id: &str) -> Option<&mut PageRec> {
        self.pages.iter_mut().find(|p| p.st.id == id)
    }

    /// The frame every page takes and the page zoom that goes with it. A pop-out window fills
    /// itself, so it gets neither the letterbox nor its scale.
    fn geometry(&self) -> (Rect, f64) {
        match (&self.prefs.emulation, self.state.popped_out) {
            (Some(d), false) => {
                let lb = device::letterbox(self.rect, d);
                (lb.frame, self.prefs.zoom * lb.scale)
            }
            _ => (self.rect, self.prefs.zoom),
        }
    }

    fn effective_ua(&self) -> &'static str {
        let chosen = device::ua_preset(&self.prefs.user_agent).unwrap_or(device::DEFAULT_UA);
        device::ua_preset(device::effective_ua(chosen, self.prefs.emulation.as_ref())).unwrap_or(device::DEFAULT_UA)
    }

    /// Whether a page should be on screen now.
    fn wants_shown(&self, rec: &PageRec) -> bool {
        rec.st.id == self.active && !rec.restored && !rec.st.url.is_empty() && (self.visible || self.state.popped_out)
    }
}

impl PageRec {
    fn blank(id: &str) -> Self {
        PageRec {
            st: PageState { id: id.to_string(), ..Default::default() },
            restored: false,
            can_back: false,
            can_forward: false,
            popup: false,
            shown: false,
            awaiting: None,
            settled_url: None,
            driver_gen: 0,
            applied_rect: None,
            applied_zoom: 1.0,
            applied_ua: String::new(),
        }
    }
}

const MAX_STEPS: usize = 200;
const MAX_HISTORY: usize = 500;

pub struct BrowserCore {
    backend: Arc<dyn Backend>,
    emitter: Arc<dyn Emitter>,
    hosts: Mutex<HostRules>,
    frames: Mutex<FrameStore>,
    prefs: Mutex<Store<Prefs>>,
    saved: Mutex<Store<SavedPages>>,
    history: Mutex<Store<Vec<HistoryEntry>>>,
    favorites: Mutex<Store<Vec<Favorite>>>,
    projects: Mutex<HashMap<String, Proj>>,
    changed: Condvar,
    bus_dir: PathBuf,
    linger: Duration,
    load_timeout: Duration,
    eval_timeout: Duration,
    settle: Duration,
    me: Weak<BrowserCore>,
}

pub struct CoreConfig {
    pub bus_dir: PathBuf,
    /// Where prefs, history and favorites persist; `None` keeps them in memory.
    pub data_dir: Option<PathBuf>,
    pub linger: Duration,
    pub load_timeout: Duration,
    pub eval_timeout: Duration,
    /// After a navigation is issued, a sample saying "not loading" is stale for this long.
    pub settle: Duration,
}

impl CoreConfig {
    pub fn new(bus_dir: PathBuf) -> Self {
        CoreConfig {
            bus_dir,
            data_dir: None,
            linger: Duration::from_secs(2),
            load_timeout: Duration::from_secs(15),
            eval_timeout: Duration::from_secs(10),
            settle: Duration::from_millis(1500),
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

fn real_url(u: &str) -> bool {
    !u.is_empty() && u != "about:blank"
}

/// Folds one webview sample into a page. Returns (changed, a load just finished, the url moved
/// without a load running).
fn observe(rec: &mut PageRec, ev: &BackendEvent, settle: Duration, now: Instant) -> (bool, bool, bool) {
    let BackendEvent::Observed { url, title, loading, can_back, can_forward } = ev else { return (false, false, false) };
    let (mut changed, mut finished, mut moved) = (false, false, false);
    if let Some(u) = url.as_ref().filter(|u| real_url(u) && **u != rec.st.url) {
        rec.st.url = u.clone();
        rec.settled_url = None;
        changed = true;
        moved = !rec.st.loading;
    }
    if let Some(t) = title.as_ref().filter(|t| **t != rec.st.title) {
        rec.st.title = t.clone();
        changed = true;
    }
    if let Some(b) = can_back.filter(|b| *b != rec.can_back) {
        rec.can_back = b;
        changed = true;
    }
    if let Some(f) = can_forward.filter(|f| *f != rec.can_forward) {
        rec.can_forward = f;
        changed = true;
    }
    if *loading && rec.settled_url.as_deref() == Some(rec.st.url.as_str()) {
        // the document already said ready; WebKit's flag stays up for streaming pages
    } else if *loading {
        rec.awaiting = None;
        if !rec.st.loading {
            rec.st.loading = true;
            changed = true;
        }
    } else if rec.st.loading && rec.awaiting.is_none_or(|t| now.duration_since(t) >= settle) {
        rec.st.loading = false;
        rec.awaiting = None;
        changed = true;
        finished = true;
    }
    (changed, finished, moved)
}

impl BrowserCore {
    pub fn new(backend: Arc<dyn Backend>, emitter: Arc<dyn Emitter>, hosts: HostRules, frames: FrameStore, cfg: CoreConfig) -> Arc<Self> {
        let (prefs, history, favorites, saved) = match &cfg.data_dir {
            Some(d) => (Store::load(d.join("prefs.json")), Store::load(d.join("history.json")), Store::load(d.join("favorites.json")), Store::load(d.join("pages.json"))),
            None => (Store::in_memory(), Store::in_memory(), Store::in_memory(), Store::in_memory()),
        };
        let core = Arc::new_cyclic(|me| BrowserCore {
            backend: backend.clone(),
            emitter,
            hosts: Mutex::new(hosts),
            frames: Mutex::new(frames),
            prefs: Mutex::new(prefs),
            saved: Mutex::new(saved),
            history: Mutex::new(history),
            favorites: Mutex::new(favorites),
            projects: Mutex::new(HashMap::new()),
            changed: Condvar::new(),
            bus_dir: cfg.bus_dir,
            linger: cfg.linger,
            load_timeout: cfg.load_timeout,
            eval_timeout: cfg.eval_timeout,
            settle: cfg.settle,
            me: me.clone(),
        });
        let weak = Arc::downgrade(&core);
        backend.set_sink(Arc::new(move |project, page, ev| {
            if let Some(core) = weak.upgrade() {
                core.apply_page_event(project, page, ev);
            }
        }));
        core
    }

    pub fn bus_dir(&self) -> &PathBuf {
        &self.bus_dir
    }

    /// The project's record, created from its saved prefs on first touch.
    fn entry<'a>(&self, g: &'a mut HashMap<String, Proj>, project: &str) -> &'a mut Proj {
        g.entry(project.to_string()).or_insert_with(|| self.fresh(project))
    }

    /// A project record from its saved prefs and saved pages (the pages come back unloaded).
    fn fresh(&self, project: &str) -> Proj {
        Proj::new(project, lock(&self.prefs).get(project), lock(&self.saved).get(project))
    }

    /// Writes the project's page list when it differs from what is on disk.
    fn persist(&self, project: &str, p: &Proj) {
        let mut s = lock(&self.saved);
        let prior = s.get(project);
        let now = p.saved(prior.active);
        if now == prior {
            return;
        }
        if now.pages.is_empty() {
            s.remove(project);
        } else {
            s.set(project, now);
        }
    }

    /// Applies a change to one project, then wakes waiters and emits the new state.
    fn update<F: FnOnce(&mut Proj)>(&self, project: &str, f: F) -> BrowserState {
        // emitted under the lock so concurrent updates reach listeners in the order they happened
        let state = {
            let mut g = lock(&self.projects);
            let p = self.entry(&mut g, project);
            f(p);
            p.sync();
            self.persist(project, p);
            self.emitter.state(&p.state);
            p.state.clone()
        };
        self.changed.notify_all();
        state
    }

    /// Changes remembered layout without emitting a state event (rects change every frame).
    fn update_quiet<F: FnOnce(&mut Proj)>(&self, project: &str, f: F) {
        let mut g = lock(&self.projects);
        let p = self.entry(&mut g, project);
        f(p);
        p.sync();
    }

    fn peek<T>(&self, project: &str, f: impl FnOnce(&Proj) -> T) -> Option<T> {
        lock(&self.projects).get(project).map(f)
    }

    pub fn state(&self, project: &str) -> BrowserState {
        self.peek(project, |p| p.state.clone()).unwrap_or_else(|| self.fresh(project).state)
    }

    pub fn steps(&self, project: &str) -> Vec<Step> {
        self.peek(project, |p| p.steps.clone()).unwrap_or_default()
    }

    /// The page an op or command means: the one named, else the active one.
    fn resolve_page(&self, project: &str, page: Option<&str>) -> BrowserResult<String> {
        self.ensure_live(project, true)?;
        self.find_page(project, page)
    }

    fn find_page(&self, project: &str, page: Option<&str>) -> BrowserResult<String> {
        if !lock(&self.projects).contains_key(project) && !lock(&self.saved).get(project).pages.is_empty() {
            self.update_quiet(project, |_| {});
        }
        self.peek(project, |p| match page {
            Some(id) => p.page(id).map(|r| r.st.id.clone()).ok_or_else(|| BrowserError::new("not_found", format!("no page {id} in this project's browser"))),
            None if p.page(&p.active).is_some() => Ok(p.active.clone()),
            None => Err(BrowserError::new("not_found", "no page is open in this project's browser")),
        })
        .unwrap_or_else(|| Err(BrowserError::new("not_found", "no page is open in this project's browser")))
    }

    fn page_url(&self, project: &str, page: &str) -> String {
        self.peek(project, |p| p.page(page).map(|r| r.st.url.clone())).flatten().unwrap_or_default()
    }

    // ---- page events -------------------------------------------------------------------------

    /// An event for the active page.
    #[cfg(test)]
    pub fn apply_event(&self, project: &str, ev: BackendEvent) {
        let page = self.peek(project, |p| p.active.clone()).unwrap_or_default();
        self.apply_page_event(project, &page, ev);
    }

    pub fn apply_page_event(&self, project: &str, page: &str, ev: BackendEvent) {
        let spawn = |f: Box<dyn FnOnce(Arc<BrowserCore>) + Send>| {
            if let Some(core) = self.me.upgrade() {
                std::thread::spawn(move || f(core));
            }
        };
        if let BackendEvent::PopoutClosed = ev {
            let project = project.to_string();
            spawn(Box::new(move |core| {
                let rect = core.peek(&project, |p| p.rect).unwrap_or(Rect::DEFAULT);
                let _ = core.put_back(&project, rect);
            }));
            return;
        }
        if self.peek(project, |p| p.page(page).is_none()).unwrap_or(true) {
            return;
        }
        let (project_s, page_s) = (project.to_string(), page.to_string());
        match ev {
            BackendEvent::Navigated(url) => {
                if real_url(&url) {
                    self.update(project, |p| {
                        if let Some(r) = p.page_mut(page) {
                            r.st.url = url;
                        }
                    });
                }
            }
            BackendEvent::LoadStarted(url) => {
                self.update(project, |p| {
                    if let Some(r) = p.page_mut(page) {
                        if real_url(&url) {
                            r.st.url = url;
                        }
                        r.st.loading = true;
                        r.awaiting = None;
                    }
                });
            }
            BackendEvent::LoadFinished(url) => {
                let st = self.update(project, |p| {
                    if let Some(r) = p.page_mut(page) {
                        if real_url(&url) {
                            r.st.url = url;
                        }
                        r.st.loading = false;
                        r.awaiting = None;
                    }
                });
                if let Some(ps) = st.pages.iter().find(|x| x.id == page) {
                    self.record_visit(project, &ps.url, &ps.title);
                }
                spawn(Box::new(move |core| core.refresh_history(&project_s, &page_s)));
            }
            BackendEvent::Title(title) => {
                let st = self.update(project, |p| {
                    if let Some(r) = p.page_mut(page) {
                        r.st.title = title;
                    }
                });
                if let Some(ps) = st.pages.iter().find(|x| x.id == page) {
                    self.retitle_visit(project, &ps.url, &ps.title);
                }
            }
            BackendEvent::NewWindow(url) => {
                if let Ok(url) = normalize_url(&url) {
                    spawn(Box::new(move |core| {
                        let _ = core.create_page(&project_s, Some(&url), true, false);
                    }));
                }
            }
            BackendEvent::CloseRequested => {
                if self.peek(project, |p| p.page(page).is_some_and(|r| r.popup)).unwrap_or(false) {
                    spawn(Box::new(move |core| {
                        let _ = core.close_page(&project_s, &page_s);
                    }));
                }
            }
            BackendEvent::Observed { .. } => {
                let now = Instant::now();
                let probe = self.peek(project, |p| p.page(page).cloned()).flatten().map(|mut r| observe(&mut r, &ev, self.settle, now));
                if probe.is_some_and(|(changed, ..)| changed) {
                    let mut outcome = (false, false, false);
                    let st = self.update(project, |p| {
                        if let Some(r) = p.page_mut(page) {
                            outcome = observe(r, &ev, self.settle, now);
                        }
                    });
                    let (_, finished, moved) = outcome;
                    if finished || moved {
                        if let Some(ps) = st.pages.iter().find(|x| x.id == page) {
                            self.record_visit(project, &ps.url, &ps.title);
                        }
                    }
                }
            }
            BackendEvent::PopoutClosed => {}
        }
        self.apply_visibility(project);
    }

    pub fn refresh_history(&self, project: &str, page: &str) {
        let (back, fwd) = self.backend.history(project, page);
        self.update(project, |p| {
            if let Some(r) = p.page_mut(page) {
                r.can_back = back;
                r.can_forward = fwd;
            }
        });
    }

    // ---- history, favorites, permissions -----------------------------------------------------

    fn record_visit(&self, project: &str, url: &str, title: &str) {
        if !real_url(url) {
            return;
        }
        let mut g = lock(&self.history);
        let mut list = g.get(project);
        if let Some(first) = list.first_mut().filter(|e| e.url == url) {
            first.title = title.to_string();
            first.at = now_ms();
        } else {
            list.insert(0, HistoryEntry { url: url.to_string(), title: title.to_string(), at: now_ms() });
            list.truncate(MAX_HISTORY);
        }
        g.set(project, list);
    }

    /// The title usually lands after the visit was recorded.
    fn retitle_visit(&self, project: &str, url: &str, title: &str) {
        let mut g = lock(&self.history);
        let mut list = g.get(project);
        if let Some(first) = list.first_mut().filter(|e| e.url == url && e.title != title) {
            first.title = title.to_string();
            g.set(project, list);
        }
    }

    pub fn history(&self, project: &str) -> Vec<HistoryEntry> {
        lock(&self.history).get(project)
    }

    pub fn favorites(&self, project: &str) -> Vec<Favorite> {
        lock(&self.favorites).get(project)
    }

    /// Returns whether the url is a favorite afterwards.
    pub fn favorite_toggle(&self, project: &str, url: &str, title: &str) -> bool {
        let mut g = lock(&self.favorites);
        let mut list = g.get(project);
        let was = list.iter().any(|f| f.url == url);
        if was {
            list.retain(|f| f.url != url);
        } else {
            list.push(Favorite { url: url.to_string(), title: title.to_string() });
        }
        g.set(project, list);
        !was
    }

    pub fn permissions(&self, project: &str) -> Vec<Permission> {
        lock(&self.hosts).allowed_for(project).into_iter().map(|host| Permission { host, rule: "site".into() }).collect()
    }

    pub fn permission_revoke(&self, project: &str, host: &str) {
        lock(&self.hosts).revoke(project, host);
    }

    // ---- pages -------------------------------------------------------------------------------

    /// Creates the webviews of pages restored from the last run (the active one first, the rest
    /// hidden) and loads their saved urls. A no-op once none are left. `reveal` brings the tab
    /// forward when an agent, not the tab, caused it.
    fn ensure_live(&self, project: &str, reveal: bool) -> BrowserResult<()> {
        let (plan, needs_reveal): (Vec<(String, String, PageSpec)>, bool) = {
            let mut g = lock(&self.projects);
            let Some(p) = g.get_mut(project) else {
                // an untouched project: hydrate it only if the disk holds pages for it
                if lock(&self.saved).get(project).pages.is_empty() {
                    return Ok(());
                }
                drop(g);
                self.update_quiet(project, |_| {});
                return self.ensure_live(project, reveal);
            };
            if !p.pages.iter().any(|r| r.restored) {
                return Ok(());
            }
            let (rect, zoom) = p.geometry();
            let ua = p.effective_ua();
            let mut order: Vec<usize> = (0..p.pages.len()).collect();
            order.sort_by_key(|i| p.pages[*i].st.id != p.active);
            let mut plan = Vec::new();
            let todo: Vec<usize> = order.into_iter().filter(|i| p.pages[*i].restored).collect();
            for i in todo {
                let shown = {
                    let r = &p.pages[i];
                    r.st.id == p.active && (p.visible || p.state.popped_out)
                };
                let r = &mut p.pages[i];
                r.restored = false;
                r.st.restored = false;
                r.st.loading = true;
                r.awaiting = Some(Instant::now());
                r.applied_zoom = zoom;
                r.applied_ua = ua.to_string();
                if !p.state.popped_out {
                    r.applied_rect = Some(rect);
                }
                r.shown = shown;
                plan.push((r.st.id.clone(), r.st.url.clone(), PageSpec { rect, visible: shown, ua: device::ua_string(ua).to_string(), popup: false, zoom }));
            }
            p.sync();
            (plan, reveal && !p.visible && !p.state.popped_out)
        };
        self.update(project, |_| {});
        for (id, url, spec) in plan {
            if let Err(e) = self.backend.open_page(project, &id, &url, spec) {
                // keep the page listed and unloaded so a later try can load it
                self.update(project, |p| {
                    if let Some(r) = p.page_mut(&id) {
                        r.restored = true;
                        r.st.restored = true;
                        r.st.loading = false;
                        r.shown = false;
                    }
                });
                return Err(e);
            }
        }
        if needs_reveal {
            self.emitter.reveal(project);
        }
        self.apply_visibility(project);
        self.changed.notify_all();
        Ok(())
    }

    /// Makes a page and activates it. `user` is true for the operator's own actions (the tab is
    /// then on screen), false for agents and sites (the tab is brought forward when it is not).
    pub fn create_page(&self, project: &str, url: Option<&str>, popup: bool, user: bool) -> BrowserResult<String> {
        let url = url.map(normalize_url).transpose()?;
        self.ensure_live(project, false)?;
        let (id, spec, needs_reveal) = {
            let mut g = lock(&self.projects);
            let p = self.entry(&mut g, project);
            if user {
                p.visible = true;
            }
            p.next_page += 1;
            let id = format!("pg{}", p.next_page);
            let (rect, zoom) = p.geometry();
            let ua = p.effective_ua();
            let mut rec = PageRec::blank(&id);
            rec.popup = popup;
            rec.st.url = url.clone().unwrap_or_default();
            rec.st.loading = url.is_some();
            rec.awaiting = url.is_some().then(Instant::now);
            rec.applied_zoom = zoom;
            rec.applied_ua = ua.to_string();
            if !p.state.popped_out {
                rec.applied_rect = Some(rect);
            }
            let needs_reveal = !user && url.is_some() && !p.visible && !p.state.popped_out;
            let visible = url.is_some() && (p.visible || p.state.popped_out);
            rec.shown = visible;
            p.pages.push(rec);
            p.active = id.clone();
            p.sync();
            (id.clone(), PageSpec { rect, visible, ua: device::ua_string(ua).to_string(), popup, zoom }, needs_reveal)
        };
        self.update(project, |_| {});
        if let Err(e) = self.backend.open_page(project, &id, url.as_deref().unwrap_or("about:blank"), spec) {
            self.update(project, |p| {
                p.pages.retain(|r| r.st.id != id);
                if p.active == id {
                    p.active = p.pages.last().map(|r| r.st.id.clone()).unwrap_or_default();
                }
            });
            return Err(e);
        }
        if needs_reveal {
            self.emitter.reveal(project);
        }
        self.apply_visibility(project);
        self.changed.notify_all();
        Ok(id)
    }

    pub fn close_page(&self, project: &str, page: &str) -> BrowserResult<()> {
        self.find_page(project, Some(page))?;
        let unloaded = self.peek(project, |p| p.page(page).is_some_and(|r| r.restored)).unwrap_or(false);
        let frame = if unloaded { None } else { self.backend.close_page(project, page)? };
        if let Some(frame) = frame {
            lock(&self.frames).set(project, frame);
        }
        let mut last = false;
        self.update(project, |p| {
            let at = p.pages.iter().position(|r| r.st.id == page).unwrap_or(0);
            p.pages.retain(|r| r.st.id != page);
            if p.active == page {
                p.active = p.pages.get(at.saturating_sub(1)).map(|r| r.st.id.clone()).unwrap_or_default();
            }
            if p.pages.is_empty() {
                last = true;
                p.visible = false;
                p.state.popped_out = false;
            }
        });
        if last {
            lock(&self.hosts).end_visit(project);
        }
        self.apply_visibility(project);
        Ok(())
    }

    pub fn select_page(&self, project: &str, page: &str) -> BrowserResult<()> {
        self.resolve_page(project, Some(page))?;
        self.update(project, |p| p.active = page.to_string());
        self.apply_visibility(project);
        Ok(())
    }

    /// Shows the active page (once it has a url) and hides the rest, calling the backend only for changes.
    fn apply_visibility(&self, project: &str) {
        let plan: Vec<(String, bool)> = {
            let mut g = lock(&self.projects);
            let Some(p) = g.get_mut(project) else { return };
            let wants: Vec<bool> = p.pages.iter().map(|r| p.wants_shown(r)).collect();
            p.pages
                .iter_mut()
                .zip(wants)
                .filter(|(r, w)| r.shown != *w)
                .map(|(r, w)| {
                    r.shown = w;
                    (r.st.id.clone(), w)
                })
                .collect()
        };
        for (id, want) in plan {
            let _ = self.backend.set_visible(project, &id, want);
        }
    }

    /// Places every page for the current rect, emulation and zoom, touching only what changed.
    fn apply_layout(&self, project: &str) -> BrowserResult<()> {
        let plan: Vec<(String, Option<Rect>, Option<f64>)> = {
            let mut g = lock(&self.projects);
            let Some(p) = g.get_mut(project) else { return Ok(()) };
            let (frame, zoom) = p.geometry();
            let popped = p.state.popped_out;
            p.pages
                .iter_mut()
                .filter(|r| !r.restored)
                .filter_map(|r| {
                    let rect = (!popped && r.applied_rect != Some(frame)).then(|| {
                        r.applied_rect = Some(frame);
                        frame
                    });
                    let z = ((r.applied_zoom - zoom).abs() > 1e-9).then(|| {
                        r.applied_zoom = zoom;
                        zoom
                    });
                    (rect.is_some() || z.is_some()).then(|| (r.st.id.clone(), rect, z))
                })
                .collect()
        };
        for (id, rect, zoom) in plan {
            if let Some(r) = rect {
                self.backend.set_rect(project, &id, r)?;
            }
            if let Some(z) = zoom {
                self.backend.set_zoom(project, &id, z)?;
            }
        }
        Ok(())
    }

    /// Switches pages whose user agent is no longer the one in force, then reloads them.
    fn apply_user_agent(&self, project: &str) -> BrowserResult<()> {
        let (ua, ids): (&'static str, Vec<String>) = {
            let mut g = lock(&self.projects);
            let Some(p) = g.get_mut(project) else { return Ok(()) };
            let ua = p.effective_ua();
            let ids = p.pages.iter_mut().filter(|r| !r.restored && r.applied_ua != ua).map(|r| {
                r.applied_ua = ua.to_string();
                r.st.id.clone()
            });
            (ua, ids.collect())
        };
        for id in ids {
            self.backend.set_user_agent(project, &id, device::ua_string(ua))?;
            if real_url(&self.page_url(project, &id)) {
                self.backend.run_script(project, &id, "location.reload()")?;
            }
        }
        Ok(())
    }

    fn set_prefs(&self, project: &str, f: impl FnOnce(&mut Prefs)) {
        self.update(project, |p| f(&mut p.prefs));
        if let Some(pr) = self.peek(project, |p| p.prefs.clone()) {
            lock(&self.prefs).set(project, pr);
        }
    }

    // ---- commands ----------------------------------------------------------------------------

    pub fn open(&self, project: &str, url: Option<String>, rect: Rect) -> BrowserResult<BrowserState> {
        let rect = rect.sane();
        let url = url.as_deref().map(normalize_url).transpose()?;
        self.update_quiet(project, |p| p.rect = rect);
        self.ensure_live(project, false)?;
        let has_pages = self.peek(project, |p| !p.pages.is_empty()).unwrap_or(false);
        if has_pages {
            // a blank page stays hidden so the tab's "Nothing open" shows through
            let show = url.is_some() || !self.state(project).url.is_empty();
            self.update(project, |p| p.visible = show);
            self.apply_layout(project)?;
            if let Some(url) = url {
                self.navigate(project, &url, None)?;
            }
            self.apply_visibility(project);
        } else if let Some(url) = url {
            self.create_page(project, Some(&url), false, true)?;
        } else {
            self.update(project, |p| p.visible = false);
        }
        Ok(self.state(project))
    }

    pub fn set_rect(&self, project: &str, rect: Rect) -> BrowserResult<()> {
        let rect = rect.sane();
        self.update_quiet(project, |p| p.rect = rect);
        self.apply_layout(project)
    }

    pub fn set_visible(&self, project: &str, visible: bool) -> BrowserResult<()> {
        self.update_quiet(project, |p| p.visible = visible);
        self.apply_visibility(project);
        Ok(())
    }

    /// Navigates a page; with nothing open it opens the first page instead.
    pub fn navigate(&self, project: &str, url: &str, page: Option<&str>) -> BrowserResult<()> {
        let url = normalize_url(url)?;
        if page.is_none() && self.peek(project, |p| p.pages.is_empty()).unwrap_or(true) {
            self.create_page(project, Some(&url), false, true)?;
            return Ok(());
        }
        let id = self.resolve_page(project, page)?;
        self.update(project, |p| {
            if let Some(r) = p.page_mut(&id) {
                r.st.loading = true;
                r.st.url = url.clone();
                r.awaiting = Some(Instant::now());
            }
        });
        self.apply_visibility(project);
        self.backend.navigate(project, &id, &url)
    }

    pub fn back(&self, project: &str, page: Option<&str>) -> BrowserResult<()> {
        let id = self.resolve_page(project, page)?;
        self.backend.run_script(project, &id, "history.back()")
    }

    pub fn forward(&self, project: &str, page: Option<&str>) -> BrowserResult<()> {
        let id = self.resolve_page(project, page)?;
        self.backend.run_script(project, &id, "history.forward()")
    }

    pub fn reload(&self, project: &str, page: Option<&str>) -> BrowserResult<()> {
        let id = self.resolve_page(project, page)?;
        self.backend.run_script(project, &id, "location.reload()")
    }

    pub fn pop_out(&self, project: &str) -> BrowserResult<()> {
        self.resolve_page(project, None)?;
        let frame = lock(&self.frames).get(project);
        self.backend.pop_out(project, frame)?;
        self.update(project, |p| {
            p.state.popped_out = true;
            // the window drives page bounds from now on
            p.pages.iter_mut().for_each(|r| {
                r.applied_rect = None;
                r.shown = false;
            });
        });
        self.apply_visibility(project);
        self.apply_layout(project)
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
            p.pages.iter_mut().for_each(|r| {
                r.applied_rect = None;
                r.shown = false;
            });
        });
        self.apply_layout(project)?;
        self.apply_visibility(project);
        Ok(())
    }

    pub fn close(&self, project: &str) -> BrowserResult<()> {
        lock(&self.hosts).end_visit(project);
        if self.peek(project, |p| p.pages.iter().any(|r| !r.restored)).unwrap_or(false) {
            if let Some(frame) = self.backend.close(project)? {
                lock(&self.frames).set(project, frame);
            }
        }
        self.update(project, |p| {
            p.pages.clear();
            p.active.clear();
            p.state.popped_out = false;
            p.visible = false;
        });
        Ok(())
    }

    pub fn take_over(&self, project: &str) {
        self.update(project, |p| {
            p.state.held_by_user = true;
            p.pages.iter_mut().for_each(|r| r.st.driver = None);
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

    // ---- B5 ----------------------------------------------------------------------------------

    /// `None` resets to 1.0; anything else is clamped to 0.3..=3.0.
    pub fn zoom(&self, project: &str, level: Option<f64>) -> BrowserResult<()> {
        let z = level.filter(|v| v.is_finite()).unwrap_or(1.0).clamp(0.3, 3.0);
        self.set_prefs(project, |pr| pr.zoom = z);
        self.apply_layout(project)
    }

    pub fn find(&self, project: &str, text: &str, backwards: bool, page: Option<&str>) -> BrowserResult<bool> {
        let id = self.resolve_page(project, page)?;
        if text.is_empty() {
            self.backend.find_clear(project, &id)?;
            return Ok(false);
        }
        self.backend.find(project, &id, text, backwards)
    }

    pub fn find_clear(&self, project: &str, page: Option<&str>) -> BrowserResult<()> {
        let id = self.resolve_page(project, page)?;
        self.backend.find_clear(project, &id)
    }

    pub fn inspect(&self, project: &str, page: Option<&str>) -> BrowserResult<()> {
        let id = self.resolve_page(project, page)?;
        self.backend.inspect(project, &id)
    }

    /// `None` goes back to the default Safari string. Pages reload on a change.
    pub fn set_user_agent(&self, project: &str, preset: Option<&str>) -> BrowserResult<()> {
        let name = match preset {
            None => device::DEFAULT_UA,
            Some(n) => device::ua_preset(n).ok_or_else(|| BrowserError::new("bad_request", format!("no user agent preset {n}")))?,
        };
        self.set_prefs(project, |pr| pr.user_agent = name.to_string());
        self.apply_user_agent(project)
    }

    /// Letterboxes the page at the device's size; a mobile device also switches the user agent
    /// until emulation ends.
    pub fn emulate(&self, project: &str, device: Option<Device>) -> BrowserResult<()> {
        if let Some(d) = &device {
            d.validate()?;
        }
        self.set_prefs(project, |pr| pr.emulation = device);
        self.apply_user_agent(project)?;
        self.apply_layout(project)
    }

    pub fn clear_storage(&self, project: &str) -> BrowserResult<()> {
        self.backend.clear_storage(project)?;
        let ids: Vec<String> = self.peek(project, |p| p.pages.iter().filter(|r| !r.restored && real_url(&r.st.url)).map(|r| r.st.id.clone()).collect()).unwrap_or_default();
        for id in ids {
            self.backend.run_script(project, &id, "location.reload()")?;
        }
        Ok(())
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
        let page_arg = s("page");
        let page_arg = page_arg.as_deref();
        match op.as_str() {
            "pages" => {
                let st = self.state(&project);
                Ok(json!({ "pages": st.pages, "active_page": st.active_page }))
            }
            "new_page" => {
                let url = s("url").map(|u| normalize_url(&u)).transpose()?;
                let host = url.as_deref().map(host_of);
                if let Some(h) = &host {
                    self.gate(&project, who, h)?;
                }
                let id = self.create_page(&project, url.as_deref(), false, false)?;
                let action = host.map(|h| format!("opening {h}")).unwrap_or_else(|| "opening a new page".into());
                self.with_driver(&project, &id, who, action, |me| {
                    // a page that never finishes (streaming) is still a page: report it, not a timeout
                    let loading = url.is_some() && !me.wait_loaded(&project, &id, me.load_timeout);
                    let mut r = me.page_result(&project, &id);
                    r["loading"] = json!(loading);
                    Ok(r)
                })
            }
            "close_page" => {
                let id = s("page").ok_or_else(|| BrowserError::new("bad_request", "page is required"))?;
                self.close_page(&project, &id)?;
                Ok(json!({}))
            }
            "select_page" => {
                let id = s("page").ok_or_else(|| BrowserError::new("bad_request", "page is required"))?;
                self.select_page(&project, &id)?;
                Ok(json!({}))
            }
            "resize" => self.op_resize(&project, req),
            "open" => {
                let url = normalize_url(&s("url").ok_or_else(|| BrowserError::new("bad_request", "url is required"))?)?;
                let host = host_of(&url);
                self.gate(&project, who, &host)?;
                let id = match self.resolve_page(&project, page_arg) {
                    Ok(id) => id,
                    Err(e) if page_arg.is_some() => return Err(e),
                    Err(_) => self.create_page(&project, Some(&url), false, false)?,
                };
                self.with_driver(&project, &id, who, format!("opening {host}"), |me| me.op_open(&project, &id, &url))
            }
            "read" => {
                let id = self.resolve_page(&project, page_arg)?;
                self.gate_current(&project, &id, who)?;
                let max = req.get("max_chars").and_then(Value::as_u64).unwrap_or(20000) as usize;
                self.with_driver(&project, &id, who, "reading the page".into(), |me| me.op_read(&project, &id, max))
            }
            "click" => {
                let id = self.resolve_page(&project, page_arg)?;
                self.gate_current(&project, &id, who)?;
                let target = target_of(req)?;
                let desc = describe(&target);
                self.with_driver(&project, &id, who, format!("clicking {desc}"), |me| {
                    let r = me.run_script(&project, &id, &scripts::click(&target))?;
                    me.name_step(&project, &id, "clicking", &r);
                    Ok(json!({}))
                })
            }
            "type" => {
                let id = self.resolve_page(&project, page_arg)?;
                self.gate_current(&project, &id, who)?;
                let mut target = target_of(req)?;
                let text = s("text").ok_or_else(|| BrowserError::new("bad_request", "text is required"))?;
                target["text"] = Value::String(text);
                target["submit"] = Value::Bool(req.get("submit").and_then(Value::as_bool).unwrap_or(false));
                let desc = describe(&target);
                self.with_driver(&project, &id, who, format!("typing into {desc}"), |me| {
                    let r = me.run_script(&project, &id, &scripts::type_text(&target))?;
                    me.name_step(&project, &id, "typing into", &r);
                    Ok(json!({}))
                })
            }
            "scroll" => {
                let id = self.resolve_page(&project, page_arg)?;
                self.gate_current(&project, &id, who)?;
                let dy = req.get("dy").and_then(Value::as_f64).ok_or_else(|| BrowserError::new("bad_request", "dy is required"))?;
                self.with_driver(&project, &id, who, "scrolling".into(), |me| {
                    me.run_script(&project, &id, &scripts::scroll(dy))?;
                    Ok(json!({}))
                })
            }
            "screenshot" => {
                let id = self.resolve_page(&project, page_arg)?;
                self.gate_current(&project, &id, who)?;
                let element = s("element");
                self.with_driver(&project, &id, who, "taking a screenshot".into(), |me| me.op_screenshot(&project, &id, element))
            }
            "back" | "forward" | "reload" => {
                let id = self.resolve_page(&project, page_arg)?;
                self.gate_current(&project, &id, who)?;
                let action = match op.as_str() {
                    "back" => "going back",
                    "forward" => "going forward",
                    _ => "reloading",
                };
                self.with_driver(&project, &id, who, action.into(), |me| {
                    match op.as_str() {
                        "back" => me.back(&project, Some(&id))?,
                        "forward" => me.forward(&project, Some(&id))?,
                        _ => me.reload(&project, Some(&id))?,
                    }
                    Ok(json!({}))
                })
            }
            "evaluate" => {
                let script = s("script").ok_or_else(|| BrowserError::new("bad_request", "script is required"))?;
                let id = self.resolve_page(&project, page_arg)?;
                self.gate_current(&project, &id, who)?;
                self.gate_eval(&project, &id, who)?;
                self.with_driver(&project, &id, who, "running a script".into(), |me| me.op_evaluate(&project, &id, &script))
            }
            other => Err(BrowserError::new("bad_request", format!("unknown op {other}"))),
        }
    }

    /// `device` is a preset name, a full Device object, or absent with `w` and `h` for a custom
    /// size. Nothing at all ends emulation.
    fn op_resize(&self, project: &str, req: &Value) -> BrowserResult<Value> {
        let device = match req.get("device") {
            Some(Value::String(name)) => Some(device::preset(name).ok_or_else(|| BrowserError::new("bad_request", format!("no device preset {name}")))?),
            Some(v) if v.is_object() => Some(serde_json::from_value::<Device>(v.clone()).map_err(|e| BrowserError::new("bad_request", format!("bad device: {e}")))?),
            _ => match (req.get("w").and_then(Value::as_f64), req.get("h").and_then(Value::as_f64)) {
                (Some(w), Some(h)) => Some(device::custom(w, h)),
                (None, None) => None,
                _ => return Err(BrowserError::new("bad_request", "give both w and h")),
            },
        };
        self.emulate(project, device)?;
        Ok(json!({ "emulation": self.state(project).emulation }))
    }

    fn page_result(&self, project: &str, page: &str) -> Value {
        let url_title = self.peek(project, |p| p.page(page).map(|r| (r.st.url.clone(), r.st.title.clone()))).flatten().unwrap_or_default();
        json!({ "page": page, "url": url_title.0, "title": url_title.1 })
    }

    fn op_open(&self, project: &str, page: &str, url: &str) -> BrowserResult<Value> {
        // a page made for this op is already loading this url; an existing one navigates
        if self.page_url(project, page) != url || !self.peek(project, |p| p.page(page).is_some_and(|r| r.st.loading)).unwrap_or(false) {
            self.navigate(project, url, Some(page))?;
        }
        let loading = !self.wait_loaded(project, page, self.load_timeout);
        let st = self.page_result(project, page);
        Ok(json!({ "url": st["url"], "title": st["title"], "page": page, "loading": loading }))
    }

    fn op_read(&self, project: &str, page: &str, max: usize) -> BrowserResult<Value> {
        self.wait_loaded(project, page, Duration::from_secs(5));
        let v = self.run_script(project, page, &scripts::read(max))?;
        Ok(json!({
            "url": v["url"], "title": v["title"], "text": v["text"], "outline": v["outline"],
        }))
    }

    fn op_screenshot(&self, project: &str, page: &str, element: Option<String>) -> BrowserResult<Value> {
        self.wait_loaded(project, page, Duration::from_secs(5));
        let clip = match element {
            Some(r) => {
                let v = self.run_script(project, page, &scripts::element_rect(&json!({ "ref": r })))?;
                serde_json::from_value::<Rect>(v["rect"].clone()).ok().map(Rect::sane)
            }
            None => None,
        };
        let png = self.backend.snapshot(project, page, clip)?;
        let dir = self.bus_dir.join("browser-shots");
        std::fs::create_dir_all(&dir).map_err(|e| BrowserError::new("timeout", format!("cannot write screenshots: {e}")))?;
        let safe: String = project.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
        let path = dir.join(format!("{}-{safe}.png", now_ms()));
        std::fs::write(&path, png).map_err(|e| BrowserError::new("timeout", format!("cannot write screenshot: {e}")))?;
        Ok(json!({ "path": path.to_string_lossy() }))
    }

    /// Runs the script as an expression first (it works under a strict CSP), then through eval for
    /// statements. The result is JSON.
    fn op_evaluate(&self, project: &str, page: &str, src: &str) -> BrowserResult<Value> {
        let expr = src.trim().trim_end_matches(';');
        let raw = self.backend.eval(project, page, &scripts::evaluate_expr(expr), self.eval_timeout)?;
        let v = match scripts::parse_result(&raw) {
            Some(v) => v,
            None => {
                let raw = self.backend.eval(project, page, &scripts::evaluate_eval(src), self.eval_timeout)?;
                scripts::parse_result(&raw).ok_or_else(|| BrowserError::new("timeout", "the page returned no result"))?
            }
        };
        if v["ok"].as_bool() == Some(false) {
            return Err(BrowserError::new("bad_request", v["message"].as_str().unwrap_or("the script failed").to_string()));
        }
        Ok(json!({ "value": v["value"] }))
    }

    /// Runs a page script and maps its `{ok:false,error}` answers to errors.
    fn run_script(&self, project: &str, page: &str, js: &str) -> BrowserResult<Value> {
        let raw = self.backend.eval(project, page, js, self.eval_timeout)?;
        let v = scripts::parse_result(&raw).ok_or_else(|| BrowserError::new("timeout", "the page returned no result"))?;
        if v["ok"].as_bool() == Some(false) {
            let code = if v["error"].as_str() == Some("not_found") { "not_found" } else { "timeout" };
            return Err(BrowserError::new(code, v["message"].as_str().unwrap_or("the page refused").to_string()));
        }
        Ok(v)
    }

    fn wait_loaded(&self, project: &str, page: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut g = lock(&self.projects);
        loop {
            if !g.get(project).and_then(|p| p.page(page)).is_some_and(|r| r.st.loading) {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                drop(g);
                return self.settle_if_ready(project, page);
            }
            g = self.changed.wait_timeout(g, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    /// The wait ran out: ask the document itself. Ready (interactive or complete) settles the
    /// page even if WebKit still reports loading.
    fn settle_if_ready(&self, project: &str, page: &str) -> bool {
        let ready = self
            .run_script(project, page, &scripts::evaluate_expr("document.readyState"))
            .ok()
            .and_then(|v| v["value"].as_str().map(str::to_string))
            .is_some_and(|r| r == "complete" || r == "interactive");
        if ready {
            self.update(project, |p| {
                if let Some(r) = p.page_mut(page) {
                    r.st.loading = false;
                    r.awaiting = None;
                    r.settled_url = Some(r.st.url.clone());
                }
            });
        }
        ready
    }

    // ---- hosts -------------------------------------------------------------------------------

    fn gate_current(&self, project: &str, page: &str, who: (&str, &str)) -> BrowserResult<()> {
        let host = host_of(&self.page_url(project, page));
        self.gate(project, who, &host)
    }

    fn gate(&self, project: &str, (session, label): (&str, &str), host: &str) -> BrowserResult<()> {
        let decision = lock(&self.hosts).check(project, host, session, label, || format!("{:016x}", rand::random::<u64>()));
        self.decide(decision, host)
    }

    /// Scripts ask on their own, once per host, even where the host is already allowed.
    fn gate_eval(&self, project: &str, page: &str, (session, label): (&str, &str)) -> BrowserResult<()> {
        let host = host_of(&self.page_url(project, page));
        let decision = lock(&self.hosts).check_eval(project, &host, session, label, || format!("{:016x}", rand::random::<u64>()));
        self.decide(decision, &host)
    }

    fn decide(&self, decision: Decision, host: &str) -> BrowserResult<()> {
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

    /// Shows the agent as the page's driver while `f` runs and for the linger after, and logs the step.
    fn with_driver<T>(self: &Arc<Self>, project: &str, page: &str, (session, label): (&str, &str), action: String, f: impl FnOnce(&Arc<Self>) -> BrowserResult<T>) -> BrowserResult<T> {
        let token = {
            let mut g = lock(&self.projects);
            let p = self.entry(&mut g, project);
            p.page_mut(page).map(|r| {
                r.driver_gen += 1;
                r.driver_gen
            })
        };
        let Some(token) = token else { return f(self) };
        self.update(project, |p| {
            if let Some(r) = p.page_mut(page) {
                r.st.driver = Some(Driver { session: session.into(), label: label.into(), action: action.clone(), since: now_ms() });
            }
        });
        let result = f(self);
        let action = self.peek(project, |p| p.page(page).and_then(|r| r.st.driver.as_ref().map(|d| d.action.clone()))).flatten().unwrap_or(action);
        self.update(project, |p| {
            p.steps.push(Step { session: session.into(), label: label.into(), action, at: now_ms(), ok: result.is_ok() });
            let extra = p.steps.len().saturating_sub(MAX_STEPS);
            p.steps.drain(..extra);
        });
        let (me, project, page) = (self.clone(), project.to_string(), page.to_string());
        std::thread::spawn(move || {
            std::thread::sleep(me.linger);
            let still_ours = me.peek(&project, |p| p.page(&page).is_some_and(|r| r.driver_gen == token)).unwrap_or(false);
            if still_ours {
                me.update(&project, |p| {
                    if let Some(r) = p.page_mut(&page) {
                        r.st.driver = None;
                    }
                });
            }
        });
        result
    }

    /// Rewrites the driver's action with the element's name once the page has said what it is.
    fn name_step(&self, project: &str, page: &str, verb: &str, result: &Value) {
        let Some(name) = result["name"].as_str().filter(|n| !n.is_empty()) else { return };
        self.update(project, |p| {
            if let Some(d) = p.page_mut(page).and_then(|r| r.st.driver.as_mut()) {
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
