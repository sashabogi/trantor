//! #6800: Drill Mode's evidence capture. `drill_screenshot` shells to `screencapture` (cropped to the
//! main window when it can report a rect) and writes under `<bus dir>/drills/`; the label is the
//! card id, sanitized, never trusted as a path. `drill_key_post` posts the #6317 right-arrow through
//! AppKit's queue; `drill_panics_since` reads app-panics.log past a byte mark. Webview-only.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A file-name-safe stem: letters, digits, dash, underscore; anything else becomes a dash and
/// the result is capped so a runaway label cannot make an unwritable name.
pub(crate) fn safe_label(label: &str) -> String {
    let mut out: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    out.truncate(48);
    if out.trim_matches('-').is_empty() {
        "shot".to_string()
    } else {
        out
    }
}

pub(crate) fn screenshot_path(dir: &Path, label: &str, unix_ms: u128) -> PathBuf {
    dir.join(format!("{unix_ms}-{}.png", safe_label(label)))
}

/// `screencapture -R x,y,w,h` takes points; tauri reports the outer rect in physical pixels with
/// the scale factor alongside, so the rect is divided back. A rect the window cannot report
/// (minimised, off-screen) yields None and the caller captures the whole screen.
pub(crate) fn region_arg(x: i32, y: i32, w: u32, h: u32, scale: f64) -> Option<String> {
    if w == 0 || h == 0 || !(scale > 0.0) {
        return None;
    }
    let s = |v: f64| (v / scale).round() as i64;
    Some(format!("{},{},{},{}", s(x as f64), s(y as f64), s(w as f64), s(h as f64)))
}

#[tauri::command]
pub(crate) fn drill_screenshot(window: tauri::Window, label: String) -> Result<String, String> {
    let dir = crate::desktop_bus_dir().join("drills");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let path = screenshot_path(&dir, &label, ms);

    let region = match (window.outer_position(), window.outer_size(), window.scale_factor()) {
        (Ok(pos), Ok(size), Ok(scale)) => region_arg(pos.x, pos.y, size.width, size.height, scale),
        _ => None,
    };
    let mut cmd = std::process::Command::new("screencapture");
    cmd.arg("-x");
    if let Some(r) = region {
        cmd.arg("-R").arg(r);
    }
    cmd.arg(&path);
    let out = cmd.output().map_err(|e| format!("screencapture failed to start: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "screencapture exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    if !path.is_file() {
        return Err(format!("screencapture wrote nothing at {}", path.display()));
    }
    Ok(path.to_string_lossy().to_string())
}

/// What app-panics.log wrote after `from`: the new length (the next mark) and the text between.
/// A mark past the end (the log was truncated) reads from the start, so nothing is hidden.
pub(crate) fn panics_since(log: &str, from: usize) -> (usize, String) {
    let start = if from > log.len() { 0 } else { from };
    (log.len(), log[start..].to_string())
}

#[derive(serde::Serialize)]
pub(crate) struct PanicsSince {
    len: usize,
    text: String,
}

#[tauri::command]
pub(crate) fn drill_panics_since(from: usize) -> Result<PanicsSince, String> {
    let path = crate::desktop_bus_dir().join("app-panics.log");
    let log = std::fs::read_to_string(&path).unwrap_or_default();
    let (len, text) = panics_since(&log, from);
    Ok(PanicsSince { len, text })
}

/// Drill Mode's #6317 step: one real right-arrow keyDown/keyUp through AppKit into the key
/// window, the same post the headless key drill makes, on the operator's press.
#[tauri::command]
pub(crate) fn drill_key_post(app: tauri::AppHandle, target: String) -> Result<(), String> {
    crate::app_trace(&format!("drill-mode key posting right-arrow focus={target}"));
    app.run_on_main_thread(|| crate::key_drill::post_right_arrow(0))
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panics_since_returns_only_what_landed_after_the_mark() {
        let log = "1 first\n2 second\n";
        assert_eq!(panics_since(log, 0), (log.len(), log.to_string()));
        assert_eq!(panics_since(log, 8), (log.len(), "2 second\n".to_string()));
        assert_eq!(panics_since(log, log.len()), (log.len(), String::new()));
        assert_eq!(panics_since(log, 999), (log.len(), log.to_string()), "a truncated log reads from the start");
        assert_eq!(panics_since("", 0), (0, String::new()));
    }

    #[test]
    fn label_is_sanitized_never_a_path() {
        assert_eq!(safe_label("card-6701"), "card-6701");
        assert_eq!(safe_label("../../etc/passwd"), "------etc-passwd");
        assert_eq!(safe_label(""), "shot");
        assert_eq!(safe_label("///"), "shot");
        assert_eq!(safe_label(&"x".repeat(100)).len(), 48);
    }

    #[test]
    fn path_lands_under_the_drills_dir_with_a_sortable_stamp() {
        let p = screenshot_path(Path::new("/tmp/bus/drills"), "card-5993", 1_700_000_000_123);
        assert_eq!(p, PathBuf::from("/tmp/bus/drills/1700000000123-card-5993.png"));
    }

    #[test]
    fn region_divides_physical_pixels_by_the_scale_factor() {
        assert_eq!(region_arg(200, 100, 2400, 1600, 2.0).as_deref(), Some("100,50,1200,800"));
        assert_eq!(region_arg(0, 0, 0, 10, 2.0), None);
        assert_eq!(region_arg(0, 0, 10, 10, 0.0), None);
    }
}
