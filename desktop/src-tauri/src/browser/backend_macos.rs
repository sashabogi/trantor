//! The macOS webview backend: a WKWebView child of the main window, or the same webview moved
//! into its own `browser-<project>` window when popped out.

use super::core::{Backend, Sink};
use super::types::*;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSDictionary, NSError};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window, WindowEvent, Wry};

const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

struct Page {
    webview: Webview<Wry>,
    popout: Option<Window<Wry>>,
}

pub struct MacBackend {
    app: AppHandle<Wry>,
    sink: Mutex<Option<Sink>>,
    pages: Mutex<HashMap<String, Page>>,
}

impl MacBackend {
    pub fn new(app: AppHandle<Wry>) -> Self {
        MacBackend { app, sink: Mutex::new(None), pages: Mutex::new(HashMap::new()) }
    }

    fn page<T>(&self, project: &str, f: impl FnOnce(&mut Page) -> BrowserResult<T>) -> BrowserResult<T> {
        let mut g = lock(&self.pages);
        let page = g.get_mut(project).ok_or_else(|| BrowserError::new("not_found", "no page is open in this project's browser"))?;
        f(page)
    }

    fn webview(&self, project: &str) -> BrowserResult<Webview<Wry>> {
        self.page(project, |p| Ok(p.webview.clone()))
    }
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

impl Backend for MacBackend {
    fn set_sink(&self, sink: Sink) {
        *lock(&self.sink) = Some(sink);
    }

    fn exists(&self, project: &str) -> bool {
        lock(&self.pages).contains_key(project)
    }

    fn open(&self, project: &str, url: &str, rect: Rect, visible: bool) -> BrowserResult<()> {
        if self.exists(project) {
            return Ok(());
        }
        let window = self.app.get_window("main").ok_or_else(|| BrowserError::new("not_found", "the main window is not open"))?;
        let parsed = tauri::Url::parse(url).map_err(|e| BrowserError::new("bad_request", e.to_string()))?;
        let sink = lock(&self.sink).clone();
        let emit = move |project: &str, ev: BackendEvent| {
            if let Some(s) = &sink {
                s(project, ev);
            }
        };
        let (e1, e2, e3, e4) = (emit.clone(), emit.clone(), emit.clone(), emit);
        let (p1, p2, p3, p4) = (project.to_string(), project.to_string(), project.to_string(), project.to_string());
        let builder = WebviewBuilder::new(format!("bv-{}", slug(project)), WebviewUrl::External(parsed))
            .user_agent(SAFARI_UA)
            .data_store_identifier(store_id(project))
            .on_page_load(move |_, payload| {
                let url = payload.url().to_string();
                match payload.event() {
                    PageLoadEvent::Started => e1(&p1, BackendEvent::LoadStarted(url)),
                    PageLoadEvent::Finished => e1(&p1, BackendEvent::LoadFinished(url)),
                }
            })
            .on_document_title_changed(move |_, title| e2(&p2, BackendEvent::Title(title)))
            .on_navigation(move |url| {
                let ok = matches!(url.scheme(), "http" | "https" | "about");
                if ok {
                    e3(&p3, BackendEvent::Navigated(url.to_string()));
                }
                ok
            })
            .on_new_window(move |url, _| {
                e4(&p4, BackendEvent::NewWindow(url.to_string()));
                NewWindowResponse::Deny
            });
        let r = below_title(rect.sane(), title_inset(&window));
        let webview = window
            .add_child(builder, LogicalPosition::new(r.x, r.y), LogicalSize::new(r.w, r.h))
            .map_err(tauri_err)?;
        if !visible {
            let _ = webview.hide();
        }
        // NSViews no longer clip by default (macOS 14): a loaded page drew past its top edge over
        // the address bar. Clip the page to its own frame.
        let _ = webview.with_webview(|pw| {
            // SAFETY: as in `history`; these closures run on the main thread.
            let web: &WKWebView = unsafe { &*pw.inner().cast() };
            web.setClipsToBounds(true);
            if let Some(parent) = unsafe { web.superview() } {
                parent.setClipsToBounds(true);
            }
        });
        #[cfg(debug_assertions)]
        {
            let wv = webview.clone();
            std::thread::spawn(move || {
                for _ in 0..20 {
                    std::thread::sleep(Duration::from_secs(2));
                    let _ = crate::changes::app_log(format!("browser frame tick: {}", frame_in_window(&wv)));
                }
            });
        }
        lock(&self.pages).insert(project.to_string(), Page { webview, popout: None });
        Ok(())
    }

    fn set_rect(&self, project: &str, rect: Rect) -> BrowserResult<()> {
        let wv = self.webview(project)?;
        let main = self.app.get_window("main").ok_or_else(|| BrowserError::new("not_found", "the main window is not open"))?;
        wv.set_bounds(bounds(below_title(rect, title_inset(&main)))).map_err(tauri_err)?;
        #[cfg(debug_assertions)]
        {
            let wv = wv.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                let _ = crate::changes::app_log(format!("browser rect: asked x={} y={} w={} h={} -> placed {}", rect.x, rect.y, rect.w, rect.h, frame_in_window(&wv)));
            });
        }
        Ok(())
    }

    fn set_visible(&self, project: &str, visible: bool) -> BrowserResult<()> {
        let wv = self.webview(project)?;
        if visible { wv.show() } else { wv.hide() }.map_err(tauri_err)
    }

    fn navigate(&self, project: &str, url: &str) -> BrowserResult<()> {
        let parsed = tauri::Url::parse(url).map_err(|e| BrowserError::new("bad_request", e.to_string()))?;
        self.webview(project)?.navigate(parsed).map_err(tauri_err)
    }

    fn eval(&self, project: &str, js: &str, timeout: Duration) -> BrowserResult<String> {
        let (tx, rx) = channel();
        self.webview(project)?
            .eval_with_callback(js, move |s| {
                let _ = tx.send(s);
            })
            .map_err(tauri_err)?;
        rx.recv_timeout(timeout).map_err(|_| BrowserError::new("timeout", "the page did not answer in time"))
    }

    fn run_script(&self, project: &str, js: &str) -> BrowserResult<()> {
        self.webview(project)?.eval(js).map_err(tauri_err)
    }

    fn history(&self, project: &str) -> (bool, bool) {
        let Ok(wv) = self.webview(project) else { return (false, false) };
        let (tx, rx) = channel();
        let sent = wv.with_webview(move |pw| {
            // SAFETY: on macOS `inner()` is the WKWebView this webview wraps, valid on this thread.
            let web: &WKWebView = unsafe { &*pw.inner().cast() };
            let _ = tx.send(unsafe { (web.canGoBack(), web.canGoForward()) });
        });
        if sent.is_err() {
            return (false, false);
        }
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or((false, false))
    }

    fn snapshot(&self, project: &str, clip: Option<Rect>) -> BrowserResult<Vec<u8>> {
        let (tx, rx) = channel();
        self.webview(project)?
            .with_webview(move |pw| {
                // SAFETY: as in `history`; these closures run on the main thread.
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
        let (webview, existing) = self.page(project, |p| Ok((p.webview.clone(), p.popout.clone())))?;
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
        webview.reparent(&win).map_err(tauri_err)?;
        let inset = title_inset(&win);
        webview.set_bounds(bounds(Rect { x: 0.0, y: inset, w: f.w, h: (f.h - inset).max(1.0) })).map_err(tauri_err)?;
        let _ = webview.show();
        let sink = lock(&self.sink).clone();
        let (wv, w2, p) = (webview, win.clone(), project.to_string());
        win.on_window_event(move |ev| match ev {
            WindowEvent::Resized(size) => {
                let scale = w2.scale_factor().unwrap_or(1.0);
                let s = size.to_logical::<f64>(scale);
                let _ = wv.set_bounds(bounds(Rect { x: 0.0, y: inset, w: s.width, h: (s.height - inset).max(1.0) }));
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(s) = &sink {
                    s(&p, BackendEvent::PopoutClosed);
                }
            }
            _ => {}
        });
        let _ = win.set_focus();
        self.page(project, |p| {
            p.popout = Some(win);
            Ok(())
        })
    }

    fn put_back(&self, project: &str, rect: Rect) -> BrowserResult<Option<Rect>> {
        let main = self.app.get_window("main").ok_or_else(|| BrowserError::new("not_found", "the main window is not open"))?;
        let (webview, win) = self.page(project, |p| Ok((p.webview.clone(), p.popout.take())))?;
        let Some(win) = win else { return Ok(None) };
        let frame = frame_of(&win);
        webview.reparent(&main).map_err(tauri_err)?;
        webview.set_bounds(bounds(below_title(rect.sane(), title_inset(&main)))).map_err(tauri_err)?;
        let _ = webview.show();
        let _ = win.destroy();
        Ok(frame)
    }

    fn close(&self, project: &str) -> BrowserResult<Option<Rect>> {
        let Some(page) = lock(&self.pages).remove(project) else { return Ok(None) };
        let frame = page.popout.as_ref().and_then(frame_of);
        let _ = page.webview.close();
        if let Some(win) = page.popout {
            let _ = win.destroy();
        }
        Ok(frame)
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
        // SAFETY: as in `history`; these closures run on the main thread.
        let web: &WKWebView = unsafe { &*pw.inner().cast() };
        let f = unsafe { web.convertRect_toView(web.bounds(), None) };
        let content_h = web.window().and_then(|w| w.contentView()).map(|v| v.frame().size.height).unwrap_or(-1.0);
        let layout_h = web.window().map(|w| w.contentLayoutRect().size.height).unwrap_or(-1.0);
        let inset_top = web.safeAreaInsets().top;
        let _ = tx.send(format!("x={} y={} w={} h={} content_h={} layout_h={} safe_top={}", f.origin.x, f.origin.y, f.size.width, f.size.height, content_h, layout_h, inset_top));
    });
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or_else(|_| "no frame".into())
}
