//! The macOS webview backend: WKWebView children of the main window (one per page), or the same
//! webviews moved into their own `browser-<project>` window when popped out.

use super::core::{Backend, PageSpec, Sink};
use super::types::*;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::NSObjectProtocol;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSDate, NSDictionary, NSError, NSString, NSUUID};
use objc2_web_kit::{WKFindConfiguration, WKFindResult, WKSnapshotConfiguration, WKWebView, WKWebsiteDataStore};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window, WindowEvent, Wry};

/// A popup page that calls window.close() navigates here; the navigation hook swallows it and
/// reports `CloseRequested` (no page-to-Rust channel is exposed to remote sites).
const CLOSE_HOST: &str = "trantor-close.invalid";
const CLOSE_HOOK: &str = "(function(){try{window.close=function(){try{location.href='https://trantor-close.invalid/'}catch(e){}};}catch(e){}})();";

struct PageWv {
    id: String,
    webview: Webview<Wry>,
}

#[derive(Default)]
struct ProjectPages {
    pages: Vec<PageWv>,
    popout: Option<Window<Wry>>,
}

type Projects = Arc<Mutex<HashMap<String, ProjectPages>>>;

pub struct MacBackend {
    app: AppHandle<Wry>,
    sink: Arc<Mutex<Option<Sink>>>,
    projects: Projects,
    polling: AtomicBool,
}

impl MacBackend {
    pub fn new(app: AppHandle<Wry>) -> Self {
        MacBackend { app, sink: Arc::new(Mutex::new(None)), projects: Arc::new(Mutex::new(HashMap::new())), polling: AtomicBool::new(false) }
    }

    fn webview(&self, project: &str, page: &str) -> BrowserResult<Webview<Wry>> {
        lock(&self.projects)
            .get(project)
            .and_then(|pp| pp.pages.iter().find(|p| p.id == page))
            .map(|p| p.webview.clone())
            .ok_or_else(|| BrowserError::new("not_found", format!("no page {page} in this project's browser")))
    }

    /// Samples every page's own state a few times a second. A page that finishes loading while
    /// hidden may never report it through the navigation delegate, and a single-page app changes
    /// its url without any navigation event, so the webview itself is the source of truth.
    fn start_poller(&self) {
        if self.polling.swap(true, Ordering::SeqCst) {
            return;
        }
        let (projects, sink) = (self.projects.clone(), self.sink.clone());
        std::thread::spawn(move || {
            #[derive(Default, PartialEq, Clone)]
            struct Last {
                url: Option<String>,
                title: String,
                back: bool,
                fwd: bool,
            }
            let mut last: HashMap<(String, String), Last> = HashMap::new();
            loop {
                std::thread::sleep(Duration::from_millis(300));
                let list: Vec<(String, String, Webview<Wry>)> = lock(&projects)
                    .iter()
                    .flat_map(|(proj, pp)| pp.pages.iter().map(|p| (proj.clone(), p.id.clone(), p.webview.clone())))
                    .collect();
                last.retain(|k, _| list.iter().any(|(p, i, _)| *p == k.0 && *i == k.1));
                let Some(sink) = lock(&sink).clone() else { continue };
                for (proj, id, wv) in list {
                    let Some((url, title, loading, back, fwd)) = sample(&wv) else { continue };
                    let prev = last.entry((proj.clone(), id.clone())).or_default();
                    let now = Last { url: url.clone(), title: title.clone(), back, fwd };
                    let ev = BackendEvent::Observed {
                        url: (prev.url != now.url).then_some(url).flatten(),
                        title: (prev.title != now.title).then_some(title),
                        loading,
                        can_back: (prev.back != back).then_some(back),
                        can_forward: (prev.fwd != fwd).then_some(fwd),
                    };
                    *prev = now;
                    sink(&proj, &id, ev);
                }
            }
        });
    }
}

/// (url, title, isLoading, canGoBack, canGoForward) read on the main thread.
fn sample(wv: &Webview<Wry>) -> Option<(Option<String>, String, bool, bool, bool)> {
    let (tx, rx) = channel();
    wv.with_webview(move |pw| {
        // SAFETY: on macOS `inner()` is the WKWebView this webview wraps, valid on this thread.
        let web: &WKWebView = unsafe { &*pw.inner().cast() };
        let url = unsafe { web.URL() }.and_then(|u| u.absoluteString()).map(|s| s.to_string());
        let title = unsafe { web.title() }.map(|s| s.to_string()).unwrap_or_default();
        let _ = tx.send(unsafe { (url, title, web.isLoading(), web.canGoBack(), web.canGoForward()) });
    })
    .ok()?;
    rx.recv_timeout(Duration::from_millis(500)).ok()
}

pub(crate) fn slug(project: &str) -> String {
    project.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// One persistent WKWebsiteDataStore per project, so cookies and sign-ins survive restarts.
/// Tauri 2.11 offers `data_store_identifier` on macOS 14+ (a 16 byte id); `data_directory` is
/// not available on WKWebView. Older macOS falls back to the shared default store, which still
/// persists but is not isolated per project.
fn store_id(project: &str) -> [u8; 16] {
    let digest = Sha256::digest(format!("trantor-browser:{project}").as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    id
}

fn tauri_err(e: tauri::Error) -> BrowserError {
    BrowserError::new("timeout", e.to_string())
}

/// How far a window's content area runs up under its title bar (contentView minus the layout rect).
/// The app's own DOM starts below it, so a page placed from DOM coordinates must shift down by it.
fn title_inset(win: &Window) -> f64 {
    fn read(w: &Window) -> f64 {
        w.ns_window().ok().map(|ptr| {
            // SAFETY: ns_window is this window's live NSWindow, read on the main thread.
            let ns: &objc2_app_kit::NSWindow = unsafe { &*ptr.cast() };
            let full = ns.contentView().map(|v| v.frame().size.height).unwrap_or(0.0);
            (full - ns.contentLayoutRect().size.height).max(0.0)
        }).unwrap_or(0.0)
    }
    // already on the main thread (a window event): read directly, waiting on it would deadlock
    if MainThreadMarker::new().is_some() {
        return read(win);
    }
    let (tx, rx) = channel();
    let w = win.clone();
    let sent = win.run_on_main_thread(move || {
        let _ = tx.send(read(&w));
    });
    if sent.is_err() {
        return 0.0;
    }
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or(0.0)
}

fn below_title(r: Rect, inset: f64) -> Rect {
    Rect { x: r.x, y: r.y + inset, w: r.w, h: r.h }
}

fn bounds(r: Rect) -> tauri::Rect {
    tauri::Rect { position: LogicalPosition::new(r.x, r.y).into(), size: LogicalSize::new(r.w, r.h).into() }
}

fn frame_of(win: &Window<Wry>) -> Option<Rect> {
    let scale = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?.to_logical::<f64>(scale);
    let size = win.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Rect { x: pos.x, y: pos.y, w: size.width, h: size.height })
}

/// The page bounds that fill a pop-out window below its title bar.
fn fill(win: &Window<Wry>, inset: f64) -> Rect {
    let scale = win.scale_factor().unwrap_or(1.0);
    let s = win.inner_size().map(|s| s.to_logical::<f64>(scale)).unwrap_or(LogicalSize::new(1100.0, 760.0));
    Rect { x: 0.0, y: inset, w: s.width, h: (s.height - inset).max(1.0) }
}

impl Backend for MacBackend {
    fn set_sink(&self, sink: Sink) {
        *lock(&self.sink) = Some(sink);
    }

    fn open_page(&self, project: &str, page: &str, url: &str, spec: PageSpec) -> BrowserResult<()> {
        let popout = lock(&self.projects).get(project).and_then(|pp| pp.popout.clone());
        let window = match &popout {
            Some(w) => w.clone(),
            None => self.app.get_window("main").ok_or_else(|| BrowserError::new("not_found", "the main window is not open"))?,
        };
        let parsed = tauri::Url::parse(url).map_err(|e| BrowserError::new("bad_request", e.to_string()))?;
        let sink = lock(&self.sink).clone();
        let emit = move |project: &str, page: &str, ev: BackendEvent| {
            if let Some(s) = &sink {
                s(project, page, ev);
            }
        };
        let (e1, e2, e3, e4) = (emit.clone(), emit.clone(), emit.clone(), emit);
        let (p1, p2, p3, p4) = (project.to_string(), project.to_string(), project.to_string(), project.to_string());
        let (g1, g2, g3, g4) = (page.to_string(), page.to_string(), page.to_string(), page.to_string());
        let mut builder = WebviewBuilder::new(format!("bv-{}-{}", slug(project), page), WebviewUrl::External(parsed))
            .user_agent(&spec.ua)
            .data_store_identifier(store_id(project))
            .on_page_load(move |_, payload| {
                let url = payload.url().to_string();
                match payload.event() {
                    PageLoadEvent::Started => e1(&p1, &g1, BackendEvent::LoadStarted(url)),
                    PageLoadEvent::Finished => e1(&p1, &g1, BackendEvent::LoadFinished(url)),
                }
            })
            .on_document_title_changed(move |_, title| e2(&p2, &g2, BackendEvent::Title(title)))
            .on_navigation(move |url| {
                if url.host_str() == Some(CLOSE_HOST) {
                    e3(&p3, &g3, BackendEvent::CloseRequested);
                    return false;
                }
                let ok = matches!(url.scheme(), "http" | "https" | "about");
                if ok {
                    e3(&p3, &g3, BackendEvent::Navigated(url.to_string()));
                }
                ok
            })
            .on_new_window(move |url, _| {
                e4(&p4, &g4, BackendEvent::NewWindow(url.to_string()));
                NewWindowResponse::Deny
            });
        if spec.popup {
            builder = builder.initialization_script(CLOSE_HOOK);
        }
        let inset = title_inset(&window);
        let r = if popout.is_some() { fill(&window, inset) } else { below_title(spec.rect.sane(), inset) };
        let webview = window.add_child(builder, LogicalPosition::new(r.x, r.y), LogicalSize::new(r.w, r.h)).map_err(tauri_err)?;
        if !spec.visible {
            let _ = webview.hide();
        }
        if (spec.zoom - 1.0).abs() > 1e-9 {
            let _ = webview.set_zoom(spec.zoom);
        }
        // NSViews no longer clip by default (macOS 14): a loaded page drew past its top edge over
        // the address bar. Clip the page to its own frame. Also let Web Inspector attach (13.3+).
        let _ = webview.with_webview(|pw| {
            // SAFETY: as in `sample`; these closures run on the main thread.
            let web: &WKWebView = unsafe { &*pw.inner().cast() };
            web.setClipsToBounds(true);
            if let Some(parent) = unsafe { web.superview() } {
                parent.setClipsToBounds(true);
            }
            if web.respondsToSelector(objc2::sel!(setInspectable:)) {
                unsafe { web.setInspectable(true) };
            }
        });
        lock(&self.projects).entry(project.to_string()).or_default().pages.push(PageWv { id: page.to_string(), webview });
        self.start_poller();
        Ok(())
    }

    fn set_rect(&self, project: &str, page: &str, rect: Rect) -> BrowserResult<()> {
        let wv = self.webview(project, page)?;
        let main = self.app.get_window("main").ok_or_else(|| BrowserError::new("not_found", "the main window is not open"))?;
        wv.set_bounds(bounds(below_title(rect, title_inset(&main)))).map_err(tauri_err)?;
        Ok(())
    }

    fn set_visible(&self, project: &str, page: &str, visible: bool) -> BrowserResult<()> {
        let wv = self.webview(project, page)?;
        if visible { wv.show() } else { wv.hide() }.map_err(tauri_err)
    }

    fn navigate(&self, project: &str, page: &str, url: &str) -> BrowserResult<()> {
        let parsed = tauri::Url::parse(url).map_err(|e| BrowserError::new("bad_request", e.to_string()))?;
        self.webview(project, page)?.navigate(parsed).map_err(tauri_err)
    }

    fn eval(&self, project: &str, page: &str, js: &str, timeout: Duration) -> BrowserResult<String> {
        let (tx, rx) = channel();
        self.webview(project, page)?
            .eval_with_callback(js, move |s| {
                let _ = tx.send(s);
            })
            .map_err(tauri_err)?;
        rx.recv_timeout(timeout).map_err(|_| BrowserError::new("timeout", "the page did not answer in time"))
    }

    fn run_script(&self, project: &str, page: &str, js: &str) -> BrowserResult<()> {
        self.webview(project, page)?.eval(js).map_err(tauri_err)
    }

    fn history(&self, project: &str, page: &str) -> (bool, bool) {
        sample(&match self.webview(project, page) {
            Ok(wv) => wv,
            Err(_) => return (false, false),
        })
        .map(|s| (s.3, s.4))
        .unwrap_or((false, false))
    }

    fn snapshot(&self, project: &str, page: &str, clip: Option<Rect>) -> BrowserResult<Vec<u8>> {
        let (tx, rx) = channel();
        self.webview(project, page)?
            .with_webview(move |pw| {
                // SAFETY: as in `sample`; these closures run on the main thread.
                let web: &WKWebView = unsafe { &*pw.inner().cast() };
                let Some(mtm) = MainThreadMarker::new() else {
                    let _ = tx.send(Err("snapshot must start on the main thread".to_string()));
                    return;
                };
                let cfg = unsafe { WKSnapshotConfiguration::new(mtm) };
                if let Some(r) = clip {
                    unsafe { cfg.setRect(CGRect::new(CGPoint::new(r.x, r.y), CGSize::new(r.w, r.h))) };
                }
                let tx2 = tx.clone();
                let block = RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
                    let out = if img.is_null() {
                        let why = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string()).unwrap_or_default();
                        Err(format!("the page gave no snapshot {why}").trim().to_string())
                    } else {
                        png_of(unsafe { &*img }).ok_or_else(|| "could not encode the snapshot".to_string())
                    };
                    let _ = tx2.send(out);
                });
                unsafe { web.takeSnapshotWithConfiguration_completionHandler(Some(&cfg), &block) };
            })
            .map_err(tauri_err)?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| BrowserError::new("timeout", "the snapshot did not finish in time"))?
            .map_err(|m| BrowserError::new("timeout", m))
    }

    fn pop_out(&self, project: &str, frame: Option<Rect>) -> BrowserResult<()> {
        // The lock is not held across window calls: those wait on the main thread.
        let (webviews, existing) = {
            let g = lock(&self.projects);
            let pp = g.get(project).ok_or_else(|| BrowserError::new("not_found", "no page is open in this project's browser"))?;
            (pp.pages.iter().map(|p| p.webview.clone()).collect::<Vec<_>>(), pp.popout.clone())
        };
        if let Some(win) = existing {
            let _ = win.show();
            let _ = win.set_focus();
            return Ok(());
        }
        let label = format!("browser-{}", slug(project));
        let f = frame.map(Rect::sane).unwrap_or(Rect { x: 0.0, y: 0.0, w: 1100.0, h: 760.0 });
        let mut wb = WindowBuilder::new(&self.app, &label).title(format!("Browser - {project}")).inner_size(f.w, f.h);
        wb = if frame.is_some() { wb.position(f.x, f.y) } else { wb.center() };
        let win = wb.build().map_err(tauri_err)?;
        let inset = title_inset(&win);
        for wv in &webviews {
            wv.reparent(&win).map_err(tauri_err)?;
            wv.set_bounds(bounds(Rect { x: 0.0, y: inset, w: f.w, h: (f.h - inset).max(1.0) })).map_err(tauri_err)?;
        }
        let sink = lock(&self.sink).clone();
        let (projects, w2, p) = (self.projects.clone(), win.clone(), project.to_string());
        win.on_window_event(move |ev| match ev {
            WindowEvent::Resized(size) => {
                let scale = w2.scale_factor().unwrap_or(1.0);
                let s = size.to_logical::<f64>(scale);
                let r = bounds(Rect { x: 0.0, y: inset, w: s.width, h: (s.height - inset).max(1.0) });
                let all: Vec<Webview<Wry>> = lock(&projects).get(&p).map(|pp| pp.pages.iter().map(|x| x.webview.clone()).collect()).unwrap_or_default();
                for wv in all {
                    let _ = wv.set_bounds(r);
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(s) = &sink {
                    s(&p, "", BackendEvent::PopoutClosed);
                }
            }
            _ => {}
        });
        let _ = win.set_focus();
        lock(&self.projects).entry(project.to_string()).or_default().popout = Some(win);
        Ok(())
    }

    fn put_back(&self, project: &str, rect: Rect) -> BrowserResult<Option<Rect>> {
        let main = self.app.get_window("main").ok_or_else(|| BrowserError::new("not_found", "the main window is not open"))?;
        let (webviews, win) = {
            let mut g = lock(&self.projects);
            let pp = g.get_mut(project).ok_or_else(|| BrowserError::new("not_found", "no page is open in this project's browser"))?;
            (pp.pages.iter().map(|p| p.webview.clone()).collect::<Vec<_>>(), pp.popout.take())
        };
        let Some(win) = win else { return Ok(None) };
        let frame = frame_of(&win);
        let inset = title_inset(&main);
        for wv in &webviews {
            wv.reparent(&main).map_err(tauri_err)?;
            wv.set_bounds(bounds(below_title(rect.sane(), inset))).map_err(tauri_err)?;
        }
        let _ = win.destroy();
        Ok(frame)
    }

    fn close_page(&self, project: &str, page: &str) -> BrowserResult<Option<Rect>> {
        let (webview, last_window) = {
            let mut g = lock(&self.projects);
            let Some(pp) = g.get_mut(project) else { return Ok(None) };
            let Some(at) = pp.pages.iter().position(|p| p.id == page) else { return Ok(None) };
            let wv = pp.pages.remove(at).webview;
            let empty = pp.pages.is_empty();
            let win = if empty { g.remove(project).and_then(|pp| pp.popout) } else { None };
            (wv, win)
        };
        let frame = last_window.as_ref().and_then(frame_of);
        let _ = webview.close();
        if let Some(win) = last_window {
            let _ = win.destroy();
        }
        Ok(frame)
    }

    fn close(&self, project: &str) -> BrowserResult<Option<Rect>> {
        let Some(pp) = lock(&self.projects).remove(project) else { return Ok(None) };
        let frame = pp.popout.as_ref().and_then(frame_of);
        for p in pp.pages {
            let _ = p.webview.close();
        }
        if let Some(win) = pp.popout {
            let _ = win.destroy();
        }
        Ok(frame)
    }

    fn set_zoom(&self, project: &str, page: &str, zoom: f64) -> BrowserResult<()> {
        self.webview(project, page)?.set_zoom(zoom).map_err(tauri_err)
    }

    fn find(&self, project: &str, page: &str, text: &str, backwards: bool) -> BrowserResult<bool> {
        let (tx, rx) = channel();
        let text = text.to_string();
        self.webview(project, page)?
            .with_webview(move |pw| {
                // SAFETY: as in `sample`; these closures run on the main thread.
                let web: &WKWebView = unsafe { &*pw.inner().cast() };
                let Some(mtm) = MainThreadMarker::new() else { return };
                let cfg = unsafe { WKFindConfiguration::new(mtm) };
                unsafe {
                    cfg.setBackwards(backwards);
                    cfg.setWraps(true);
                }
                let tx2 = tx.clone();
                let block = RcBlock::new(move |res: NonNull<WKFindResult>| {
                    let _ = tx2.send(unsafe { res.as_ref().matchFound() });
                });
                unsafe { web.findString_withConfiguration_completionHandler(&NSString::from_str(&text), Some(&cfg), &block) };
            })
            .map_err(tauri_err)?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| BrowserError::new("timeout", "find did not finish in time"))
    }

    fn find_clear(&self, project: &str, page: &str) -> BrowserResult<()> {
        // WKWebView has no public "end find" call; clearing the selection removes the highlight.
        self.run_script(project, page, "try{window.getSelection().removeAllRanges();}catch(e){}")
    }

    fn inspect(&self, project: &str, page: &str) -> BrowserResult<()> {
        let _wv = self.webview(project, page)?;
        // Tauri's open_devtools drives WebKit's private inspector, so it exists only in debug
        // builds; release builds keep the page inspectable and point at the context menu.
        #[cfg(debug_assertions)]
        {
            _wv.open_devtools();
            Ok(())
        }
        #[cfg(not(debug_assertions))]
        Err(BrowserError::new("unsupported", "Web Inspector is not built into this release: right-click the page and choose Inspect Element (or use Safari's Develop menu), the page is inspectable"))
    }

    fn set_user_agent(&self, project: &str, page: &str, ua: &str) -> BrowserResult<()> {
        let ua = ua.to_string();
        self.webview(project, page)?
            .with_webview(move |pw| {
                // SAFETY: as in `sample`; these closures run on the main thread.
                let web: &WKWebView = unsafe { &*pw.inner().cast() };
                unsafe { web.setCustomUserAgent(Some(&NSString::from_str(&ua))) };
            })
            .map_err(tauri_err)
    }

    fn clear_storage(&self, project: &str) -> BrowserResult<()> {
        let (tx, rx) = channel();
        let id = store_id(project);
        let run = move || {
            let Some(mtm) = MainThreadMarker::new() else { return };
            let store = unsafe { WKWebsiteDataStore::dataStoreForIdentifier(&NSUUID::from_bytes(id), mtm) };
            let types = unsafe { WKWebsiteDataStore::allWebsiteDataTypes(mtm) };
            let done = RcBlock::new(move || {
                let _ = tx.send(());
            });
            unsafe { store.removeDataOfTypes_modifiedSince_completionHandler(&types, &NSDate::distantPast(), &done) };
        };
        self.app.run_on_main_thread(run).map_err(|e| BrowserError::new("timeout", e.to_string()))?;
        rx.recv_timeout(Duration::from_secs(30)).map_err(|_| BrowserError::new("timeout", "clearing site data did not finish in time"))
    }
}

/// NSImage -> TIFF -> bitmap rep -> PNG bytes.
fn png_of(img: &NSImage) -> Option<Vec<u8>> {
    let tiff = img.TIFFRepresentation()?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
    let props = NSDictionary::new();
    let png: Retained<_> = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
    Some(png.to_vec())
}

/// Debug builds only: where AppKit really placed a webview, in window coordinates (origin bottom-left).
#[cfg(debug_assertions)]
pub fn frame_in_window(wv: &Webview) -> String {
    let (tx, rx) = channel();
    let _ = wv.with_webview(move |pw| {
        // SAFETY: as in `sample`; these closures run on the main thread.
        let web: &WKWebView = unsafe { &*pw.inner().cast() };
        let f = unsafe { web.convertRect_toView(web.bounds(), None) };
        let content_h = web.window().and_then(|w| w.contentView()).map(|v| v.frame().size.height).unwrap_or(-1.0);
        let layout_h = web.window().map(|w| w.contentLayoutRect().size.height).unwrap_or(-1.0);
        let inset_top = web.safeAreaInsets().top;
        let _ = tx.send(format!("x={} y={} w={} h={} content_h={} layout_h={} safe_top={}", f.origin.x, f.origin.y, f.size.width, f.size.height, content_h, layout_h, inset_top));
    });
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or_else(|_| "no frame".into())
}
