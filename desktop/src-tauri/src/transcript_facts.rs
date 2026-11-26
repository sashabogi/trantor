// Facts read off one transcript row for the prompt timeline: when it was written and which file an edit touched (#14084).
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

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

/// One line of a changed-lines preview: `op` is "+" or "-".
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct DiffLine {
    pub(crate) op: &'static str,
    pub(crate) text: String,
}

/// Structured facts about one tool call (#14327), so the chat can fold, phrase and preview it
/// without re-parsing the summary string. Every field is absent when it does not apply.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub(crate) struct ToolFacts {
    /// "explore" | "edit" | "write" | "command" | "commit" | "todo" | "other"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_kind: Option<&'static str>,
    /// Target paths, absolute against the row's cwd.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) removed: Option<u32>,
    /// Up to DIFF_LINES changed lines.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) diff: Option<Vec<DiffLine>>,
}

const DIFF_LINES: usize = 8;

const EXPLORE_COMMANDS: &[&str] = &["cat", "head", "tail", "grep", "rg", "ls", "find", "wc", "cd", "pwd"];

/// Does one shell segment run `git commit` (allowing `git -C dir commit`, `git -c k=v commit`)?
fn segment_is_git_commit(words: &[&str]) -> bool {
    if words.first() != Some(&"git") {
        return false;
    }
    let mut i = 1;
    while i < words.len() {
        let w = words[i];
        if w == "-C" || w == "-c" {
            i += 2;
            continue;
        }
        if w.starts_with('-') {
            i += 1;
            continue;
        }
        return w == "commit";
    }
    false
}

fn segment_is_explore(words: &[&str]) -> bool {
    match words.first() {
        Some(&"sed") => words.iter().any(|w| *w == "-n" || (w.starts_with("-n") && !w.starts_with("--"))),
        Some(w) => EXPLORE_COMMANDS.contains(w),
        None => false,
    }
}

/// "commit" when any segment of the command line runs `git commit`; "explore" when every segment
/// is a read-only look (cat/sed -n/head/tail/grep/rg/ls/find/wc); otherwise "command".
pub(crate) fn classify_command(command: &str) -> &'static str {
    let spaced = command.replace("&&", "\n").replace("||", "\n").replace([';', '|'], "\n");
    let segments: Vec<Vec<&str>> = spaced
        .lines()
        .map(|seg| seg.split_whitespace().collect::<Vec<_>>())
        .filter(|w| !w.is_empty())
        .collect();
    if segments.iter().any(|w| segment_is_git_commit(w)) {
        return "commit";
    }
    if !segments.is_empty() && segments.iter().all(|w| segment_is_explore(w)) {
        return "explore";
    }
    "command"
}

fn absolute(raw: &str, cwd: &str) -> String {
    if raw.starts_with('/') || raw.starts_with('~') || cwd.is_empty() {
        raw.to_string()
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), raw.trim_start_matches("./"))
    }
}

/// Lines changed between two strings: identical leading and trailing lines are not changes.
fn changed_lines(old: &str, new: &str) -> (Vec<String>, Vec<String>) {
    let o: Vec<&str> = old.lines().collect();
    let n: Vec<&str> = new.lines().collect();
    let mut head = 0;
    while head < o.len() && head < n.len() && o[head] == n[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < o.len() - head && tail < n.len() - head && o[o.len() - 1 - tail] == n[n.len() - 1 - tail] {
        tail += 1;
    }
    (
        o[head..o.len() - tail].iter().map(|s| s.to_string()).collect(),
        n[head..n.len() - tail].iter().map(|s| s.to_string()).collect(),
    )
}

/// Classify a tool call and pull out what the chat shows about it.
pub(crate) fn tool_facts(name: &str, input: &serde_json::Value, cwd: &str) -> ToolFacts {
    let str_of = |k: &str| input.get(k).and_then(|v| v.as_str());
    let mut facts = ToolFacts::default();
    match name {
        "Read" | "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => {
            if let Some(p) = str_of("file_path").or_else(|| str_of("notebook_path")) {
                facts.paths = Some(vec![absolute(p, cwd)]);
            }
        }
        "Grep" | "Glob" | "LS" => {
            let p = str_of("path").map(|p| absolute(p, cwd)).or_else(|| (!cwd.is_empty()).then(|| cwd.to_string()));
            facts.paths = p.map(|p| vec![p]);
        }
        _ => {}
    }
    facts.tool_kind = Some(match name {
        "Read" | "Grep" | "Glob" | "LS" | "WebFetch" | "WebSearch" => "explore",
        "Edit" | "MultiEdit" | "NotebookEdit" => "edit",
        "Write" => "write",
        "TodoWrite" => "todo",
        "Bash" => classify_command(str_of("command").unwrap_or("")),
        _ => "other",
    });
    let removed_lines: Vec<String>;
    let added_lines: Vec<String>;
    match name {
        "Edit" => {
            (removed_lines, added_lines) = changed_lines(str_of("old_string").unwrap_or(""), str_of("new_string").unwrap_or(""));
        }
        "MultiEdit" => {
            let mut r = Vec::new();
            let mut a = Vec::new();
            for e in input.get("edits").and_then(|e| e.as_array()).into_iter().flatten() {
                let old = e.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
                let new = e.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
                let (er, ea) = changed_lines(old, new);
                r.extend(er);
                a.extend(ea);
            }
            removed_lines = r;
            added_lines = a;
        }
        "Write" => {
            removed_lines = Vec::new();
            added_lines = str_of("content").unwrap_or("").lines().map(String::from).collect();
        }
        _ => return facts,
    }
    facts.added = Some(added_lines.len() as u32);
    facts.removed = Some(removed_lines.len() as u32);
    let diff: Vec<DiffLine> = removed_lines
        .into_iter()
        .map(|text| DiffLine { op: "-", text })
        .chain(added_lines.into_iter().map(|text| DiffLine { op: "+", text }))
        .take(DIFF_LINES)
        .collect();
    facts.diff = Some(diff);
    facts
}

/// Exit code of a Bash result: the "Exit code N" line the CLI prepends to a failing command's
/// output; a clean result without it is 0; an error without the line is unknown (None).
pub(crate) fn bash_exit_code(preview: &str, is_error: bool) -> Option<i32> {
    let first = preview.lines().next().unwrap_or("").trim();
    if let Some(n) = first.strip_prefix("Exit code ") {
        return n.trim().parse().ok();
    }
    if is_error { None } else { Some(0) }
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

    fn facts(name: &str, input: serde_json::Value) -> ToolFacts {
        tool_facts(name, &input, "/repo")
    }

    #[test]
    fn commands_classify_as_explore_commit_or_command() {
        for c in ["cat a.ts", "sed -n 1,20p a.ts", "head -5 x | wc -l", "cd /repo && rg foo src", "ls -la", "find . -name x", "tail -f log"] {
            assert_eq!(classify_command(c), "explore", "{c}");
        }
        for c in ["git commit -m x", "git add . && git commit -m 'y'", "git -C /r commit --amend"] {
            assert_eq!(classify_command(c), "commit", "{c}");
        }
        for c in ["sed -i s/a/b/ f", "npm test", "cat a && npm test", "git status", "git log --grep=commit", ""] {
            assert_eq!(classify_command(c), "command", "{c}");
        }
    }

    #[test]
    fn tools_classify_by_name_with_absolute_paths() {
        let r = facts("Read", serde_json::json!({ "file_path": "src/a.ts" }));
        assert_eq!(r.tool_kind, Some("explore"));
        assert_eq!(r.paths, Some(vec!["/repo/src/a.ts".to_string()]));
        let g = facts("Grep", serde_json::json!({ "pattern": "x" }));
        assert_eq!(g.paths, Some(vec!["/repo".to_string()]), "a search with no path covers the cwd");
        assert_eq!(facts("Glob", serde_json::json!({ "pattern": "*.rs", "path": "/abs" })).paths, Some(vec!["/abs".to_string()]));
        assert_eq!(facts("TodoWrite", serde_json::json!({})).tool_kind, Some("todo"));
        assert_eq!(facts("WebFetch", serde_json::json!({ "url": "u" })).tool_kind, Some("explore"));
        assert_eq!(facts("Task", serde_json::json!({})).tool_kind, Some("other"));
        assert_eq!(facts("Bash", serde_json::json!({ "command": "npm test" })).tool_kind, Some("command"));
        assert_eq!(facts("Bash", serde_json::json!({ "command": "git commit -m x" })).tool_kind, Some("commit"));
    }

    #[test]
    fn an_edit_counts_only_changed_lines_and_keeps_a_diff_preview() {
        let f = facts(
            "Edit",
            serde_json::json!({ "file_path": "/repo/a.ts", "old_string": "keep\nold1\nold2\ntail", "new_string": "keep\nnew1\ntail" }),
        );
        assert_eq!(f.tool_kind, Some("edit"));
        assert_eq!((f.added, f.removed), (Some(1), Some(2)));
        let d = f.diff.unwrap();
        assert_eq!(d.iter().map(|l| format!("{}{}", l.op, l.text)).collect::<Vec<_>>(), ["-old1", "-old2", "+new1"]);
    }

    #[test]
    fn a_multi_edit_sums_its_edits_and_the_diff_is_capped_at_eight_lines() {
        let f = facts(
            "MultiEdit",
            serde_json::json!({ "file_path": "/repo/a.ts", "edits": [
                { "old_string": "a", "new_string": "b" },
                { "old_string": "", "new_string": "1\n2\n3\n4\n5\n6\n7\n8\n9" },
            ] }),
        );
        assert_eq!((f.added, f.removed), (Some(10), Some(1)));
        assert_eq!(f.diff.unwrap().len(), 8);
    }

    #[test]
    fn a_write_counts_its_lines_as_added() {
        let f = facts("Write", serde_json::json!({ "file_path": "/repo/n.md", "content": "a\nb\nc\n" }));
        assert_eq!(f.tool_kind, Some("write"));
        assert_eq!((f.added, f.removed), (Some(3), Some(0)));
        assert_eq!(f.diff.unwrap()[0], DiffLine { op: "+", text: "a".into() });
        assert_eq!(facts("Read", serde_json::json!({ "file_path": "/repo/a" })).added, None);
    }

    #[test]
    fn bash_exit_codes_come_from_the_convention_or_stay_unknown() {
        assert_eq!(bash_exit_code("Exit code 2\nboom", true), Some(2));
        assert_eq!(bash_exit_code("fine", false), Some(0));
        assert_eq!(bash_exit_code("interrupted", true), None);
        assert_eq!(bash_exit_code("Exit code x", true), None);
    }
}
