//! Shapes shared by the commands, the events and the agent socket (docs/CONTRACT-browser.md).

use super::device::{Device, DEFAULT_UA};
use serde::{Deserialize, Serialize};

/// Logical pixels, relative to the main window's content.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub const DEFAULT: Rect = Rect { x: 0.0, y: 0.0, w: 900.0, h: 600.0 };

    /// A rect the OS can lay out: finite and at least 1x1.
    pub fn sane(self) -> Rect {
        let fix = |v: f64| if v.is_finite() { v } else { 0.0 };
        Rect { x: fix(self.x), y: fix(self.y), w: fix(self.w).max(1.0), h: fix(self.h).max(1.0) }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Driver {
    pub session: String,
    pub label: String,
    pub action: String,
    pub since: u64,
}

/// One entry of the page strip.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PageState {
    pub id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub driver: Option<Driver>,
}

/// The top-level url, title, loading, driver and history flags describe the active page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserState {
    pub project: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_back: bool,
    pub can_forward: bool,
    pub popped_out: bool,
    pub driver: Option<Driver>,
    pub held_by_user: bool,
    pub pages: Vec<PageState>,
    pub active_page: String,
    pub zoom: f64,
    pub user_agent: String,
    pub emulation: Option<Device>,
}

impl Default for BrowserState {
    fn default() -> Self {
        BrowserState {
            project: String::new(),
            url: String::new(),
            title: String::new(),
            loading: false,
            can_back: false,
            can_forward: false,
            popped_out: false,
            driver: None,
            held_by_user: false,
            pages: Vec::new(),
            active_page: String::new(),
            zoom: 1.0,
            user_agent: DEFAULT_UA.to_string(),
            emulation: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Favorite {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Permission {
    pub host: String,
    pub rule: String,
}

/// Payload of `browser://ask`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ask {
    pub project: String,
    pub id: String,
    pub session: String,
    pub label: String,
    pub host: String,
    /// "evaluate" when the ask is for running a script; absent for a plain host ask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// One line of the Steps list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub session: String,
    pub label: String,
    pub action: String,
    pub at: u64,
    pub ok: bool,
}

/// An error with one of the contract's codes (plus `bad_request` and `unsupported`).
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserError {
    pub code: &'static str,
    pub message: String,
}

impl BrowserError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        BrowserError { code, message: message.into() }
    }
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub type BrowserResult<T> = Result<T, BrowserError>;

/// What the webview layer reports back to the core.
#[derive(Debug, Clone, PartialEq)]
pub enum BackendEvent {
    Navigated(String),
    LoadStarted(String),
    LoadFinished(String),
    Title(String),
    /// The site asked for a new window (window.open, target=_blank, a sign-in popup).
    NewWindow(String),
    /// The page called window.close().
    CloseRequested,
    /// What the webview itself says now, sampled even while the page is hidden. `loading` is a
    /// level, the rest are set only when they changed since the last sample.
    Observed { url: Option<String>, title: Option<String>, loading: bool, can_back: Option<bool>, can_forward: Option<bool> },
    PopoutClosed,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
