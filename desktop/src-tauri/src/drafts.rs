#[allow(unused_imports)]
use super::*;

/// Pasted-image attach: the textarea swallows image DATA, only paths ever worked. The webview hands
/// the clipboard image over as base64; this writes it under ~/.agent-bus/attachments/ and returns
/// the path the composer splices in like a drop. One attach mechanism (paths), two doors.
#[tauri::command]
pub(crate) fn save_pasted_image(data_base64: String, kind: String) -> Result<String, String> {
    use base64::Engine as _;
    if data_base64.len() > 40 * 1024 * 1024 {
        return Err("pasted image is too large (>30MB decoded)".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("clipboard image did not decode: {e}"))?;
    if bytes.is_empty() {
        return Err("clipboard image was empty".into());
    }
    let ext = match kind.as_str() {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    let dir = desktop_bus_dir().join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("attachments dir: {e}"))?;
    let name = format!(
        "pasted-{}.{ext}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let path = dir.join(name);
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// #6104 — dirty drafts survive an app exit. The editor's store is in-memory and dies with the
/// process, so the view persists every dirty draft here — one JSON file per document under
/// ~/.agent-bus/drafts/<project>/ — and reads it back the next time the file is opened. Quitting
/// is not a way to lose work.
pub(crate) fn drafts_dir(project: &str) -> Result<std::path::PathBuf, String> {
    // The project name comes from the hub; it must never walk the filesystem.
    if project.is_empty() || project.contains('/') || project.contains('\\') || project.contains("..") {
        return Err("unsafe project name".into());
    }
    Ok(desktop_bus_dir().join("drafts").join(project))
}

/// One file per document: the md5 of the tab KEY (scope:path — the same identity the editor's
/// store uses) names it, and the JSON inside carries the path again so a read verifies itself.
pub(crate) fn draft_file_name(seat: Option<&str>, path: &str) -> String {
    let key = format!("{}:{path}", seat.unwrap_or("project"));
    format!("{:x}.json", md5::compute(key.as_bytes()))
}

#[derive(Debug, Serialize, serde::Deserialize)]
pub(crate) struct DraftEntry {
    path: String,
    seat: Option<String>,
    text: String,
    ts: u64,
}

#[tauri::command]
pub(crate) fn draft_persist(project: String, path: String, seat: Option<String>, text: String) -> Result<(), String> {
    let dir = drafts_dir(&project)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("drafts dir: {e}"))?;
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entry = DraftEntry { path, text, seat, ts };
    let name = draft_file_name(entry.seat.as_deref(), &entry.path);
    serde_json::to_string(&entry)
        .map_err(|e| format!("draft entry: {e}"))
        .and_then(|json| {
            std::fs::write(dir.join(name), json).map_err(|e| format!("draft write: {e}"))
        })
}

/// The draft persisted at the last exit, or "" when there is none. A stored entry whose path no
/// longer matches (hash collision, hand-edited file) reads as none — the read verifies itself.
#[tauri::command]
pub(crate) fn draft_load(project: String, path: String, seat: Option<String>) -> Result<String, String> {
    let file = drafts_dir(&project)?.join(draft_file_name(seat.as_deref(), &path));
    let Ok(raw) = std::fs::read_to_string(file) else {
        return Ok(String::new());
    };
    let Ok(entry) = serde_json::from_str::<DraftEntry>(&raw) else {
        return Ok(String::new());
    };
    if entry.path != path || entry.seat.as_deref() != seat.as_deref() {
        return Ok(String::new());
    }
    Ok(entry.text)
}

/// Saving (or undoing back to the disk) retires the persisted draft. Absent is not an error.
#[tauri::command]
pub(crate) fn draft_forget(project: String, path: String, seat: Option<String>) -> Result<(), String> {
    let file = drafts_dir(&project)?.join(draft_file_name(seat.as_deref(), &path));
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("draft forget: {e}")),
    }
}

#[cfg(test)]
mod draft_tests {
    use super::{draft_file_name, drafts_dir};

    #[test]
    fn draft_names_are_stable_and_scope_aware() {
        // The same (scope, path) always lands on the same file…
        assert_eq!(
            draft_file_name(None, "/repo/src/a.ts"),
            draft_file_name(None, "/repo/src/a.ts")
        );
        // …and the same path under two scopes is two drafts — the editor's own key anatomy.
        assert_ne!(
            draft_file_name(None, "/repo/src/a.ts"),
            draft_file_name(Some("qwen"), "/repo/src/a.ts")
        );
        assert_ne!(
            draft_file_name(None, "/repo/src/a.ts"),
            draft_file_name(None, "/repo/src/b.ts")
        );
    }

    #[test]
    fn drafts_dir_refuses_a_project_name_that_could_walk_the_filesystem() {
        assert!(drafts_dir("").is_err());
        assert!(drafts_dir("../escape").is_err());
        assert!(drafts_dir("a/b").is_err());
        assert!(drafts_dir("a\\b").is_err());
        // A plain project name resolves under the drafts root.
        let ok = drafts_dir("trantor").expect("plain name is safe");
        assert!(ok.ends_with("drafts/trantor") || ok.to_string_lossy().ends_with("drafts\\trantor"));
    }
}

/// The attachment chip's facts off the disk (#6070): size, plus a `data:` thumbnail for a small
/// image. None (not an error) when the path is not a file: a chip degrades to name-only.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct AttachmentInfo {
    bytes: u64,
    thumb: Option<String>,
}

/// Extensions the webview can actually decode. heic and friends stay out on purpose — a data URI
/// it cannot paint is worse than the icon fallback the chip then shows.
pub(crate) fn thumb_mime(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// The inline ceiling: a chip is a small face and base64 adds a third — a four-megabyte screenshot
/// earns the icon fallback instead of four megabytes of DOM string.
pub(crate) const THUMB_CAP: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub(crate) fn attachment_info(path: String) -> Option<AttachmentInfo> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || !p.is_file() {
        return None;
    }
    let Ok(meta) = std::fs::metadata(p) else {
        return None;
    };
    let bytes = meta.len();
    let thumb = thumb_mime(p)
        .filter(|_| bytes > 0 && bytes <= THUMB_CAP)
        .and_then(|mime| {
            std::fs::read(p)
                .ok()
                .map(|raw| format!("data:{mime};base64,{}", b64(&raw)))
        });
    Some(AttachmentInfo { bytes, thumb })
}
