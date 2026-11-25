// Facts read off one transcript row for the prompt timeline: when it was written and which file an edit touched (#14084).
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Days since 1970-01-01 from a civil date (Howard Hinnant's `days_from_civil`): the one date
/// fact this file needs without a date crate, valid across the whole Gregorian range.
fn days_from_civil(y: i64, m: u64, d: u64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp as i64 + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A transcript row's `timestamp` (ISO-8601 UTC, "YYYY-MM-DDTHH:MM:SS.mmmZ", as a Claude Code
/// jsonl writes it) as epoch ms (#14084). The fixed shape is read by hand; anything else stays
/// None, so an unreadable time renders as no time, never a guess.
pub(crate) fn row_ts(v: &serde_json::Value) -> Option<u64> {
    let s = v.get("timestamp")?.as_str()?;
    let b = s.as_bytes();
    let num = |from: usize, to: usize| -> Option<u64> {
        let mut n: u64 = 0;
        for &c in b.get(from..to)? {
            if !c.is_ascii_digit() {
                return None;
            }
            n = n * 10 + u64::from(c - b'0');
        }
        Some(n)
    };
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let mut end = 19;
    let mut millis = 0u64;
    if b.get(19) == Some(&b'.') {
        let start = 20;
        end = start;
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
        for (place, &c) in b[start..end].iter().take(3).enumerate() {
            millis += u64::from(c - b'0') * 10u64.pow(2 - place as u32);
        }
    }
    if b.get(end) != Some(&b'Z') {
        return None;
    }
    let year = num(0, 4)? as i64;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let secs = days_from_civil(year, month, day) * 86_400 + (hour * 3_600 + minute * 60 + second) as i64;
    if secs < 0 {
        return None;
    }
    Some(secs as u64 * 1_000 + millis)
}

/// The checkout a row's folder sits in: the nearest folder at or above it that holds a `.git`
/// entry. Cached per folder, since a transcript repeats a handful of folders thousands of times.
fn checkout_root(cwd: &str) -> Option<String> {
    static ROOTS: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let mut roots = crate::lock_or_recover(ROOTS.get_or_init(Default::default));
    if let Some(found) = roots.get(cwd) {
        return found.clone();
    }
    let found = Path::new(cwd)
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .map(|dir| dir.to_string_lossy().into_owned());
    roots.insert(cwd.to_string(), found.clone());
    found
}

/// The file an edit-family tool call targets (#14084): the tool's own `file_path` input, made
/// relative to the checkout the way git status paths are, so the Code screen can open it. The
/// row's `cwd` only locates the checkout: a session that ran `cd` into a subfolder still names
/// files from the root. A path outside the checkout stays as recorded; other tools keep None.
pub(crate) fn edit_target_path(name: &str, input: &serde_json::Value, cwd: &str) -> Option<String> {
    if !matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
        return None;
    }
    // NotebookEdit names its target notebook_path; the other three use file_path.
    let raw = input.get("file_path").or_else(|| input.get("notebook_path"))?.as_str()?;
    let cwd = cwd.trim_end_matches('/');
    if !cwd.is_empty() {
        let base = checkout_root(cwd).unwrap_or_else(|| cwd.to_string());
        if let Some(rest) = raw.strip_prefix(base.trim_end_matches('/')).and_then(|r| r.strip_prefix('/')) {
            return Some(rest.to_string());
        }
    }
    Some(raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notebook_edit_names_its_notebook() {
        let input = serde_json::json!({ "notebook_path": "/repo/notes/n.ipynb" });
        assert_eq!(edit_target_path("NotebookEdit", &input, "/repo").as_deref(), Some("notes/n.ipynb"));
        assert_eq!(edit_target_path("Read", &input, "/repo"), None);
    }

    // Drill on the built app: a file written while the session sat in desktop/src/v2 was named
    // shell/shellMode.ts, and the Code screen could not read it.
    #[test]
    fn a_path_is_named_from_the_checkout_even_when_the_row_sat_in_a_subfolder() {
        let root = std::env::temp_dir().join(format!("trantor-facts-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("desktop/src/v2");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let root = root.canonicalize().unwrap();
        let file = root.join("desktop/src/v2/shell/shellMode.ts");
        let input = serde_json::json!({ "file_path": file.to_string_lossy() });
        let cwd = root.join("desktop/src/v2");
        assert_eq!(
            edit_target_path("Write", &input, &cwd.to_string_lossy()).as_deref(),
            Some("desktop/src/v2/shell/shellMode.ts")
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
