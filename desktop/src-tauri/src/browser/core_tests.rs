use super::super::hosts::{FrameStore, HostRules};
use super::*;
use std::sync::OnceLock;

type EvalHook = Box<dyn Fn(&str) -> String + Send + Sync>;

#[derive(Default)]
struct Fake {
    pages: Mutex<Vec<String>>,
    calls: Mutex<Vec<String>>,
    sink: Mutex<Option<Sink>>,
    eval: Mutex<Option<EvalHook>>,
    frame: Mutex<Option<Rect>>,
    popout_frames: Mutex<Vec<Option<Rect>>>,
}

impl Fake {
    fn log(&self, s: String) {
        lock(&self.calls).push(s);
    }
    fn calls(&self) -> Vec<String> {
        lock(&self.calls).clone()
    }
    /// Simulates a page load finishing a moment after navigation starts.
    fn load(&self, project: &str, url: &str) {
        let sink = lock(&self.sink).clone();
        let (p, u) = (project.to_string(), url.to_string());
        if let Some(s) = sink {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                s(&p, BackendEvent::Title("Example".into()));
                s(&p, BackendEvent::LoadFinished(u));
            });
        }
    }
}

impl Backend for Fake {
    fn set_sink(&self, sink: Sink) {
        *lock(&self.sink) = Some(sink);
    }
    fn exists(&self, project: &str) -> bool {
        lock(&self.pages).iter().any(|p| p == project)
    }
    fn open(&self, project: &str, url: &str, rect: Rect, visible: bool) -> BrowserResult<()> {
        self.log(format!("open {project} {url} {} visible={visible}", rect.w));
        lock(&self.pages).push(project.to_string());
        self.load(project, url);
        Ok(())
    }
    fn set_rect(&self, project: &str, rect: Rect) -> BrowserResult<()> {
        self.log(format!("rect {project} {},{},{},{}", rect.x, rect.y, rect.w, rect.h));
        Ok(())
    }
    fn set_visible(&self, project: &str, visible: bool) -> BrowserResult<()> {
        self.log(format!("visible {project} {visible}"));
        Ok(())
    }
    fn navigate(&self, project: &str, url: &str) -> BrowserResult<()> {
        self.log(format!("navigate {project} {url}"));
        self.load(project, url);
        Ok(())
    }
    fn eval(&self, _: &str, js: &str, _: Duration) -> BrowserResult<String> {
        let g = lock(&self.eval);
        match g.as_ref() {
            Some(f) => Ok(f(js)),
            None => Err(BrowserError::new("timeout", "no eval hook")),
        }
    }
    fn run_script(&self, project: &str, js: &str) -> BrowserResult<()> {
        self.log(format!("script {project} {js}"));
        Ok(())
    }
    fn history(&self, _: &str) -> (bool, bool) {
        (true, false)
    }
    fn snapshot(&self, _: &str, clip: Option<Rect>) -> BrowserResult<Vec<u8>> {
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
    fn close(&self, project: &str) -> BrowserResult<Option<Rect>> {
        lock(&self.pages).retain(|p| p != project);
        Ok(None)
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
    assert!(r.core.wait_loaded("p", Duration::from_secs(3)));
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
    for k in ["project", "url", "title", "loading", "can_back", "can_forward", "popped_out", "driver", "held_by_user"] {
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
    assert!(r.fake.calls().iter().any(|c| c == "navigate p http://localhost:5173/next"));
    assert!(lock(&r.rec.states).iter().any(|s| s.loading), "loading state was emitted");
}

#[test]
fn open_times_out_when_the_page_never_finishes() {
    let r = rig();
    let mut cfg = CoreConfig::new(r.bus.clone());
    cfg.load_timeout = Duration::from_millis(100);
    let core = BrowserCore::new(r.fake.clone(), r.rec.clone(), HostRules::in_memory(), FrameStore::in_memory(), cfg);
    // The fake only reports loads through its sink; with none attached the page never finishes.
    *lock(&r.fake.sink) = None;
    let v = core.handle_request(&req("open", json!({ "url": "http://localhost:1/" })));
    assert_eq!(v["error"], "timeout");
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
    let r = rig_with(150);
    r.core.open("p", Some("http://localhost:3000/".into()), R).expect("open");
    assert!(r.core.wait_loaded("p", Duration::from_secs(3)));
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
    std::thread::sleep(Duration::from_millis(100));
    r.core.handle_request(&req("read", json!({})));
    std::thread::sleep(Duration::from_millis(100));
    assert!(r.core.state("p").driver.is_some(), "the second op carried the line past the first timer");
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(r.core.state("p").driver, None, "gone after the linger");
    let last = lock(&r.rec.states).last().cloned().expect("state");
    assert_eq!(last.driver, None);
    assert_eq!(r.core.steps("p").len(), 2);
}

#[test]
fn page_events_update_state_and_emit() {
    let r = rig();
    r.core.apply_event("p", BackendEvent::LoadStarted("http://a/".into()));
    assert!(r.core.state("p").loading);
    r.core.apply_event("p", BackendEvent::Title("A".into()));
    r.core.apply_event("p", BackendEvent::LoadFinished("http://a/#x".into()));
    let st = r.core.state("p");
    assert_eq!((st.loading, st.url.as_str(), st.title.as_str()), (false, "http://a/#x", "A"));
    r.core.refresh_history("p");
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
    assert!(calls.contains(&"rect p 0,0,300,200".to_string()));
    r.core.back("p").expect("back");
    r.core.forward("p").expect("forward");
    r.core.reload("p").expect("reload");
    let calls = r.fake.calls();
    for s in ["history.back()", "history.forward()", "location.reload()"] {
        assert!(calls.iter().any(|c| c.ends_with(s)), "{s}");
    }
    assert_eq!(r.core.navigate("p", "file:///etc/hosts").expect_err("file").code, "bad_request");
    r.core.set_visible("p", false).expect("hide");
    assert!(r.fake.calls().contains(&"visible p false".to_string()));
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
