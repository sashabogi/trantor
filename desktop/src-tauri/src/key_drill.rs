//! #6317: the Objective-C exception reporter and the built-app key-injection drill.
//!
//! Three SIGABRTs on macOS 26 (2026-09-03 x2, 2026-09-07) logged only "panic in a function that
//! cannot unwind" from tao's `sendEvent:` override, with no first Rust panic anywhere: an
//! Objective-C exception thrown by AppKit during key dispatch unwound through that `extern "C"`
//! frame. The vendored tao now catches it at the boundary and calls the reporter installed here,
//! which lands the exception's name, reason and Objective-C call stack in app-panics.log.
//!
//! `TRANTOR_KEY_DRILL=post`: after boot the Rust shell emits `key-drill`; the frontend
//! (src/features/workspace/keyDrill.ts) focuses nothing, then the terminal pane, then any other
//! textarea, and for each asks Rust to post a right-arrow keyDown/keyUp through AppKit's real
//! event queue (`[NSApp postEvent:atStart:]` -> `-[NSApplication _handleEvent:]` -> tao's
//! `sendEvent:` override -> the webview). The 09-07 crash was that key in that pane.
//! `TRANTOR_KEY_DRILL=throw`: the same, and tao raises a real NSException from inside its
//! `sendEvent:` guard on the first right-arrow keyDown, so the run proves the boundary catches,
//! names and survives the exception the crash reports could never show. The process exits 0 when
//! the app survived (and, in throw mode, app-panics.log names the drill's exception), 3
//! otherwise. Inert unless the variable is set. The seat writes this drill; the orchestrator
//! builds and runs it.
//!
//! `TRANTOR_KEY_DRILL_PROJECT=<project name>`: the 09-07 run on 0.3.159 posted into "no key
//! window" (the drill instance launched behind the operator's app) and skipped passes 2 and 3
//! (no project open, so no terminal pane in the DOM). `arm` now makes the main window key before
//! it emits, and the payload names the project the frontend opens on its Workspace lens so the
//! terminal pane mounts. The value is the sidebar's project name, the same one TRANTOR_ASK_DRILL
//! takes.

use std::sync::OnceLock;
use std::time::Duration;

pub const ENV: &str = "TRANTOR_KEY_DRILL";
pub const PROJECT_ENV: &str = "TRANTOR_KEY_DRILL_PROJECT";
const TAO_DRILL_ENV: &str = "TAO_OBJC_EXCEPTION_DRILL";
const RIGHT_ARROW_KEY_CODE: u16 = 124;
/// NSRightArrowFunctionKey: the `characters` AppKit puts on a right-arrow key event.
const RIGHT_ARROW_CHARS: &str = "\u{F703}";
/// The NSException name tao's drill raises (vendor/tao-0.35.3 objc_exception.rs).
const DRILL_EXCEPTION_NAME: &str = "TaoObjcExceptionDrill";

/// app-panics.log length when the drill was armed: the verdict reads only what this run wrote.
static PANICS_LOG_START: OnceLock<u64> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Post,
    Throw,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Post => "post",
            Mode::Throw => "throw",
        }
    }
}

pub fn parse_mode(value: Option<&str>) -> Option<Mode> {
    match value.map(str::trim) {
        Some("post") | Some("1") => Some(Mode::Post),
        Some("throw") => Some(Mode::Throw),
        _ => None,
    }
}

fn mode_from_env() -> Option<Mode> {
    let value = std::env::var(ENV).ok()?;
    parse_mode(Some(&value))
}

fn project_from_env() -> Option<String> {
    let value = std::env::var(PROJECT_ENV).ok()?;
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// The `key-drill` event payload: the validated mode plus the project to stage, or null.
pub fn payload(mode: Mode, project: Option<&str>) -> String {
    serde_json::json!({ "mode": mode.as_str(), "project": project }).to_string()
}

/// Route every Objective-C exception the vendored tao catches into app-panics.log (name, reason,
/// the exception's Objective-C call stack) and app-trace.log. Runs on the thread that caught it.
pub fn install_objc_exception_reporter() {
    #[cfg(target_os = "macos")]
    {
        let installed = tao::platform::macos::set_objc_exception_reporter(|report| {
            let frames: Vec<String> = report
                .backtrace
                .iter()
                .map(|frame| format!("    {frame}"))
                .collect();
            crate::append_panic_log(&report.summary(), report.site, &frames.join("\n"));
            crate::app_trace(&format!("objc-exception {}", report.summary()));
        });
        if !installed {
            crate::app_trace("objc-exception reporter: one was already installed");
        }
    }
}

/// Before `tauri::Builder`: in throw mode, arm tao's drill. tao reads its variable lazily on the
/// first `sendEvent:`, which can precede `setup`, so this must run first.
pub fn prepare() {
    let Some(mode) = mode_from_env() else {
        return;
    };
    let _ = PANICS_LOG_START.set(panics_log_len());
    if mode == Mode::Throw {
        std::env::set_var(TAO_DRILL_ENV, RIGHT_ARROW_KEY_CODE.to_string());
    }
}

/// In `setup`: when armed, tell the webview to start once it has had time to mount.
pub fn arm(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let Some(mode) = mode_from_env() else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        crate::app_trace("key-drill ERROR no main window to drive");
        return;
    };
    let project = project_from_env();
    crate::app_trace(&format!(
        "key-drill armed mode={} project={}",
        mode.as_str(),
        project.as_deref().unwrap_or("-")
    ));
    let payload = payload(mode, project.as_deref());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        // Make this window key before the first post: on macOS tao's set_focus is
        // makeKeyAndOrderFront + activateIgnoringOtherApps, so a drill instance launched behind
        // the operator's app no longer posts into "no key window".
        match window.set_focus() {
            Ok(()) => crate::app_trace("key-drill made the main window key"),
            Err(err) => crate::app_trace(&format!("key-drill ERROR set_focus: {err}")),
        }
        let _ = window.emit("key-drill", payload);
    });
}

/// Post a right-arrow keyDown + keyUp to the key window through AppKit's own event queue.
/// Refuses unless the drill is armed: a normal run never injects keys.
#[tauri::command]
pub fn key_drill_post(
    app: tauri::AppHandle,
    pass: u32,
    target: String,
    editable: bool,
) -> Result<(), String> {
    if mode_from_env().is_none() {
        return Err(format!("{ENV} is not set; refusing to inject key events"));
    }
    crate::app_trace(&format!(
        "key-drill pass={pass} focus={target} editable={editable} posting right-arrow keyDown+keyUp keyCode={RIGHT_ARROW_KEY_CODE}"
    ));
    app.run_on_main_thread(move || post_right_arrow(pass))
        .map_err(|err| err.to_string())
}

/// Also Drill Mode's key step (#6800, drill_mode.rs): the same post, driven by the operator.
#[cfg(target_os = "macos")]
pub(crate) fn post_right_arrow(pass: u32) {
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSProcessInfo, NSString};

    let Some(mtm) = MainThreadMarker::new() else {
        crate::app_trace(&format!("key-drill pass={pass} ERROR not on the main thread"));
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    let key = app.keyWindow();
    let is_key = key.is_some();
    let Some(window) = key.or_else(|| app.mainWindow()) else {
        crate::app_trace(&format!("key-drill pass={pass} ERROR no key window"));
        return;
    };
    if !is_key {
        crate::app_trace(&format!("key-drill pass={pass} main window is not key; posting to it anyway"));
    }
    let window_number = window.windowNumber();
    let flags = NSEventModifierFlags::NumericPad | NSEventModifierFlags::Function;
    let chars = NSString::from_str(RIGHT_ARROW_CHARS);
    let uptime = NSProcessInfo::processInfo().systemUptime();
    for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            flags,
            uptime,
            window_number,
            None,
            &chars,
            &chars,
            false,
            RIGHT_ARROW_KEY_CODE,
        );
        match event {
            Some(event) => app.postEvent_atStart(&event, false),
            None => crate::app_trace(&format!(
                "key-drill pass={pass} ERROR NSEvent construction returned nil"
            )),
        }
    }
    crate::app_trace(&format!(
        "key-drill pass={pass} posted keyDown+keyUp keyCode={RIGHT_ARROW_KEY_CODE} window={window_number}"
    ));
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn post_right_arrow(pass: u32) {
    crate::app_trace(&format!("key-drill pass={pass} ERROR only implemented on macOS"));
}

/// The frontend's last call: every pass was posted and the app is still here. Leaves the run
/// loop time to drain, then exits with the verdict.
#[tauri::command]
pub fn key_drill_finish(summary: String) -> Result<(), String> {
    let Some(mode) = mode_from_env() else {
        return Err(format!("{ENV} is not set"));
    };
    crate::app_trace(&format!("key-drill survived: {summary}"));
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let start = PANICS_LOG_START.get().copied().unwrap_or(0) as usize;
        let log = read_panics_log();
        let written = log.get(start..).unwrap_or("");
        let code = verdict(mode, written);
        crate::app_trace(&format!("key-drill verdict exit={code}"));
        std::process::exit(code);
    });
    Ok(())
}

fn panics_log_path() -> std::path::PathBuf {
    crate::desktop_bus_dir().join("app-panics.log")
}

fn panics_log_len() -> u64 {
    std::fs::metadata(panics_log_path())
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn read_panics_log() -> String {
    std::fs::read_to_string(panics_log_path()).unwrap_or_default()
}

/// Exit code for a run that reached `key_drill_finish`: 0 when the app survived every pass and,
/// in throw mode, this run's app-panics.log entries name the drill's exception; 3 otherwise.
pub fn verdict(mode: Mode, panics_written_this_run: &str) -> i32 {
    match mode {
        Mode::Post => 0,
        Mode::Throw if panics_written_this_run.contains(DRILL_EXCEPTION_NAME) => 0,
        Mode::Throw => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parses_post_throw_and_nothing_else() {
        assert_eq!(parse_mode(None), None);
        assert_eq!(parse_mode(Some("")), None);
        assert_eq!(parse_mode(Some("yes")), None);
        assert_eq!(parse_mode(Some("post")), Some(Mode::Post));
        assert_eq!(parse_mode(Some("1")), Some(Mode::Post));
        assert_eq!(parse_mode(Some(" throw ")), Some(Mode::Throw));
    }

    #[test]
    fn payload_carries_the_mode_and_the_project_or_null() {
        assert_eq!(payload(Mode::Post, None), r#"{"mode":"post","project":null}"#);
        assert_eq!(
            payload(Mode::Throw, Some("drill-key")),
            r#"{"mode":"throw","project":"drill-key"}"#
        );
    }

    #[test]
    fn verdict_needs_the_drill_exception_in_this_runs_log_only_in_throw_mode() {
        assert_eq!(verdict(Mode::Post, ""), 0);
        assert_eq!(verdict(Mode::Throw, ""), 3);
        assert_eq!(
            verdict(Mode::Throw, "1788 thread=main Objective-C exception NSRangeException caught at NSApplication sendEvent:: x\n"),
            3,
            "someone else's exception is not the drill's"
        );
        assert_eq!(
            verdict(Mode::Throw, "1788 thread=main Objective-C exception TaoObjcExceptionDrill caught at NSApplication sendEvent:: TAO_OBJC_EXCEPTION_DRILL raised at NSApplication sendEvent:\n"),
            0
        );
    }
}
