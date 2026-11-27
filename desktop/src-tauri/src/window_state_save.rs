// #14513: window state must survive a kill, not only the plugin's clean-exit write. The plugin
// flushes the file on RunEvent::Exit; an update install or a signal ends the process without
// that event, so the relaunch restores a stale snapshot. This module flushes on the main
// window's own geometry events instead, debounced. The plugin and its exit write stay.
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_window_state::AppHandleExt;

/// How long the geometry stream must be quiet before a save: ~500ms, so a drag burst writes
/// once after it settles instead of on every mouse move.
pub(crate) const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

/// The window events that carry new geometry: Moved and Resized. Fullscreen has no event of
/// its own — enter and exit arrive as Resized — so it rides along, and a save reads the live
/// fullscreen state anyway. Pure over the event so cargo test can pin the rule.
pub(crate) fn is_geometry_event(event: &WindowEvent) -> bool {
    matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_))
}

/// Arm the debounced saver on the main window: every geometry event pings a watcher thread,
/// which waits for the stream to go quiet, then flushes the state file on the main thread
/// (AppKit geometry reads are main-thread-only). A closed channel ends the thread; the
/// plugin's exit write and in-memory cache are untouched.
pub(crate) fn arm(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return; };
    let (tx, rx) = mpsc::channel::<()>();
    let app = app.clone();
    window.on_window_event(move |event| {
        if is_geometry_event(event) {
            let _ = tx.send(());
        }
    });
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // Each arriving ping resets the quiet window; a burst is one save at its end.
            while rx.recv_timeout(SAVE_DEBOUNCE).is_ok() {}
            let app = app.clone();
            let _ = app.run_on_main_thread(move || {
                // A failed write is dropped the way the plugin drops its own exit write.
                let _ = app.save_window_state(tauri_plugin_window_state::StateFlags::all());
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn moved_and_resized_carry_geometry_and_the_rest_does_not() {
        assert!(is_geometry_event(&WindowEvent::Moved(PhysicalPosition::new(10, 20))));
        assert!(is_geometry_event(&WindowEvent::Resized(PhysicalSize::new(800, 600))));
        // Fullscreen enter/exit arrives as Resized, so it is covered by the same arm.
        assert!(is_geometry_event(&WindowEvent::Resized(PhysicalSize::new(1920, 1080))));
        assert!(!is_geometry_event(&WindowEvent::Focused(true)));
        assert!(!is_geometry_event(&WindowEvent::Focused(false)));
        assert!(!is_geometry_event(&WindowEvent::Destroyed));
    }

    #[test]
    fn the_debounce_window_is_about_half_a_second() {
        // ~500ms: short enough that a quit soon after a move still finds the new state on
        // disk, long enough that a drag never writes on every event.
        assert!(SAVE_DEBOUNCE >= Duration::from_millis(400));
        assert!(SAVE_DEBOUNCE <= Duration::from_millis(600));
    }
}
