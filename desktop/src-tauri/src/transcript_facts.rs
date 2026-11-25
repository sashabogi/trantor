// Facts read off one transcript row for the prompt timeline: when it was written and which file an edit touched (#14084).

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

/// The file an edit-family tool call targets (#14084): the tool's own `file_path` input, with
/// the row's `cwd` prefix stripped so the path is checkout-relative the way git status paths
/// are and a change intent can match it. A path the row cannot place (no cwd, or outside it)
/// stays exactly as recorded; every other tool keeps None.
pub(crate) fn edit_target_path(name: &str, input: &serde_json::Value, cwd: &str) -> Option<String> {
    if !matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
        return None;
    }
    // NotebookEdit names its target notebook_path; the other three use file_path.
    let raw = input.get("file_path").or_else(|| input.get("notebook_path"))?.as_str()?;
    let cwd = cwd.trim_end_matches('/');
    if !cwd.is_empty() {
        if let Some(rest) = raw.strip_prefix(cwd).and_then(|r| r.strip_prefix('/')) {
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
}
