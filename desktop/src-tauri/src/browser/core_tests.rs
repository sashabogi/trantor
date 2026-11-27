use super::super::hosts::{FrameStore, HostRules};
use super::*;
use std::sync::OnceLock;

type EvalHook = Box<dyn Fn(&str) -> String + Send + Sync>;

#[derive(Default)]
struct Fake {
    pages: Mutex<Vec<(String, String)>>,
    calls: Mutex<Vec<String>>,
    sink: Mutex<Option<Sink>>,
    eval: Mutex<Option<EvalHook>>,
    frame: Mutex<Option<Rect>>,
    popout_frames: Mutex<Vec<Option<Rect>>>,
    /// When set, a page never reports its load finishing (as a hidden page did in the field).
    mute_loads: std::sync::atomic::AtomicBool,
    found: std::sync::atomic::AtomicBool,
}

impl Fake {
    fn log(&self, s: String) {
        lock(&self.calls).push(s);
    }
    fn calls(&self) -> Vec<String> {
        lock(&self.calls).clone()
    }
    fn exists(&self, project: &str) -> bool {
        lock(&self.pages).iter().any(|(p, _)| p == project)
    }
    fn last(&self, prefix: &str) -> Option<String> {
        self.calls().into_iter().rev().find(|c| c.starts_with(prefix))
    }
    /// Simulates a page load finishing a moment after navigation starts.
    fn load(&self, project: &str, page: &str, url: &str) {
        if self.mute_loads.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let sink = lock(&self.sink).clone();
        let (p, g, u) = (project.to_string(), page.to_string(), url.to_string());
        if let Some(s) = sink {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                s(&p, &g, BackendEvent::Title("Example".into()));
                s(&p, &g, BackendEvent::LoadFinished(u));
            });
        }
    }
}

impl Backend for Fake {
    fn set_sink(&self, sink: Sink) {
        *lock(&self.sink) = Some(sink);
    }
    fn open_page(&self, project: &str, page: &str, url: &str, spec: PageSpec) -> BrowserResult<()> {
        self.log(format!("open {project} {page} {url} {} visible={} popup={} zoom={}", spec.rect.w, spec.visible, spec.popup, spec.zoom));
        lock(&self.pages).push((project.to_string(), page.to_string()));
        self.load(project, page, url);
        Ok(())
    }
    fn set_rect(&self, project: &str, page: &str, rect: Rect) -> BrowserResult<()> {
        self.log(format!("rect {project} {page} {},{},{},{}", rect.x, rect.y, rect.w, rect.h));
        Ok(())
    }
    fn set_visible(&self, project: &str, page: &str, visible: bool) -> BrowserResult<()> {
        self.log(format!("visible {project} {page} {visible}"));
        Ok(())
    }
    fn navigate(&self, project: &str, page: &str, url: &str) -> BrowserResult<()> {
        self.log(format!("navigate {project} {page} {url}"));
        self.load(project, page, url);
        Ok(())
    }
    fn eval(&self, _: &str, _: &str, js: &str, _: Duration) -> BrowserResult<String> {
        let g = lock(&self.eval);
        match g.as_ref() {
            Some(f) => Ok(f(js)),
            None => Err(BrowserError::new("timeout", "no eval hook")),
        }
    }
    fn run_script(&self, project: &str, page: &str, js: &str) -> BrowserResult<()> {
        self.log(format!("script {project} {page} {js}"));
        Ok(())
    }
    fn history(&self, _: &str, _: &str) -> (bool, bool) {
        (true, false)
    }
    fn snapshot(&self, _: &str, _: &str, clip: Option<Rect>) -> BrowserResult<Vec<u8>> {
        self.log(format!("snapshot clip={}", clip.is_some()));
        Ok(vec![0x89, b'P', b'N', b'G'])
    }
    fn pop_out(&self, project: &str, frame: Option<Rect>) -> BrowserResult<()> {
        self.log(format!("pop_out {project}"));
        lock(&self.popout_frames).push(frame);
        Ok(())
    }
    fn put_back(&self, project: &str, rect: Rect) -> BrowserResult<Option<Rect>> {
        self.log(format!("put_back {project} {}", rect.w));
        Ok(*lock(&self.frame))
    }
    fn close_page(&self, project: &str, page: &str) -> BrowserResult<Option<Rect>> {
        self.log(format!("close_page {project} {page}"));
        lock(&self.pages).retain(|(p, g)| !(p == project && g == page));
        Ok(None)
    }
    fn close(&self, project: &str) -> BrowserResult<Option<Rect>> {
        lock(&self.pages).retain(|(p, _)| p != project);
        Ok(None)
    }
    fn set_zoom(&self, project: &str, page: &str, zoom: f64) -> BrowserResult<()> {
        self.log(format!("zoom {project} {page} {zoom:.3}"));
        Ok(())
    }
    fn find(&self, project: &str, page: &str, text: &str, backwards: bool) -> BrowserResult<bool> {
        self.log(format!("find {project} {page} {text} {backwards}"));
        Ok(self.found.load(std::sync::atomic::Ordering::SeqCst))
    }
    fn find_clear(&self, project: &str, page: &str) -> BrowserResult<()> {
        self.log(format!("find_clear {project} {page}"));
        Ok(())
    }
    fn inspect(&self, project: &str, page: &str) -> BrowserResult<()> {
        self.log(format!("inspect {project} {page}"));
        Ok(())
    }
    fn set_user_agent(&self, project: &str, page: &str, ua: &str) -> BrowserResult<()> {
        self.log(format!("ua {project} {page} {ua}"));
        Ok(())
    }
    fn clear_storage(&self, project: &str) -> BrowserResult<()> {
        self.log(format!("clear_storage {project}"));
        Ok(())
    }
}

#[derive(Default)]
struct Rec {
    states: Mutex<Vec<BrowserState>>,
    asks: Mutex<Vec<Ask>>,
    reveals: Mutex<Vec<String>>,
}

impl Emitter for Rec {
    fn state(&self, s: &BrowserState) {
        lock(&self.states).push(s.clone());
    }
    fn ask(&self, a: &Ask) {
        lock(&self.asks).push(a.clone());
    }
    fn reveal(&self, p: &str) {
        lock(&self.reveals).push(p.to_string());
    }
}

struct Rig {
    core: Arc<BrowserCore>,
    fake: Arc<Fake>,
    rec: Arc<Rec>,
    bus: PathBuf,
}

fn rig_with(linger_ms: u64) -> Rig {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let bus = std::env::temp_dir().join(format!("trantor-browser-test-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&bus);
    let fake = Arc::new(Fake::default());
    let rec = Arc::new(Rec::default());
    let mut cfg = CoreConfig::new(bus.clone());
    cfg.linger = Duration::from_millis(linger_ms);
    cfg.load_timeout = Duration::from_secs(3);
    cfg.settle = Duration::from_millis(60);
    let core = BrowserCore::new(fake.clone(), rec.clone(), HostRules::in_memory(), FrameStore::in_memory(), cfg);
    Rig { core, fake, rec, bus }
}

fn rig() -> Rig {
    rig_with(40)
}

const R: Rect = Rect { x: 10.0, y: 20.0, w: 800.0, h: 500.0 };

/// A rig with a page already open on `url`, as if the operator had navigated there.
fn rig_at(url: &str) -> Rig {
    let r = rig();
    r.core.open("p", Some(url.into()), R).expect("open");
    assert!(r.core.wait_loaded("p", "pg1", Duration::from_secs(3)));
    r
}

fn req(op: &str, extra: Value) -> Value {
    let mut v = json!({ "id": "r1", "session": "s1", "label": "codex-8", "project": "p", "op": op });
    if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        m.extend(e.clone());
    }
    v
}

fn set_eval(r: &Rig, f: impl Fn(&str) -> String + Send + Sync + 'static) {
    *lock(&r.fake.eval) = Some(Box::new(f));
}

#[test]
fn state_and_rect_serialize_with_the_contract_field_names() {
    let st = BrowserState {
        project: "p".into(),
        url: "http://localhost:3000/".into(),
        title: "T".into(),
        driver: Some(Driver { session: "s".into(), label: "codex-8".into(), action: "reading the page".into(), since: 7 }),
        ..Default::default()
    };
    let v = serde_json::to_value(&st).expect("serialize");
    for k in ["project", "url", "title", "loading", "can_back", "can_forward", "popped_out", "driver", "held_by_user", "pages", "active_page", "zoom", "user_agent", "emulation"] {
        assert!(v.get(k).is_some(), "missing {k}");
    }
    assert_eq!(v["driver"]["since"], 7);
    assert_eq!(serde_json::to_value(R).expect("rect"), json!({ "x": 10.0, "y": 20.0, "w": 800.0, "h": 500.0 }));
    let back: Rect = serde_json::from_value(json!({ "x": 1, "y": 2, "w": 3, "h": 4 })).expect("rect in");
    assert_eq!(back, Rect { x: 1.0, y: 2.0, w: 3.0, h: 4.0 });
    assert_eq!(Rect { x: f64::NAN, y: 0.0, w: 0.0, h: -5.0 }.sane(), Rect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 });
}

#[test]
fn urls_normalize_and_hosts_parse() {
    assert_eq!(normalize_url("example.com").expect("u"), "https://example.com");
    assert_eq!(normalize_url("localhost:3000/x").expect("u"), "http://localhost:3000/x");
    assert_eq!(normalize_url("  http://a.b/c ").expect("u"), "http://a.b/c");
    for bad in ["", "file:///etc/passwd", "javascript:alert(1)", "ftp://x"] {
        assert_eq!(normalize_url(bad).expect_err(bad).code, "bad_request", "{bad}");
    }
    assert_eq!(host_of("https://User@Example.COM:8443/p?q#f"), "example.com");
    assert_eq!(host_of("http://[::1]:3000/"), "[::1]");
}

#[test]
fn malformed_lines_and_requests_answer_bad_request() {
    let r = rig();
    for line in ["not json", "[1]", r#"{"id":"x","op":"read"}"#, r#"{"id":"x","project":"p"}"#, r#"{"id":"x","project":"p","op":"dance"}"#] {
        let v: Value = serde_json::from_str(&r.core.handle_line(line)).expect("json out");
        assert_eq!(v["ok"], false, "{line}");
        assert_eq!(v["error"], "bad_request", "{line}");
    }
    let v: Value = serde_json::from_str(&r.core.handle_line(r#"{"id":"abc","project":"p","op":"dance"}"#)).expect("json");
    assert_eq!(v["id"], "abc");
}

#[test]
fn state_op_works_without_a_page_and_echoes_the_id() {
    let r = rig();
    let v = r.core.handle_request(&req("state", json!({})));
    assert_eq!(v["ok"], true);
    assert_eq!(v["id"], "r1");
    assert_eq!(v["project"], "p");
    assert_eq!(v["held_by_user"], false);
}

#[test]
fn ops_without_a_page_say_not_found() {
    let r = rig();
    let v = r.core.handle_request(&req("read", json!({})));
    assert_eq!((v["ok"].clone(), v["error"].clone()), (json!(false), json!("not_found")));
}

#[test]
fn open_op_navigates_waits_for_load_and_reveals_the_tab() {
    let r = rig();
    let v = r.core.handle_request(&req("open", json!({ "url": "http://localhost:5173/" })));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["url"], "http://localhost:5173/");
    assert_eq!(v["title"], "Example");
    assert_eq!(*lock(&r.rec.reveals), vec!["p".to_string()]);
    assert!(r.fake.calls()[0].contains("visible=false"));
    // A second open reuses the page and navigates it.
    let v = r.core.handle_request(&req("open", json!({ "url": "http://localhost:5173/next" })));
    assert_eq!(v["ok"], true);
    assert!(r.fake.calls().iter().any(|c| c == "navigate p pg1 http://localhost:5173/next"));
    assert!(lock(&r.rec.states).iter().any(|s| s.loading), "loading state was emitted");
}

#[test]
fn open_reports_a_page_that_never_finishes_as_still_loading_not_an_error() {
    let r = rig();
    let mut cfg = CoreConfig::new(r.bus.clone());
    cfg.load_timeout = Duration::from_millis(100);
    let core = BrowserCore::new(r.fake.clone(), r.rec.clone(), HostRules::in_memory(), FrameStore::in_memory(), cfg);
    // The fake only reports loads through its sink; with none attached the page never finishes,
    // and with no eval hook the document cannot say it is ready either.
    *lock(&r.fake.sink) = None;
    let v = core.handle_request(&req("open", json!({ "url": "http://localhost:1/" })));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["loading"], true, "{v}");
}

#[test]
fn a_streaming_page_whose_document_is_ready_settles_and_ignores_later_loading_samples() {
    let r = rig();
    let mut cfg = CoreConfig::new(r.bus.clone());
    cfg.load_timeout = Duration::from_millis(100);
    let core = BrowserCore::new(r.fake.clone(), r.rec.clone(), HostRules::in_memory(), FrameStore::in_memory(), cfg);
    *lock(&r.fake.sink) = None;
    // WebKit never clears isLoading (media keeps streaming), but the document says complete
    set_eval(&r, |js| {
        assert!(js.contains("document.readyState"), "{js}");
        json!({"ok": true, "value": "complete"}).to_string()
    });
    let v = core.handle_request(&req("new_page", json!({ "url": "http://localhost:2/" })));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["loading"], false, "{v}");
    let page = v["page"].as_str().expect("page id").to_string();
    // the sampler keeps reporting loading for the same url: ignored
    core.apply_page_event("p", &page, BackendEvent::Observed { url: None, title: None, loading: true, can_back: None, can_forward: None });
    assert!(!core.state("p").loading, "a settled page does not flip back to loading");
    // a real navigation clears the settle: the next loading sample counts again
    core.apply_page_event("p", &page, BackendEvent::Observed { url: Some("http://localhost:2/next".into()), title: None, loading: true, can_back: None, can_forward: None });
    assert!(core.state("p").loading, "a new url loads normally");
}

#[test]
fn read_returns_url_title_text_and_outline() {
    let r = rig_at("http://localhost:3000/");
    set_eval(&r, |js| {
        assert!(js.contains(r#"({"max":50})"#), "max_chars reaches the script");
        json!({"ok": true, "url": "http://localhost:3000/", "title": "App", "text": "hello",
               "outline": [{"ref": "e1", "role": "button", "name": "Save"}]}).to_string()
    });
    let v = r.core.handle_request(&req("read", json!({ "max_chars": 50 })));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["text"], "hello");
    assert_eq!(v["outline"][0], json!({"ref": "e1", "role": "button", "name": "Save"}));
    assert!(v.get("rect").is_none());
}

#[test]
fn click_by_ref_selector_and_point_and_not_found() {
    let r = rig_at("http://localhost:3000/");
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let s2 = seen.clone();
    set_eval(&r, move |js| {
        lock(&s2).push(js.to_string());
        if js.contains("missing") {
            return json!({"ok": false, "error": "not_found", "message": "nothing matches that target"}).to_string();
        }
        json!({"ok": true, "name": "Show descendants"}).to_string()
    });
    assert_eq!(r.core.handle_request(&req("click", json!({ "ref": "e4" })))["ok"], true);
    assert_eq!(r.core.handle_request(&req("click", json!({ "selector": "#go" })))["ok"], true);
    assert_eq!(r.core.handle_request(&req("click", json!({ "x": 5, "y": 6 })))["ok"], true);
    let v = r.core.handle_request(&req("click", json!({ "selector": ".missing" })));
    assert_eq!(v["error"], "not_found");
    let v = r.core.handle_request(&req("click", json!({})));
    assert_eq!(v["error"], "bad_request");
    let scripts = lock(&seen).clone();
    assert!(scripts[0].ends_with(r#"({"ref":"e4"})"#));
    assert!(scripts[1].ends_with(r##"({"selector":"#go"})"##));
    assert!(scripts[2].ends_with(r#"({"x":5.0,"y":6.0})"#));
    let steps = r.core.steps("p");
    assert_eq!(steps.len(), 4);
    assert_eq!(steps[0].action, "clicking \"Show descendants\"");
    assert!(!steps[3].ok);
}

#[test]
fn type_passes_text_and_submit_and_scroll_needs_dy() {
    let r = rig_at("http://localhost:3000/");
    let seen = Arc::new(Mutex::new(String::new()));
    let s2 = seen.clone();
    set_eval(&r, move |js| {
        *lock(&s2) = js.to_string();
        json!({"ok": true}).to_string()
    });
    let v = r.core.handle_request(&req("type", json!({ "ref": "e2", "text": "hi \"there\"", "submit": true })));
    assert_eq!(v["ok"], true);
    let js = lock(&seen).clone();
    assert!(js.contains(r#""text":"hi \"there\"""#) && js.contains(r#""submit":true"#), "{js}");
    assert_eq!(r.core.handle_request(&req("type", json!({ "ref": "e2" })))["error"], "bad_request");
    assert_eq!(r.core.handle_request(&req("scroll", json!({})))["error"], "bad_request");
    assert_eq!(r.core.handle_request(&req("scroll", json!({ "dy": 400 })))["ok"], true);
    assert!(lock(&seen).contains("scrollBy"));
}

#[test]
fn screenshot_writes_a_png_under_the_bus_and_clips_to_an_element() {
    let r = rig_at("http://localhost:3000/");
    set_eval(&r, |_| json!({"ok": true, "rect": {"x": 1, "y": 2, "w": 30, "h": 40}}).to_string());
    let v = r.core.handle_request(&req("screenshot", json!({ "element": "e3" })));
    assert_eq!(v["ok"], true, "{v}");
    let path = PathBuf::from(v["path"].as_str().expect("path"));
    assert!(path.starts_with(r.bus.join("browser-shots")));
    assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
    assert_eq!(std::fs::read(&path).expect("file"), vec![0x89, b'P', b'N', b'G']);
    assert!(r.fake.calls().iter().any(|c| c == "snapshot clip=true"));
    let v = r.core.handle_request(&req("screenshot", json!({})));
    assert!(r.fake.calls().iter().any(|c| c == "snapshot clip=false"), "{v}");
    let _ = std::fs::remove_dir_all(&r.bus);
}

#[test]
fn a_new_host_asks_and_waits_until_answered() {
    let r = rig_at("https://example.com/");
    set_eval(&r, |_| json!({"ok": true, "url": "https://example.com/", "title": "E", "text": "", "outline": []}).to_string());
    let v = r.core.handle_request(&req("read", json!({})));
    assert_eq!(v["error"], "waiting_for_approval");
    let asks = lock(&r.rec.asks).clone();
    assert_eq!(asks.len(), 1);
    assert_eq!((asks[0].project.as_str(), asks[0].host.as_str(), asks[0].label.as_str(), asks[0].session.as_str()), ("p", "example.com", "codex-8", "s1"));
    // Still open: no second ask.
    assert_eq!(r.core.handle_request(&req("read", json!({})))["error"], "waiting_for_approval");
    assert_eq!(lock(&r.rec.asks).len(), 1);
    r.core.answer(&asks[0].id, "once").expect("answer");
    assert_eq!(r.core.handle_request(&req("read", json!({})))["ok"], true);
    // Once covers the visit: more ops on the same host do not ask again.
    assert_eq!(r.core.handle_request(&req("read", json!({})))["ok"], true);
    assert_eq!(lock(&r.rec.asks).len(), 1);
    // Moving to another host ends it.
    r.core.apply_event("p", BackendEvent::LoadFinished("https://other.test/".into()));
    assert_eq!(r.core.handle_request(&req("read", json!({})))["error"], "waiting_for_approval");
    r.core.apply_event("p", BackendEvent::LoadFinished("https://example.com/".into()));
    assert_eq!(r.core.handle_request(&req("read", json!({})))["error"], "waiting_for_approval");
    assert_eq!(lock(&r.rec.asks).len(), 3);
}

#[test]
fn site_allows_every_later_op_and_deny_answers_denied() {
    let r = rig_at("https://example.com/");
    set_eval(&r, |_| json!({"ok": true, "url": "u", "title": "t", "text": "", "outline": []}).to_string());
    r.core.handle_request(&req("read", json!({})));
    let id = lock(&r.rec.asks)[0].id.clone();
    r.core.answer(&id, "site").expect("answer");
    for _ in 0..3 {
        assert_eq!(r.core.handle_request(&req("read", json!({})))["ok"], true);
    }
    assert_eq!(r.core.allowed_hosts("p"), vec!["example.com".to_string()]);

    // A different host is denied on the next op after the operator says no.
    r.core.apply_event("p", BackendEvent::LoadFinished("https://other.test/".into()));
    r.core.handle_request(&req("click", json!({ "ref": "e1" })));
    let id = lock(&r.rec.asks)[1].id.clone();
    assert!(r.core.answer(&id, "maybe").is_err());
    r.core.answer(&id, "deny").expect("answer");
    assert_eq!(r.core.handle_request(&req("click", json!({ "ref": "e1" })))["error"], "denied");
}

#[test]
fn open_op_asks_about_the_target_host_and_localhost_never_asks() {
    let r = rig();
    let v = r.core.handle_request(&req("open", json!({ "url": "https://news.example.org/" })));
    assert_eq!(v["error"], "waiting_for_approval");
    assert_eq!(lock(&r.rec.asks)[0].host, "news.example.org");
    assert!(!r.fake.exists("p"), "nothing was opened before approval");
    for u in ["http://localhost:3000/", "http://127.0.0.1:8080/x"] {
        assert_eq!(r.core.handle_request(&req("open", json!({ "url": u })))["ok"], true, "{u}");
    }
    assert_eq!(lock(&r.rec.asks).len(), 1);
}

#[test]
fn take_over_blocks_every_op_but_state_until_given_back() {
    let r = rig_at("http://localhost:3000/");
    set_eval(&r, |_| json!({"ok": true, "url": "u", "title": "t", "text": "", "outline": []}).to_string());
    r.core.take_over("p");
    assert!(r.core.state("p").held_by_user);
    for (op, extra) in [
        ("open", json!({ "url": "http://localhost:3000/" })),
        ("read", json!({})),
        ("click", json!({ "ref": "e1" })),
        ("type", json!({ "ref": "e1", "text": "x" })),
        ("scroll", json!({ "dy": 1 })),
        ("screenshot", json!({})),
    ] {
        assert_eq!(r.core.handle_request(&req(op, extra))["error"], "held_by_user", "{op}");
    }
    let v = r.core.handle_request(&req("state", json!({})));
    assert_eq!((v["ok"].clone(), v["held_by_user"].clone()), (json!(true), json!(true)));
    assert!(lock(&r.rec.states).last().map(|s| s.held_by_user).unwrap_or(false), "take over emitted state");
    r.core.give_back("p");
    assert_eq!(r.core.handle_request(&req("read", json!({})))["ok"], true);
}

#[test]
fn the_driver_is_set_during_an_op_lingers_after_and_overlapping_ops_extend_it() {
    let r = rig_with(400);
    r.core.open("p", Some("http://localhost:3000/".into()), R).expect("open");
    assert!(r.core.wait_loaded("p", "pg1", Duration::from_secs(3)));
    let core_slot: Arc<OnceLock<Arc<BrowserCore>>> = Arc::new(OnceLock::new());
    let _ = core_slot.set(r.core.clone());
    let during = Arc::new(Mutex::new(None::<Driver>));
    let (slot, d2) = (core_slot.clone(), during.clone());
    set_eval(&r, move |_| {
        *lock(&d2) = slot.get().and_then(|c| c.state("p").driver);
        json!({"ok": true, "url": "u", "title": "t", "text": "", "outline": []}).to_string()
    });
    r.core.handle_request(&req("read", json!({})));
    let d = lock(&during).clone().expect("driver set while the op ran");
    assert_eq!((d.session.as_str(), d.label.as_str(), d.action.as_str()), ("s1", "codex-8", "reading the page"));
    assert!(d.since > 0);
    assert!(r.core.state("p").driver.is_some(), "still there right after the op");
    std::thread::sleep(Duration::from_millis(250));
    r.core.handle_request(&req("read", json!({})));
    std::thread::sleep(Duration::from_millis(250));
    assert!(r.core.state("p").driver.is_some(), "the second op carried the line past the first timer");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(r.core.state("p").driver, None, "gone after the linger");
    let last = lock(&r.rec.states).last().cloned().expect("state");
    assert_eq!(last.driver, None);
    assert_eq!(r.core.steps("p").len(), 2);
}

#[test]
fn page_events_update_state_and_emit() {
    let r = rig_at("http://localhost:3000/");
    r.core.apply_event("p", BackendEvent::LoadStarted("http://a/".into()));
    assert!(r.core.state("p").loading);
    r.core.apply_event("p", BackendEvent::Title("A".into()));
    r.core.apply_event("p", BackendEvent::LoadFinished("http://a/#x".into()));
    let st = r.core.state("p");
    assert_eq!((st.loading, st.url.as_str(), st.title.as_str()), (false, "http://a/#x", "A"));
    r.core.refresh_history("p", "pg1");
    let st = r.core.state("p");
    assert_eq!((st.can_back, st.can_forward), (true, false));
    assert!(lock(&r.rec.states).len() >= 4);
}

#[test]
fn open_command_is_idempotent_and_back_forward_reload_run_scripts() {
    let r = rig();
    let st = r.core.open("p", Some("example.com".into()), R).expect("open");
    assert_eq!(st.url, "https://example.com");
    r.core.open("p", None, Rect { x: 0.0, y: 0.0, w: 300.0, h: 200.0 }).expect("reopen");
    let calls = r.fake.calls();
    assert_eq!(calls.iter().filter(|c| c.starts_with("open ")).count(), 1);
    assert!(calls.contains(&"rect p pg1 0,0,300,200".to_string()));
    r.core.back("p", None).expect("back");
    r.core.forward("p", None).expect("forward");
    r.core.reload("p", None).expect("reload");
    let calls = r.fake.calls();
    for s in ["history.back()", "history.forward()", "location.reload()"] {
        assert!(calls.iter().any(|c| c.ends_with(s)), "{s}");
    }
    assert_eq!(r.core.navigate("p", "file:///etc/hosts", None).expect_err("file").code, "bad_request");
    r.core.set_visible("p", false).expect("hide");
    assert!(r.fake.calls().contains(&"visible p pg1 false".to_string()));
}

#[test]
fn pop_out_and_put_back_flip_the_flag_and_remember_the_frame() {
    let r = rig_at("http://localhost:3000/");
    let frame = Rect { x: 100.0, y: 50.0, w: 1200.0, h: 800.0 };
    *lock(&r.fake.frame) = Some(frame);
    r.core.pop_out("p").expect("pop out");
    assert!(r.core.state("p").popped_out);
    assert_eq!(*lock(&r.fake.popout_frames), vec![None]);
    // Rect changes while popped out must not move the window's page.
    let n = r.fake.calls().len();
    r.core.set_rect("p", R).expect("rect");
    assert_eq!(r.fake.calls().len(), n);
    r.core.put_back("p", R).expect("put back");
    assert!(!r.core.state("p").popped_out);
    r.core.pop_out("p").expect("pop out again");
    assert_eq!(lock(&r.fake.popout_frames)[1], Some(frame));
    // The window's close button arrives as an event and puts the page back at the last rect.
    r.core.apply_event("p", BackendEvent::PopoutClosed);
    for _ in 0..50 {
        if !r.core.state("p").popped_out {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!r.core.state("p").popped_out);
    assert!(r.fake.calls().iter().any(|c| c == "put_back p 800"));
}

#[test]
fn close_clears_the_page_but_keeps_take_over() {
    let r = rig_at("http://localhost:3000/");
    r.core.take_over("p");
    r.core.close("p").expect("close");
    let st = r.core.state("p");
    assert_eq!((st.url.as_str(), st.held_by_user), ("", true));
    assert!(!r.fake.exists("p"));
}

#[cfg(unix)]
#[test]
fn the_socket_serves_json_lines_with_mode_0600() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    let r = rig();
    let short = PathBuf::from(format!("/tmp/trb-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&short);
    let core = BrowserCore::new(r.fake.clone(), r.rec.clone(), HostRules::in_memory(), FrameStore::in_memory(), CoreConfig::new(short.clone()));
    let path = super::super::socket::serve(core.clone()).expect("serve");
    assert_eq!(path, short.join("browser.sock"));
    let mode = std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    // A second app must not take the socket over.
    assert!(super::super::socket::serve(core).is_err());
    let mut c = std::os::unix::net::UnixStream::connect(&path).expect("connect");
    c.write_all(b"{\"id\":\"1\",\"project\":\"p\",\"op\":\"state\"}\nnot json\n").expect("write");
    let mut rd = BufReader::new(c);
    let (mut a, mut b) = (String::new(), String::new());
    rd.read_line(&mut a).expect("line 1");
    rd.read_line(&mut b).expect("line 2");
    let a: Value = serde_json::from_str(&a).expect("json");
    let b: Value = serde_json::from_str(&b).expect("json");
    assert_eq!((a["id"].clone(), a["ok"].clone()), (json!("1"), json!(true)));
    assert_eq!(b["error"], "bad_request");
    super::super::socket::remove(&short);
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&short);
}

// ---- wave 2: pages ------------------------------------------------------------------------

fn wait_for(what: &str, f: impl Fn() -> bool) {
    for _ in 0..100 {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn pages_lifecycle_and_the_top_level_fields_mirror_the_active_page() {
    let r = rig_at("http://localhost:3000/");
    let id2 = r.core.create_page("p", Some("http://localhost:4000/x"), false, true).expect("new page");
    assert_eq!(id2, "pg2");
    wait_for("pg2 load", || !r.core.state("p").loading);
    let st = r.core.state("p");
    assert_eq!((st.pages.len(), st.active_page.as_str(), st.url.as_str()), (2, "pg2", "http://localhost:4000/x"));
    assert_eq!(st.pages[0].url, "http://localhost:3000/");
    // only the active page is shown
    assert_eq!(r.fake.last("visible p pg1").as_deref(), Some("visible p pg1 false"));
    r.core.select_page("p", "pg1").expect("select");
    let st = r.core.state("p");
    assert_eq!((st.active_page.as_str(), st.url.as_str()), ("pg1", "http://localhost:3000/"));
    assert_eq!(r.fake.last("visible p pg1").as_deref(), Some("visible p pg1 true"));
    assert_eq!(r.fake.last("visible p pg2").as_deref(), Some("visible p pg2 false"));
    assert_eq!(r.core.select_page("p", "nope").expect_err("unknown").code, "not_found");
    // closing the active page falls back to a neighbour
    r.core.close_page("p", "pg1").expect("close");
    let st = r.core.state("p");
    assert_eq!((st.pages.len(), st.active_page.as_str()), (1, "pg2"));
    assert!(r.fake.calls().contains(&"close_page p pg1".to_string()));
    assert!(lock(&r.rec.states).last().map(|s| s.pages.len() == 1).unwrap_or(false), "state emitted");
}

#[test]
fn closing_the_last_page_is_nothing_open_and_a_navigate_opens_a_fresh_one() {
    let r = rig_at("http://localhost:3000/");
    r.core.take_over("p");
    r.core.close_page("p", "pg1").expect("close");
    let st = r.core.state("p");
    assert_eq!((st.url.as_str(), st.active_page.as_str(), st.pages.len(), st.held_by_user), ("", "", 0, true));
    assert_eq!(r.core.back("p", None).expect_err("nothing").code, "not_found");
    r.core.navigate("p", "http://localhost:3000/again", None).expect("navigate opens");
    assert_eq!(r.core.state("p").active_page, "pg2");
}

#[test]
fn a_site_popup_opens_a_new_page_and_window_close_closes_only_popups() {
    let r = rig_at("http://localhost:3000/");
    r.core.apply_event("p", BackendEvent::NewWindow("javascript:alert(1)".into()));
    r.core.apply_event("p", BackendEvent::NewWindow("https://accounts.example/login".into()));
    wait_for("popup page", || r.core.state("p").pages.len() == 2);
    let st = r.core.state("p");
    assert_eq!((st.active_page.as_str(), st.pages[1].url.as_str()), ("pg2", "https://accounts.example/login"));
    assert!(r.fake.calls().iter().any(|c| c.starts_with("open p pg2 https://accounts.example/login") && c.contains("popup=true")));
    // window.close() on the opener (not a popup) does nothing
    r.core.apply_page_event("p", "pg1", BackendEvent::CloseRequested);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(r.core.state("p").pages.len(), 2);
    r.core.apply_page_event("p", "pg2", BackendEvent::CloseRequested);
    wait_for("popup closed", || r.core.state("p").pages.len() == 1);
    assert_eq!(r.core.state("p").active_page, "pg1");
}

#[test]
fn events_from_a_page_that_is_gone_are_ignored() {
    let r = rig_at("http://localhost:3000/");
    r.core.apply_page_event("p", "pg9", BackendEvent::LoadStarted("http://ghost/".into()));
    assert_eq!(r.core.state("p").url, "http://localhost:3000/");
}

// ---- wave 2: B5 ---------------------------------------------------------------------------

#[test]
fn zoom_clamps_resets_and_persists_per_project() {
    let dir = std::env::temp_dir().join(format!("trantor-prefs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let fake = Arc::new(Fake::default());
    let mk = || {
        let cfg = CoreConfig { data_dir: Some(dir.clone()), ..CoreConfig::new(dir.join("bus")) };
        BrowserCore::new(fake.clone(), Arc::new(Rec::default()), HostRules::in_memory(), FrameStore::in_memory(), cfg)
    };
    let core = mk();
    core.open("p", Some("http://localhost:3000/".into()), R).expect("open");
    core.zoom("p", Some(10.0)).expect("zoom");
    assert_eq!(core.state("p").zoom, 3.0);
    assert_eq!(fake.last("zoom p pg1").as_deref(), Some("zoom p pg1 3.000"));
    core.zoom("p", Some(0.1)).expect("zoom");
    assert_eq!(core.state("p").zoom, 0.3);
    core.zoom("p", Some(1.5)).expect("zoom");
    core.set_user_agent("p", Some("chrome")).expect("ua");
    core.emulate("p", device::preset("Laptop")).expect("emulate");
    let again = mk();
    let st = again.state("p");
    assert_eq!((st.zoom, st.user_agent.as_str(), st.emulation.map(|d| d.name)), (1.5, "Chrome", Some("Laptop".to_string())));
    assert_eq!(again.state("other").zoom, 1.0);
    core.emulate("p", None).expect("end emulation");
    core.zoom("p", None).expect("reset");
    assert_eq!(core.state("p").zoom, 1.0);
    assert_eq!(fake.last("zoom p pg1").as_deref(), Some("zoom p pg1 1.000"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn emulation_letterboxes_scales_with_zoom_and_restores() {
    let r = rig_at("http://localhost:3000/");
    // R is 800x500 at (10,20); an iPhone 15 is 393x852, so it scales to 500/852
    r.core.emulate("p", device::preset("iPhone 15")).expect("emulate");
    let scale = 500.0 / 852.0;
    let w = 393.0 * scale;
    let want = format!("rect p pg1 {},{},{},{}", 10.0 + (800.0 - w) / 2.0, 20.0, w, 500.0);
    assert_eq!(r.fake.last("rect p pg1"), Some(want));
    assert_eq!(r.fake.last("zoom p pg1"), Some(format!("zoom p pg1 {scale:.3}")));
    assert_eq!(r.core.state("p").emulation.map(|d| d.name), Some("iPhone 15".to_string()));
    // the tab resizing re-letterboxes
    r.core.set_rect("p", Rect { x: 0.0, y: 0.0, w: 1000.0, h: 1000.0 }).expect("rect");
    assert_eq!(r.fake.last("rect p pg1"), Some("rect p pg1 303.5,74,393,852".to_string()));
    assert_eq!(r.fake.last("zoom p pg1"), Some("zoom p pg1 1.000".to_string()));
    // zoom multiplies with the fit scale
    r.core.zoom("p", Some(2.0)).expect("zoom");
    assert_eq!(r.fake.last("zoom p pg1"), Some("zoom p pg1 2.000".to_string()));
    // ending emulation restores the full rect
    r.core.emulate("p", None).expect("end");
    assert_eq!(r.fake.last("rect p pg1"), Some("rect p pg1 0,0,1000,1000".to_string()));
    assert_eq!(r.core.state("p").emulation, None);
    assert_eq!(r.core.emulate("p", Some(device::custom(5.0, 5.0))).expect_err("tiny").code, "bad_request");
}

#[test]
fn a_mobile_device_switches_the_user_agent_until_emulation_ends() {
    let r = rig_at("http://localhost:3000/");
    let ua_calls = || r.fake.calls().iter().filter(|c| c.starts_with("ua p pg1")).cloned().collect::<Vec<_>>();
    let reloads = || r.fake.calls().iter().filter(|c| c.ends_with("location.reload()")).count();
    r.core.emulate("p", device::preset("iPhone 15")).expect("emulate");
    assert!(ua_calls()[0].contains("iPhone;") && ua_calls().len() == 1);
    assert_eq!(reloads(), 1);
    r.core.set_user_agent("p", Some("Chrome")).expect("ua");
    assert_eq!(ua_calls().len(), 1, "the phone's UA stays while emulating");
    r.core.emulate("p", device::preset("Laptop")).expect("laptop");
    assert!(ua_calls()[1].contains("Chrome/") && !ua_calls()[1].contains("Mobile"));
    r.core.emulate("p", device::preset("Pixel 8")).expect("pixel");
    assert!(ua_calls()[2].contains("Android"));
    r.core.emulate("p", None).expect("end");
    assert!(ua_calls()[3].contains("Chrome/"), "restored to the operator's choice");
    assert_eq!(r.core.state("p").user_agent, "Chrome");
}

#[test]
fn user_agent_presets_apply_reload_and_reset_to_safari() {
    let r = rig_at("http://localhost:3000/");
    assert_eq!(r.core.state("p").user_agent, "Safari");
    assert_eq!(r.core.set_user_agent("p", Some("netscape")).expect_err("unknown").code, "bad_request");
    r.core.set_user_agent("p", Some("Firefox")).expect("ua");
    assert!(r.fake.last("ua p pg1").is_some_and(|c| c.contains("Firefox/")));
    assert!(r.fake.last("script p pg1").is_some_and(|c| c.ends_with("location.reload()")));
    let n = r.fake.calls().len();
    r.core.set_user_agent("p", Some("Firefox")).expect("same");
    assert_eq!(r.fake.calls().len(), n, "no change, no reload");
    r.core.set_user_agent("p", None).expect("reset");
    assert!(r.fake.last("ua p pg1").is_some_and(|c| c.contains("Version/18.5 Safari")));
    assert_eq!(r.core.state("p").user_agent, "Safari");
}

#[test]
fn find_inspect_and_find_clear_reach_the_page() {
    let r = rig_at("http://localhost:3000/");
    r.fake.found.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(r.core.find("p", "domain", false, None).expect("find"));
    assert_eq!(r.fake.last("find p").as_deref(), Some("find p pg1 domain false"));
    assert!(!r.core.find("p", "", false, None).expect("empty find clears"));
    assert_eq!(r.fake.last("find_clear").as_deref(), Some("find_clear p pg1"));
    r.core.find_clear("p", Some("pg1")).expect("clear");
    r.core.inspect("p", None).expect("inspect");
    assert_eq!(r.fake.last("inspect").as_deref(), Some("inspect p pg1"));
    assert_eq!(r.core.find("p", "x", true, Some("pg7")).expect_err("page").code, "not_found");
}

#[test]
fn history_is_newest_first_deduped_titled_and_capped_at_500() {
    let r = rig_at("http://localhost:3000/");
    for i in 0..520 {
        r.core.apply_event("p", BackendEvent::LoadFinished(format!("http://localhost:3000/{i}")));
    }
    let h = r.core.history("p");
    assert_eq!(h.len(), 500);
    assert_eq!(h[0].url, "http://localhost:3000/519");
    assert_eq!(h[499].url, "http://localhost:3000/20");
    r.core.apply_event("p", BackendEvent::LoadFinished("http://localhost:3000/519".into()));
    assert_eq!(r.core.history("p").len(), 500, "a repeat of the newest url does not add a row");
    r.core.apply_event("p", BackendEvent::Title("Late title".into()));
    assert_eq!(r.core.history("p")[0].title, "Late title");
    assert!(r.core.history("other").is_empty());
    r.core.apply_event("p", BackendEvent::LoadFinished("about:blank".into()));
    assert_eq!(r.core.history("p")[0].url, "http://localhost:3000/519");
}

#[test]
fn favorites_toggle_on_and_off_per_project() {
    let r = rig();
    assert!(r.core.favorite_toggle("p", "https://a.test/", "A"));
    assert!(r.core.favorite_toggle("p", "https://b.test/", "B"));
    assert_eq!(r.core.favorites("p").iter().map(|f| f.url.as_str()).collect::<Vec<_>>(), vec!["https://a.test/", "https://b.test/"]);
    assert!(!r.core.favorite_toggle("p", "https://a.test/", "A"));
    assert_eq!(r.core.favorites("p"), vec![Favorite { url: "https://b.test/".into(), title: "B".into() }]);
    assert!(r.core.favorites("q").is_empty());
}

#[test]
fn permissions_list_the_allowed_hosts_and_revoke_asks_again() {
    let r = rig_at("https://example.com/");
    set_eval(&r, |_| json!({"ok": true, "url": "u", "title": "t", "text": "", "outline": []}).to_string());
    r.core.handle_request(&req("read", json!({})));
    let id = lock(&r.rec.asks)[0].id.clone();
    r.core.answer(&id, "site").expect("answer");
    assert_eq!(r.core.permissions("p"), vec![Permission { host: "example.com".into(), rule: "site".into() }]);
    assert_eq!(r.core.handle_request(&req("read", json!({})))["ok"], true);
    r.core.permission_revoke("p", "Example.com");
    assert!(r.core.permissions("p").is_empty());
    assert_eq!(r.core.handle_request(&req("read", json!({})))["error"], "waiting_for_approval");
}

#[test]
fn clear_storage_wipes_the_store_then_reloads_every_page() {
    let r = rig_at("http://localhost:3000/");
    r.core.create_page("p", Some("http://localhost:3000/b"), false, true).expect("second");
    r.core.clear_storage("p").expect("clear");
    let calls = r.fake.calls();
    let at = calls.iter().position(|c| c == "clear_storage p").expect("cleared");
    let after = &calls[at..];
    assert!(after.iter().any(|c| c.starts_with("script p pg1") && c.ends_with("location.reload()")));
    assert!(after.iter().any(|c| c.starts_with("script p pg2") && c.ends_with("location.reload()")));
}

// ---- wave 2: socket ops ---------------------------------------------------------------------

#[test]
fn pages_new_page_select_and_close_over_the_socket() {
    let r = rig_at("http://localhost:3000/");
    let v = r.core.handle_request(&req("new_page", json!({ "url": "http://localhost:3000/two" })));
    assert_eq!((v["ok"].clone(), v["page"].clone(), v["url"].clone()), (json!(true), json!("pg2"), json!("http://localhost:3000/two")));
    // the agent is named on the page it opened
    let st = r.core.state("p");
    assert_eq!(st.pages[1].driver.as_ref().map(|d| d.label.as_str()), Some("codex-8"));
    assert_eq!(st.pages[0].driver, None);
    let v = r.core.handle_request(&req("pages", json!({})));
    assert_eq!((v["pages"].as_array().map(Vec::len), v["active_page"].clone()), (Some(2), json!("pg2")));
    assert_eq!(r.core.handle_request(&req("select_page", json!({ "page": "pg1" })))["ok"], true);
    assert_eq!(r.core.state("p").url, "http://localhost:3000/");
    assert_eq!(r.core.handle_request(&req("select_page", json!({})))["error"], "bad_request");
    assert_eq!(r.core.handle_request(&req("close_page", json!({ "page": "pg9" })))["error"], "not_found");
    assert_eq!(r.core.handle_request(&req("close_page", json!({ "page": "pg2" })))["ok"], true);
    assert_eq!(r.core.handle_request(&req("close_page", json!({ "page": "pg1" })))["ok"], true);
    assert_eq!(r.core.handle_request(&req("pages", json!({})))["active_page"], "");
    // a blank new page has no url; a host that is not allowed asks first
    assert_eq!(r.core.handle_request(&req("new_page", json!({})))["ok"], true);
    assert_eq!(r.core.state("p").url, "");
    assert_eq!(r.core.handle_request(&req("new_page", json!({ "url": "https://news.example.org/" })))["error"], "waiting_for_approval");
}

#[test]
fn the_page_argument_targets_a_page_and_unknown_pages_are_not_found() {
    let r = rig_at("http://localhost:3000/");
    r.core.create_page("p", Some("http://localhost:3000/b"), false, true).expect("second");
    wait_for("load", || !r.core.state("p").loading);
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let s2 = seen.clone();
    let core2 = r.core.clone();
    set_eval(&r, move |_| {
        lock(&s2).push(core2.state("p").pages.iter().map(|p| p.driver.is_some().to_string()).collect::<Vec<_>>().join(","));
        json!({"ok": true, "url": "u", "title": "t", "text": "", "outline": []}).to_string()
    });
    assert_eq!(r.core.handle_request(&req("read", json!({ "page": "pg1" })))["ok"], true);
    // while the op ran the driver sat on pg1 only
    assert_eq!(lock(&seen)[0], "true,false");
    assert_eq!(r.core.handle_request(&req("read", json!({ "page": "pg8" })))["error"], "not_found");
}

#[test]
fn back_forward_and_reload_ops_run_scripts_on_the_page() {
    let r = rig_at("http://localhost:3000/");
    for (op, js) in [("back", "history.back()"), ("forward", "history.forward()"), ("reload", "location.reload()")] {
        assert_eq!(r.core.handle_request(&req(op, json!({})))["ok"], true, "{op}");
        assert_eq!(r.fake.last("script p pg1").as_deref(), Some(format!("script p pg1 {js}").as_str()));
    }
    r.core.take_over("p");
    assert_eq!(r.core.handle_request(&req("back", json!({})))["error"], "held_by_user");
}

#[test]
fn resize_takes_a_preset_name_a_device_object_w_and_h_or_nothing() {
    let r = rig_at("http://localhost:3000/");
    let v = r.core.handle_request(&req("resize", json!({ "device": "iphone 15" })));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["emulation"]["name"], "iPhone 15");
    assert_eq!(r.core.state("p").emulation.map(|d| (d.w, d.h, d.mobile)), Some((393.0, 852.0, true)));
    let v = r.core.handle_request(&req("resize", json!({ "device": { "name": "Fold", "w": 600, "h": 700, "mobile": true } })));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(r.core.state("p").emulation.map(|d| d.name), Some("Fold".to_string()));
    let v = r.core.handle_request(&req("resize", json!({ "w": 640, "h": 480 })));
    assert_eq!(v["ok"], true);
    assert_eq!(r.core.state("p").emulation.map(|d| (d.w, d.h, d.mobile)), Some((640.0, 480.0, false)));
    assert_eq!(r.core.handle_request(&req("resize", json!({ "device": "Nokia 3310" })))["error"], "bad_request");
    assert_eq!(r.core.handle_request(&req("resize", json!({ "w": 640 })))["error"], "bad_request");
    assert_eq!(r.core.handle_request(&req("resize", json!({ "device": { "w": 1 } })))["error"], "bad_request");
    let v = r.core.handle_request(&req("resize", json!({})));
    assert_eq!((v["ok"].clone(), v["emulation"].clone()), (json!(true), Value::Null));
    assert_eq!(r.core.state("p").emulation, None);
}

#[test]
fn evaluate_always_asks_once_per_host_and_returns_json() {
    let r = rig_at("https://example.com/");
    set_eval(&r, |js| {
        assert!(js.contains("history.pushState"), "{js}");
        json!({"ok": true, "value": {"a": [1, null]}}).to_string()
    });
    let ev = || r.core.handle_request(&req("evaluate", json!({ "script": "history.pushState({}, '', '/spa-test');" })));
    // the page's host is not allowed yet: the ordinary ask comes first
    assert_eq!(ev()["error"], "waiting_for_approval");
    let id = lock(&r.rec.asks)[0].id.clone();
    assert!(lock(&r.rec.asks)[0].kind.is_none());
    r.core.answer(&id, "site").expect("allow the host");
    // an allowed host still asks for the script, with its own ask
    assert_eq!(ev()["error"], "waiting_for_approval");
    let ask = lock(&r.rec.asks)[1].clone();
    assert_eq!((ask.host.as_str(), ask.kind.as_deref()), ("example.com", Some("evaluate")));
    assert_eq!(ev()["error"], "waiting_for_approval");
    assert_eq!(lock(&r.rec.asks).len(), 2, "one open ask at a time");
    r.core.answer(&ask.id, "once").expect("answer");
    let v = ev();
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["value"], json!({"a": [1, null]}));
    assert_eq!(ev()["ok"], true, "once covers the visit");
    // another host ends the visit (the drive ask comes first there)
    r.core.apply_event("p", BackendEvent::LoadFinished("https://other.test/".into()));
    assert_eq!(ev()["error"], "waiting_for_approval");
    r.core.apply_event("p", BackendEvent::LoadFinished("https://example.com/".into()));
    assert_eq!(ev()["error"], "waiting_for_approval");
    assert_eq!(lock(&r.rec.asks).last().and_then(|a| a.kind.clone()).as_deref(), Some("evaluate"));
}

#[test]
fn evaluate_deny_localhost_and_script_errors() {
    let r = rig_at("https://example.com/");
    set_eval(&r, |_| json!({"ok": true, "value": 1}).to_string());
    r.core.handle_request(&req("read", json!({})));
    let id = lock(&r.rec.asks)[0].id.clone();
    r.core.answer(&id, "site").expect("allow");
    let ev = |s: &str| r.core.handle_request(&req("evaluate", json!({ "script": s })));
    assert_eq!(ev("1")["error"], "waiting_for_approval");
    let id = lock(&r.rec.asks)[1].id.clone();
    r.core.answer(&id, "deny").expect("deny");
    assert_eq!(ev("1")["error"], "denied");
    assert_eq!(ev("1")["error"], "waiting_for_approval", "asks again after a denial");
    assert_eq!(r.core.handle_request(&req("evaluate", json!({})))["error"], "bad_request");
    // localhost never asks; a script failure comes back as bad_request with the page's words
    let l = rig_at("http://localhost:3000/");
    set_eval(&l, |_| json!({"ok": false, "error": "script_error", "message": "boom is not defined"}).to_string());
    let v = l.core.handle_request(&req("evaluate", json!({ "script": "boom" })));
    assert_eq!((v["error"].clone(), v["message"].clone()), (json!("bad_request"), json!("boom is not defined")));
}

#[test]
fn evaluate_falls_back_to_eval_when_the_script_is_not_an_expression() {
    let r = rig_at("http://localhost:3000/");
    let n = Arc::new(Mutex::new(0u32));
    let n2 = n.clone();
    set_eval(&r, move |js| {
        let mut c = lock(&n2);
        *c += 1;
        if *c == 1 {
            assert!(js.contains("var v=(var x = 1; x)"), "expression attempt first");
            return String::new(); // a syntax error gives the callback nothing
        }
        assert!(js.contains("(0,eval)(\"var x = 1; x\")"), "{js}");
        json!({"ok": true, "value": 1}).to_string()
    });
    let v = r.core.handle_request(&req("evaluate", json!({ "script": "var x = 1; x" })));
    assert_eq!((v["ok"].clone(), v["value"].clone()), (json!(true), json!(1)));
}

// ---- wave 2: the two live-drill bugs ----------------------------------------------------------

#[test]
fn a_page_that_loads_hidden_still_finishes_through_the_webviews_own_state() {
    let r = rig();
    r.fake.mute_loads.store(true, std::sync::atomic::Ordering::SeqCst);
    r.core.create_page("p", Some("http://localhost:3000/"), false, true).expect("page");
    assert!(r.core.state("p").loading);
    let idle = BackendEvent::Observed { url: None, title: None, loading: false, can_back: None, can_forward: None };
    // a sample taken before the navigation started is stale inside the settle window
    r.core.apply_page_event("p", "pg1", idle.clone());
    assert!(r.core.state("p").loading, "stale sample ignored");
    std::thread::sleep(Duration::from_millis(80));
    r.core.apply_page_event("p", "pg1", idle);
    assert!(!r.core.state("p").loading);
    assert!(r.core.wait_loaded("p", "pg1", Duration::from_millis(10)));
    assert_eq!(r.core.history("p")[0].url, "http://localhost:3000/");
}

#[test]
fn the_open_op_returns_when_only_the_webview_says_the_page_loaded() {
    let r = rig();
    r.fake.mute_loads.store(true, std::sync::atomic::Ordering::SeqCst);
    let core = r.core.clone();
    let poker = std::thread::spawn(move || {
        // like the backend's sampler: first it sees the load running, later not
        std::thread::sleep(Duration::from_millis(100));
        core.apply_page_event("p", "pg1", BackendEvent::Observed { url: Some("http://localhost:5173/".into()), title: Some("Home".into()), loading: true, can_back: None, can_forward: None });
        std::thread::sleep(Duration::from_millis(100));
        core.apply_page_event("p", "pg1", BackendEvent::Observed { url: None, title: None, loading: false, can_back: Some(true), can_forward: None });
    });
    let started = Instant::now();
    let v = r.core.handle_request(&req("open", json!({ "url": "http://localhost:5173/" })));
    poker.join().expect("poker");
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!((v["url"].as_str(), v["title"].as_str()), (Some("http://localhost:5173/"), Some("Home")));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(r.core.state("p").can_back);
}

#[test]
fn single_page_app_url_and_title_changes_are_reported() {
    let r = rig_at("https://crebral.health/");
    std::thread::sleep(Duration::from_millis(100)); // the load's own history refresh settles
    let before = lock(&r.rec.states).len();
    let ev = BackendEvent::Observed { url: Some("https://crebral.health/dashboard".into()), title: Some("Dashboard".into()), loading: false, can_back: Some(true), can_forward: None };
    r.core.apply_page_event("p", "pg1", ev);
    let st = r.core.state("p");
    assert_eq!((st.url.as_str(), st.title.as_str(), st.can_back, st.loading), ("https://crebral.health/dashboard", "Dashboard", true, false));
    assert_eq!(st.pages[0].url, "https://crebral.health/dashboard");
    assert!(lock(&r.rec.states).len() > before, "browser://state was emitted");
    assert_eq!(r.core.history("p")[0].url, "https://crebral.health/dashboard");
    // an unchanged sample is not a change: no event, no new history row
    let (n, rows) = (lock(&r.rec.states).len(), r.core.history("p").len());
    r.core.apply_page_event("p", "pg1", BackendEvent::Observed { url: None, title: None, loading: false, can_back: None, can_forward: None });
    assert_eq!((lock(&r.rec.states).len(), r.core.history("p").len()), (n, rows));
    // the blank page never overwrites a real url
    r.core.apply_page_event("p", "pg1", BackendEvent::Observed { url: Some("about:blank".into()), title: None, loading: false, can_back: None, can_forward: None });
    assert_eq!(r.core.state("p").url, "https://crebral.health/dashboard");
}

#[test]
fn a_new_page_made_while_the_tab_is_hidden_reveals_it_and_shows_when_the_tab_does() {
    let r = rig();
    let v = r.core.handle_request(&req("new_page", json!({ "url": "http://localhost:3000/" })));
    assert_eq!(v["ok"], true);
    assert_eq!(*lock(&r.rec.reveals), vec!["p".to_string()]);
    assert!(r.fake.calls()[0].contains("visible=false"));
    r.core.set_visible("p", true).expect("tab shown");
    assert_eq!(r.fake.last("visible p pg1").as_deref(), Some("visible p pg1 true"));
}

// ---- pages survive a relaunch (#14522) ---------------------------------------------------------

/// A rig whose stores live in `dir`, so a second rig on the same dir is a relaunch.
fn rig_on(dir: &std::path::Path) -> Rig {
    let bus = dir.join("bus");
    let fake = Arc::new(Fake::default());
    let rec = Arc::new(Rec::default());
    let mut cfg = CoreConfig::new(bus.clone());
    cfg.data_dir = Some(dir.join("data"));
    cfg.linger = Duration::from_millis(40);
    cfg.load_timeout = Duration::from_secs(3);
    cfg.settle = Duration::from_millis(60);
    let core = BrowserCore::new(fake.clone(), rec.clone(), HostRules::in_memory(), FrameStore::in_memory(), cfg);
    Rig { core, fake, rec, bus }
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("trantor-restore-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn saved(dir: &std::path::Path, project: &str) -> SavedPages {
    Store::<SavedPages>::load(dir.join("data").join("pages.json")).get(project)
}

fn opens(r: &Rig) -> usize {
    r.fake.calls().iter().filter(|c| c.starts_with("open ")).count()
}

/// Two pages, the first selected, then a "relaunch".
fn relaunched(name: &str) -> (PathBuf, Rig) {
    let dir = tmp(name);
    let a = rig_on(&dir);
    a.core.create_page("p", Some("http://localhost:3000/a"), false, true).expect("a");
    a.core.create_page("p", Some("http://localhost:3000/b"), false, true).expect("b");
    a.core.select_page("p", "pg1").expect("select");
    drop(a);
    let b = rig_on(&dir);
    (dir, b)
}

#[test]
fn the_page_list_is_saved_on_new_select_and_close() {
    let dir = tmp("save");
    let r = rig_on(&dir);
    r.core.create_page("p", Some("http://localhost:3000/a"), false, true).expect("a");
    assert_eq!(saved(&dir, "p").pages.len(), 1);
    r.core.create_page("p", Some("http://localhost:3000/b"), false, true).expect("b");
    let s = saved(&dir, "p");
    assert_eq!((s.pages.len(), s.active), (2, 1));
    r.core.select_page("p", "pg1").expect("select");
    assert_eq!(saved(&dir, "p").active, 0);
    r.core.close_page("p", "pg1").expect("close");
    let s = saved(&dir, "p");
    assert_eq!((s.pages.iter().map(|p| p.url.as_str()).collect::<Vec<_>>(), s.active), (vec!["http://localhost:3000/b"], 0));
}

#[test]
fn a_relaunch_lists_the_saved_pages_without_creating_webviews() {
    let (_dir, b) = relaunched("list");
    let st = b.core.state("p");
    assert_eq!(st.pages.len(), 2);
    assert!(st.pages.iter().all(|p| p.restored && !p.loading));
    assert_eq!((st.active_page.as_str(), st.url.as_str()), ("pg1", "http://localhost:3000/a"));
    assert_eq!(opens(&b), 0);
    // listing over the socket and answering state do not create them either
    assert_eq!(b.core.handle_request(&req("pages", json!({})))["pages"].as_array().map(Vec::len), Some(2));
    b.core.handle_request(&req("state", json!({})));
    b.core.set_visible("p", true).expect("visible");
    b.core.set_rect("p", R).expect("rect");
    assert_eq!(opens(&b), 0);
}

#[test]
fn opening_the_tab_creates_the_saved_pages_active_first_rest_hidden() {
    let (_dir, b) = relaunched("open");
    let st = b.core.open("p", None, R).expect("open");
    let calls: Vec<String> = b.fake.calls().into_iter().filter(|c| c.starts_with("open ")).collect();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].contains(" pg1 http://localhost:3000/a "), "{calls:?}");
    // created hidden, then the tab's visibility shows the active one only
    assert_eq!(b.fake.last("visible p pg1").as_deref(), Some("visible p pg1 true"));
    assert!(b.fake.last("visible p pg2").is_none());
    assert!(calls[1].contains(" pg2 http://localhost:3000/b ") && calls[1].contains("visible=false"), "{calls:?}");
    assert!(st.pages.iter().all(|p| !p.restored));
    assert_eq!(st.active_page, "pg1");
    // a second open creates nothing more
    b.core.open("p", None, R).expect("again");
    assert_eq!(opens(&b), 2);
}

#[test]
fn the_first_agent_op_creates_the_saved_pages_and_reveals_the_tab() {
    let (_dir, b) = relaunched("agent");
    set_eval(&b, |_| r#"{"ok":true}"#.to_string());
    let v = b.core.handle_request(&req("scroll", json!({ "dy": 10 })));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(opens(&b), 2);
    assert!(b.fake.calls().iter().any(|c| c.starts_with("open p pg1 ")), "the active page is first");
    assert_eq!(*lock(&b.rec.reveals), vec!["p".to_string()]);
}

#[test]
fn a_new_page_after_a_relaunch_brings_the_saved_ones_too() {
    let (dir, b) = relaunched("newpage");
    b.core.create_page("p", Some("http://localhost:3000/c"), false, true).expect("c");
    assert_eq!(opens(&b), 3);
    assert_eq!(saved(&dir, "p").pages.len(), 3);
}

#[test]
fn closing_an_unloaded_page_needs_no_webview() {
    let (dir, b) = relaunched("closeunloaded");
    b.core.close_page("p", "pg2").expect("close");
    assert_eq!((opens(&b), b.fake.last("close_page").is_none()), (0, true));
    assert_eq!(saved(&dir, "p").pages.len(), 1);
}

#[test]
fn popups_and_blank_pages_are_not_saved() {
    let dir = tmp("popup");
    let r = rig_on(&dir);
    r.core.create_page("p", Some("http://localhost:3000/a"), false, true).expect("a");
    r.core.create_page("p", Some("http://localhost:3000/signin"), true, false).expect("popup");
    r.core.create_page("p", None, false, true).expect("blank");
    let s = saved(&dir, "p");
    assert_eq!(s.pages.iter().map(|p| p.url.as_str()).collect::<Vec<_>>(), vec!["http://localhost:3000/a"]);
    // a hand-edited file with a blank url drops that entry on load
    let file = dir.join("data").join("pages.json");
    std::fs::write(&file, r#"{"p":{"pages":[{"url":"","title":"x"},{"url":"http://localhost:3000/z","title":"Z"}],"active":1}}"#).expect("write");
    let b = rig_on(&dir);
    let st = b.core.state("p");
    assert_eq!(st.pages.len(), 1);
    assert_eq!(st.url, "http://localhost:3000/z");
}

#[test]
fn closing_the_last_page_clears_the_saved_list() {
    let dir = tmp("last");
    let r = rig_on(&dir);
    r.core.create_page("p", Some("http://localhost:3000/a"), false, true).expect("a");
    r.core.create_page("p", Some("http://localhost:3000/b"), false, true).expect("b");
    r.core.close_page("p", "pg2").expect("close b");
    assert_eq!(saved(&dir, "p").pages.len(), 1);
    r.core.close_page("p", "pg1").expect("close a");
    assert_eq!(saved(&dir, "p"), SavedPages::default());
    assert!(rig_on(&dir).core.state("p").pages.is_empty());
    // closing the whole browser clears it too
    r.core.create_page("p", Some("http://localhost:3000/c"), false, true).expect("c");
    r.core.close("p").expect("close");
    assert!(saved(&dir, "p").pages.is_empty());
}
