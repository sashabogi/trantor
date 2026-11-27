//! The in-app browser (card #14504, contract in docs/CONTRACT-browser.md).

pub mod commands;
mod core;
mod device;
mod hosts;
mod scripts;
mod socket;
mod store;
mod types;

#[cfg(target_os = "macos")]
mod backend_macos;
#[cfg(not(target_os = "macos"))]
mod backend_stub;

pub use self::core::BrowserCore;
use self::core::{Backend, CoreConfig, Emitter};
use self::hosts::{FrameStore, HostRules};
use self::types::*;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter as _, Manager, Wry};

/// Tauri-managed handle the commands read.
pub struct BrowserHandle(pub Arc<BrowserCore>);

struct TauriEmitter(AppHandle<Wry>);

impl Emitter for TauriEmitter {
    fn state(&self, state: &BrowserState) {
        let _ = self.0.emit("browser://state", state);
    }
    fn ask(&self, ask: &Ask) {
        let _ = self.0.emit("browser://ask", ask);
    }
    fn reveal(&self, project: &str) {
        let _ = self.0.emit("browser://reveal", serde_json::json!({ "project": project }));
    }
}

#[cfg(target_os = "macos")]
fn make_backend(app: &AppHandle<Wry>) -> Arc<dyn Backend> {
    Arc::new(backend_macos::MacBackend::new(app.clone()))
}

#[cfg(not(target_os = "macos"))]
fn make_backend(_: &AppHandle<Wry>) -> Arc<dyn Backend> {
    Arc::new(backend_stub::StubBackend)
}

/// Builds the core, registers it as managed state and starts the agent socket.
pub fn init(app: &AppHandle<Wry>) {
    let data: PathBuf = app.path().app_data_dir().unwrap_or_else(|_| crate::desktop_bus_dir()).join("browser");
    let bus = crate::desktop_bus_dir();
    let core = BrowserCore::new(
        make_backend(app),
        Arc::new(TauriEmitter(app.clone())),
        HostRules::load(data.join("hosts.json")),
        FrameStore::load(data.join("frames.json")),
        CoreConfig { data_dir: Some(data.clone()), ..CoreConfig::new(bus.clone()) },
    );
    app.manage(BrowserHandle(core.clone()));
    match socket::serve(core.clone()) {
        Ok(path) => {
            let _ = crate::changes::app_log(format!("browser: agent socket at {}", path.display()));
            app.manage(SocketOwned);
        }
        Err(e) => {
            let _ = crate::changes::app_log(format!("browser: no agent socket ({e})"));
        }
    }
    #[cfg(debug_assertions)]
    drill(app, core);
}

/// Marker: this process bound the socket, so it is the one that removes it at quit.
struct SocketOwned;

pub fn shutdown(app: &AppHandle<Wry>) {
    if app.try_state::<SocketOwned>().is_some() {
        socket::remove(&crate::desktop_bus_dir());
    }
}

/// Debug builds only. Live drill, inert unless TRANTOR_BROWSER_DRILL=<project> is set: opens TRANTOR_BROWSER_DRILL_URL
/// (default https://example.com) at a fixed rect and answers every host ask with "once".
#[cfg(debug_assertions)]
fn drill(app: &AppHandle<Wry>, core: Arc<BrowserCore>) {
    let Ok(project) = std::env::var("TRANTOR_BROWSER_DRILL") else { return };
    let url = std::env::var("TRANTOR_BROWSER_DRILL_URL").unwrap_or_else(|_| "https://example.com".into());
    use tauri::Listener;
    let answerer = core.clone();
    let probe_app = app.clone();
    app.listen("browser://ask", move |ev| {
        if let Ok(ask) = serde_json::from_str::<Ask>(ev.payload()) {
            let _ = answerer.answer(&ask.id, "once");
        }
    });
    if std::env::var_os("TRANTOR_BROWSER_DRILL_IDLE").is_some() {
        // Socket-driven drill: a hidden tab with a rect, an agent opens pages over the socket, and
        // the tab is shown a few seconds after the first reveal so screenshots have pixels.
        let shower = core.clone();
        let name = project.clone();
        app.listen("browser://reveal", move |_| {
            let (core, name) = (shower.clone(), name.clone());
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(6));
                let _ = core.set_visible(&name, true);
            });
        });
        let idle = core.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let _ = idle.open(&project, None, Rect { x: 40.0, y: 80.0, w: 900.0, h: 600.0 });
            drill_commands(&idle, &project);
        });
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let r = core.open(&project, Some(url), Rect { x: 40.0, y: 80.0, w: 900.0, h: 600.0 });
        let _ = crate::changes::app_log(format!("browser drill: open -> {:?}", r.map(|s| s.url)));
        std::thread::sleep(std::time::Duration::from_secs(2));
        #[cfg(target_os = "macos")]
        {
            let labels: Vec<String> = probe_app.webviews().keys().cloned().collect();
            let _ = crate::changes::app_log(format!("browser drill: webviews {labels:?}"));
            for (label, wv) in probe_app.webviews() {
                let _ = crate::changes::app_log(format!("browser drill: frame {label}: {}", backend_macos::frame_in_window(&wv)));
            }
            let r2 = core.set_rect(&project, Rect { x: 40.0, y: 80.0, w: 900.0, h: 600.0 });
            std::thread::sleep(std::time::Duration::from_secs(1));
            for (label, wv) in probe_app.webviews() {
                if label.starts_with("bv-") {
                    let _ = crate::changes::app_log(format!("browser drill: after set_rect({r2:?}) {label}: {}", backend_macos::frame_in_window(&wv)));
                }
            }
        }
        if std::env::var_os("TRANTOR_BROWSER_DRILL_POP").is_some() {
            let step = |what: &str, r: BrowserResult<()>| {
                let st = core.state(&project);
                let _ = crate::changes::app_log(format!("browser drill: {what} -> {:?} popped_out={} url={}", r, st.popped_out, st.url));
            };
            std::thread::sleep(std::time::Duration::from_secs(8));
            step("pop_out", core.pop_out(&project));
            std::thread::sleep(std::time::Duration::from_secs(15));
            step("put_back", core.put_back(&project, Rect { x: 40.0, y: 80.0, w: 700.0, h: 500.0 }));
            std::thread::sleep(std::time::Duration::from_secs(8));
            core.take_over(&project);
            step("take_over", Ok(()));
        }
    });
}

/// Debug builds only: runs lines of `<bus>/drill.cmd` (zoom, find, ua, inspect, history,
/// favorite, permissions, clear_storage) against the drill project and appends results to
/// `<bus>/drill.out`, for the commands the agent socket does not carry.
#[cfg(debug_assertions)]
fn drill_commands(core: &Arc<BrowserCore>, project: &str) {
    use std::io::Write;
    let (cmd, out) = (crate::desktop_bus_dir().join("drill.cmd"), crate::desktop_bus_dir().join("drill.out"));
    loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let Ok(text) = std::fs::read_to_string(&cmd) else { continue };
        let _ = std::fs::remove_file(&cmd);
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let (word, arg) = line.split_once(' ').unwrap_or((line, ""));
            let res = match word {
                "zoom" => format!("{:?}", core.zoom(project, arg.parse().ok())),
                "find" => format!("{:?}", core.find(project, arg, false, None)),
                "find_clear" => format!("{:?}", core.find_clear(project, None)),
                "inspect" => format!("{:?}", core.inspect(project, None)),
                "ua" => format!("{:?}", core.set_user_agent(project, (arg != "none").then_some(arg))),
                "history" => format!("{:?}", core.history(project).iter().take(5).collect::<Vec<_>>()),
                "favorite" => format!("{:?}", core.favorite_toggle(project, arg, "drill")),
                "favorites" => format!("{:?}", core.favorites(project)),
                "permissions" => format!("{:?}", core.permissions(project)),
                "clear_storage" => format!("{:?}", core.clear_storage(project)),
                "state" => format!("{:?}", core.state(project)),
                other => format!("unknown {other}"),
            };
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&out) {
                let _ = writeln!(f, "{line} -> {res}");
            }
        }
    }
}
