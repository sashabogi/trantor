// Text search for the v2 Code screen (#14074). `git grep --untracked` is used rather than a walker
// crate: it already honours .gitignore, skips binaries with -I, and adds no dependency.
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

use crate::files::{source_root, TREE_SKIP};

const MAX_MATCHES: usize = 2000;
const MAX_FILES: usize = 200;
const MAX_LINE_CHARS: usize = 400;

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct TextMatch {
    pub(crate) line: u64,
    pub(crate) column: u64,
    pub(crate) text: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct FileMatches {
    pub(crate) path: String,
    pub(crate) matches: Vec<TextMatch>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub(crate) struct TextSearchResult {
    pub(crate) files: Vec<FileMatches>,
    pub(crate) total: usize,
    pub(crate) truncated: bool,
}

/// 1-based column (UTF-16 units, what Monaco counts) of the first match in a line; 1 when the
/// match is not found in the text.
fn first_column(text: &str, query: &str, case_sensitive: bool) -> u64 {
    let (hay, needle) = if case_sensitive {
        (text.to_string(), query.to_string())
    } else {
        (text.to_lowercase(), query.to_lowercase())
    };
    match hay.find(&needle) {
        Some(b) => hay[..b].chars().map(|c| c.len_utf16()).sum::<usize>() as u64 + 1,
        None => 1,
    }
}

/// One `path\0line\0text` record from `git grep -z -n`.
fn parse_record(raw: &[u8]) -> Option<(String, u64, String)> {
    let s = String::from_utf8_lossy(raw);
    let s = s.trim_end_matches(['\n', '\r']);
    let (path, rest) = s.split_once('\0')?;
    let (line, text) = rest.split_once('\0')?;
    Some((path.to_string(), line.parse().ok()?, text.to_string()))
}

fn grep_command(root: &Path, query: &str, case_sensitive: bool) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(["grep", "-n", "-z", "-I", "--untracked", "--no-color", "-F"]);
    if !case_sensitive {
        cmd.arg("-i");
    }
    cmd.arg("-e").arg(query).arg("--").arg(".");
    for dir in TREE_SKIP {
        cmd.arg(format!(":(exclude,glob)**/{dir}/**"));
    }
    cmd
}

fn run_grep(root: &Path, query: &str, case_sensitive: bool) -> Result<TextSearchResult, String> {
    let mut child = grep_command(root, query, case_sensitive)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git grep failed: {e}"))?;
    let stdout = child.stdout.take().ok_or("git grep gave no output")?;
    let mut reader = BufReader::new(stdout);
    let mut result = TextSearchResult::default();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Some((path, line, text)) = parse_record(&buf) else { continue };
        let path = path.strip_prefix("./").unwrap_or(&path).to_string();
        if result.files.last().map(|f| f.path != path).unwrap_or(true) {
            if result.files.len() >= MAX_FILES {
                result.truncated = true;
                break;
            }
            result.files.push(FileMatches { path, matches: Vec::new() });
        }
        if result.total >= MAX_MATCHES {
            result.truncated = true;
            break;
        }
        let column = first_column(&text, query, case_sensitive);
        let text: String = text.chars().take(MAX_LINE_CHARS).collect();
        if let Some(f) = result.files.last_mut() {
            f.matches.push(TextMatch { line, column, text });
        }
        result.total += 1;
    }
    if result.truncated {
        let _ = child.kill();
    }
    drop(reader);
    let out = child.wait_with_output().map_err(|e| format!("git grep failed: {e}"))?;
    // Exit 1 means no match; anything above that with nothing read is a real failure (not a repo).
    if result.files.is_empty() && out.status.code().map(|c| c > 1).unwrap_or(false) {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(result)
}

pub(crate) fn search_in(root: &Path, query: &str, case_sensitive: bool) -> Result<TextSearchResult, String> {
    if query.trim().is_empty() {
        return Ok(TextSearchResult::default());
    }
    run_grep(root, query, case_sensitive)
}

/// Literal text search across a project checkout or a seat worktree, grouped by file.
/// Async so a slow grep on a big checkout runs off the main thread and the window keeps drawing.
#[tauri::command]
pub(crate) async fn search_text(
    project: String,
    query: String,
    seat: Option<String>,
    case_sensitive: Option<bool>,
) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    let result = search_in(&root, &query, case_sensitive.unwrap_or(false))?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("trantor-textsearch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ok = Command::new("git").arg("-C").arg(&dir).args(["init", "-q"]).status().unwrap();
        assert!(ok.success());
        dir
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn finds_a_match_with_line_and_column() {
        let d = repo("basic");
        write(&d, "src/a.ts", "one\n  let Needle = 1;\n");
        let r = search_in(&d, "needle", false).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.files[0].path, "src/a.ts");
        assert_eq!(r.files[0].matches[0], TextMatch { line: 2, column: 7, text: "  let Needle = 1;".into() });
        assert!(!r.truncated);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn case_sensitive_option_is_honoured() {
        let d = repo("case");
        write(&d, "a.txt", "Needle\n");
        assert_eq!(search_in(&d, "needle", true).unwrap().total, 0);
        assert_eq!(search_in(&d, "needle", false).unwrap().total, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ignored_and_vendored_files_never_appear() {
        let d = repo("ignore");
        write(&d, ".gitignore", "secret.txt\n");
        write(&d, "secret.txt", "needle\n");
        write(&d, "node_modules/pkg/i.js", "needle\n");
        write(&d, "dist/out.js", "needle\n");
        write(&d, "kept.txt", "needle\n");
        let r = search_in(&d, "needle", false).unwrap();
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["kept.txt"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn binary_files_are_skipped() {
        let d = repo("bin");
        std::fs::write(d.join("b.bin"), b"needle\0\0\x01").unwrap();
        assert_eq!(search_in(&d, "needle", false).unwrap().total, 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn caps_set_the_truncated_flag() {
        let d = repo("cap");
        write(&d, "big.txt", &"needle\n".repeat(MAX_MATCHES + 50));
        let r = search_in(&d, "needle", false).unwrap();
        assert_eq!(r.total, MAX_MATCHES);
        assert!(r.truncated);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn long_lines_are_cut() {
        let d = repo("long");
        write(&d, "l.txt", &format!("needle {}\n", "x".repeat(1000)));
        let r = search_in(&d, "needle", false).unwrap();
        assert_eq!(r.files[0].matches[0].text.chars().count(), MAX_LINE_CHARS);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_query_returns_nothing_without_running() {
        let missing = std::env::temp_dir().join("trantor-textsearch-does-not-exist");
        assert_eq!(search_in(&missing, "   ", false).unwrap(), TextSearchResult::default());
    }
}
