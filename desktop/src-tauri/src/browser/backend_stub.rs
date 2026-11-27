//! Targets without a webview backend yet (Windows lands on WebView2, docs/PLAN-windows.md).

use super::core::{Backend, Sink};
use super::types::*;
use std::time::Duration;

pub struct StubBackend;

fn no<T>() -> BrowserResult<T> {
    Err(BrowserError::new("unsupported", "the in-app browser is not supported on this platform yet"))
}

impl Backend for StubBackend {
    fn set_sink(&self, _: Sink) {}
    fn exists(&self, _: &str) -> bool {
        false
    }
    fn open(&self, _: &str, _: &str, _: Rect, _: bool) -> BrowserResult<()> {
        no()
    }
    fn set_rect(&self, _: &str, _: Rect) -> BrowserResult<()> {
        no()
    }
    fn set_visible(&self, _: &str, _: bool) -> BrowserResult<()> {
        no()
    }
    fn navigate(&self, _: &str, _: &str) -> BrowserResult<()> {
        no()
    }
    fn eval(&self, _: &str, _: &str, _: Duration) -> BrowserResult<String> {
        no()
    }
    fn run_script(&self, _: &str, _: &str) -> BrowserResult<()> {
        no()
    }
    fn history(&self, _: &str) -> (bool, bool) {
        (false, false)
    }
    fn snapshot(&self, _: &str, _: Option<Rect>) -> BrowserResult<Vec<u8>> {
        no()
    }
    fn pop_out(&self, _: &str, _: Option<Rect>) -> BrowserResult<()> {
        no()
    }
    fn put_back(&self, _: &str, _: Rect) -> BrowserResult<Option<Rect>> {
        no()
    }
    fn close(&self, _: &str) -> BrowserResult<Option<Rect>> {
        no()
    }
}
