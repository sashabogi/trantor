// Copyright 2014-2021 The winit contributors
// Copyright 2021-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0

//! The Objective-C exception boundary around tao's `extern "C"` method overrides (#6317).
//!
//! `send_event` (the `-[NSApplication sendEvent:]` override) and the NSView key/IME handlers are
//! plain `extern "C"` Rust functions. Rust gives such frames no unwind ABI: any unwind reaching
//! one runs the compiler's `panic_cannot_unwind` landing pad and the process aborts. A Rust panic
//! gets to the panic hook first, so it leaves a message; an Objective-C exception thrown by
//! AppKit or WebKit below the frame does not — the only trace is "panic in a function that
//! cannot unwind" and a SIGABRT. Three Trantor crashes on macOS 26 (2026-09-03 x2, 2026-09-07)
//! had exactly that shape, every one on an arrow key, none with a first Rust panic.
//!
//! AppKit's own run loop would have logged and swallowed the same exception had it reached
//! `-[NSApplication run]`. The guard here does the same one frame earlier: catch it at the
//! override, describe it (name, reason, the exception's own Objective-C call stack), hand it to
//! the embedding app's reporter, and continue.
#![allow(unused_unsafe)]

use std::{panic::AssertUnwindSafe, sync::OnceLock};

use objc2::{
  exception::{catch, Exception},
  rc::Retained,
};
use objc2_app_kit::{NSEvent, NSEventType};
use objc2_foundation::{NSException, NSString};
use once_cell::sync::Lazy;

/// What the guard learned about one caught exception.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjcExceptionReport {
  /// The override that caught it, e.g. `NSApplication sendEvent:`.
  pub site: &'static str,
  /// `-[NSException name]`, or the thrown object's class when it is not an NSException.
  pub name: String,
  /// `-[NSException reason]` (empty when the exception carries none).
  pub reason: String,
  /// `-[NSException callStackSymbols]`: the Objective-C frames at the throw, one per entry.
  pub backtrace: Vec<String>,
}

impl ObjcExceptionReport {
  /// One line naming the exception, where it was caught and why it was thrown.
  pub fn summary(&self) -> String {
    format!(
      "Objective-C exception {} caught at {}: {}",
      self.name, self.site, self.reason
    )
  }
}

type Reporter = Box<dyn Fn(&ObjcExceptionReport) + Send + Sync>;

static REPORTER: OnceLock<Reporter> = OnceLock::new();

/// Install the process-wide reporter the guard calls after logging a caught exception. Runs on
/// the thread that caught it (the main thread for event dispatch). Returns `false` when one is
/// already installed; the first one stays.
pub fn set_objc_exception_reporter(
  reporter: impl Fn(&ObjcExceptionReport) + Send + Sync + 'static,
) -> bool {
  REPORTER.set(Box::new(reporter)).is_ok()
}

fn describe(site: &'static str, exception: Option<Retained<Exception>>) -> ObjcExceptionReport {
  let Some(exception) = exception else {
    return ObjcExceptionReport {
      site,
      name: "nil".to_string(),
      reason: "@throw nil".to_string(),
      backtrace: Vec::new(),
    };
  };
  match NSException::from_exception(exception) {
    Ok(exception) => ObjcExceptionReport {
      site,
      name: exception.name().to_string(),
      reason: exception
        .reason()
        .map(|reason| reason.to_string())
        .unwrap_or_default(),
      backtrace: exception
        .callStackSymbols()
        .iter()
        .map(|frame| frame.to_string())
        .collect(),
    },
    Err(other) => ObjcExceptionReport {
      site,
      name: other.class().name().to_string_lossy().into_owned(),
      reason: format!("{other:?}"),
      backtrace: Vec::new(),
    },
  }
}

fn dispatch(report: &ObjcExceptionReport) {
  let summary = report.summary();
  log::error!("{summary}");
  eprintln!("{summary}");
  for frame in &report.backtrace {
    eprintln!("    {frame}");
  }
  if let Some(reporter) = REPORTER.get() {
    reporter(report);
  }
}

/// Run `f` at an Objective-C method boundary. An Objective-C exception thrown inside is caught,
/// reported and swallowed (`None`), and the caller returns to AppKit normally. Rust panics are
/// not touched: they pass through to the boundary exactly as before, panic hook first.
pub(crate) fn guard<R>(site: &'static str, f: impl FnOnce() -> R) -> Option<R> {
  guard_with(site, f, dispatch)
}

fn guard_with<R>(
  site: &'static str,
  f: impl FnOnce() -> R,
  report: impl FnOnce(&ObjcExceptionReport),
) -> Option<R> {
  match catch(AssertUnwindSafe(f)) {
    Ok(value) => Some(value),
    Err(exception) => {
      report(&describe(site, exception));
      None
    }
  }
}

/// `TAO_OBJC_EXCEPTION_DRILL=<keyCode>`: the embedding app's acceptance drill. When set, the
/// first keyDown with that key code raises a real NSException from inside the `sendEvent:`
/// guard, after the event was dispatched normally — the same unwind AppKit would produce,
/// through the same frames. Inert unless the variable is set.
static DRILL_KEY_CODE: Lazy<Option<u16>> =
  Lazy::new(|| parse_drill_key_code(std::env::var("TAO_OBJC_EXCEPTION_DRILL").ok()));

fn parse_drill_key_code(value: Option<String>) -> Option<u16> {
  value?.trim().parse().ok()
}

pub(crate) fn drill_matches(event: &NSEvent) -> bool {
  let Some(code) = *DRILL_KEY_CODE else {
    return false;
  };
  unsafe { event.r#type() == NSEventType::KeyDown && event.keyCode() == code }
}

pub(crate) fn drill_throw(site: &'static str) -> ! {
  raise("TaoObjcExceptionDrill", &format!("TAO_OBJC_EXCEPTION_DRILL raised at {site}"))
}

fn raise(name: &str, reason: &str) -> ! {
  let name = NSString::from_str(name);
  let reason = NSString::from_str(reason);
  let exception =
    NSException::new(&name, Some(&reason), None).expect("NSException allocation failed");
  exception.raise()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{cell::RefCell, panic::catch_unwind};

  #[test]
  fn guard_returns_the_value_when_nothing_is_thrown() {
    let reports = RefCell::new(Vec::new());
    let value = guard_with("test site", || 41 + 1, |r| reports.borrow_mut().push(r.clone()));
    assert_eq!(value, Some(42));
    assert!(reports.borrow().is_empty());
  }

  #[test]
  fn guard_catches_a_raised_nsexception_and_reports_name_reason_site_and_frames() {
    let reports = RefCell::new(Vec::new());
    let value: Option<u32> = guard_with(
      "NSApplication sendEvent:",
      || raise("TaoGuardTestException", "thrown on purpose"),
      |r| reports.borrow_mut().push(r.clone()),
    );
    assert_eq!(value, None, "the exception is swallowed, the caller continues");
    let reports = reports.borrow();
    assert_eq!(reports.len(), 1);
    let report = &reports[0];
    assert_eq!(report.site, "NSApplication sendEvent:");
    assert_eq!(report.name, "TaoGuardTestException");
    assert_eq!(report.reason, "thrown on purpose");
    assert!(
      !report.backtrace.is_empty(),
      "callStackSymbols names the Objective-C frames at the throw"
    );
    assert_eq!(
      report.summary(),
      "Objective-C exception TaoGuardTestException caught at NSApplication sendEvent:: thrown on purpose"
    );
  }

  #[test]
  fn guard_lets_rust_panics_through_untouched() {
    let result = catch_unwind(|| {
      guard_with("test site", || -> u32 { panic!("rust side") }, |_| {
        panic!("a Rust panic must not be reported as an Objective-C exception")
      })
    });
    let payload = result.expect_err("the Rust panic still unwinds out of the guard");
    assert_eq!(payload.downcast_ref::<&str>(), Some(&"rust side"));
  }

  #[test]
  fn drill_key_code_reads_a_number_and_ignores_anything_else() {
    assert_eq!(parse_drill_key_code(None), None);
    assert_eq!(parse_drill_key_code(Some("".to_string())), None);
    assert_eq!(parse_drill_key_code(Some("right".to_string())), None);
    assert_eq!(parse_drill_key_code(Some(" 124 ".to_string())), Some(124));
  }
}
