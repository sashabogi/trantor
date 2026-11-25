// Text search for the v2 Code screen (#14074). `git grep --untracked` is used rather than a walker
// crate: it already honours .gitignore, skips binaries with -I, and adds no dependency. #14104 adds
// the search options (regular expression, whole word, include/exclude globs) and `replace_text`.
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::SystemTime;

use crate::files::{source_root, TREE_SKIP};
use regex::{Regex, RegexBuilder};

const MAX_MATCHES: usize = 2000;
const MAX_FILES: usize = 200;
const MAX_LINE_CHARS: usize = 400;

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct TextMatch {
    pub(crate) line: u64,
    pub(crate) column: u64,
    pub(crate) text: String,
    /// length of the matched text in UTF-16 units, for the highlight; null when unknown
    #[serde(rename = "markLen")]
    pub(crate) mark_len: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct FileMatches {
    pub(crate) path: String,
    pub(crate) matches: Vec<TextMatch>,
    /// the stat when the search ran: `replace_text` refuses a file whose stat has moved (#14104)
    #[serde(rename = "mtimeMs")]
    pub(crate) mtime_ms: u64,
    pub(crate) bytes: u64,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub(crate) struct TextSearchResult {
    pub(crate) files: Vec<FileMatches>,
    pub(crate) total: usize,
    pub(crate) truncated: bool,
}

/// How a search (or a replace) should match. The globs only apply to the search.
#[derive(Debug, Default)]
pub(crate) struct SearchHow {
    pub(crate) case_sensitive: bool,
    pub(crate) regex: bool,
    pub(crate) whole_word: bool,
    pub(crate) include: Vec<String>,
    pub(crate) exclude: Vec<String>,
}

/// POSIX ERE has no `\d`: a user with JS muscle memory typing `foo\d+` would otherwise be searching
/// for "food". The shorthand classes are rewritten into POSIX classes — outside brackets, where
/// they are classes; inside one, `\d` is a literal backslash and d, which stays as typed.
fn posix_translate(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut in_bracket = false;
    let mut bracket_first = false;
    let mut escaped = false;
    for c in pattern.chars() {
        if escaped {
            if !in_bracket {
                match c {
                    'd' => out.push_str("[0-9]"),
                    'D' => out.push_str("[^0-9]"),
                    'w' => out.push_str("[0-9A-Za-z_]"),
                    'W' => out.push_str("[^0-9A-Za-z_]"),
                    's' => out.push_str("[\t\n\x0b\x0c\r ]"),
                    'S' => out.push_str("[^\t\n\x0b\x0c\r ]"),
                    _ => {
                        out.push('\\');
                        out.push(c);
                    }
                }
            } else {
                out.push('\\');
                out.push(c);
            }
            escaped = false;
            bracket_first = false;
            continue;
        }
        if in_bracket {
            match c {
                // the pair is emitted by the escaped branch above, so the slash is not pushed twice
                '\\' => {
                    escaped = true;
                    continue;
                }
                ']' if !bracket_first => in_bracket = false,
                // `[]]` and `[^]]`: a `]` in the first position is a literal, the class stays open
                '^' if bracket_first => {}
                _ => bracket_first = false,
            }
            out.push(c);
            continue;
        }
        match c {
            // the escaped pair is handled on the next char; pushing here would double the slash
            '\\' => escaped = true,
            '[' => {
                in_bracket = true;
                bracket_first = true;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    if escaped {
        out.push('\\');
    }
    out
}

/// `git grep -w`'s boundary: a match must not touch an ASCII word character on either side.
/// Multi-byte continuation bytes are not word characters, so UTF-8 neighbours count as boundaries.
fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn word_delimited(text: &str, start: usize, end: usize) -> bool {
    let b = text.as_bytes();
    (start == 0 || !is_word(b[start - 1])) && (end == b.len() || !is_word(b[end]))
}

fn utf16_units(text: &str) -> u64 {
    text.chars().map(|c| c.len_utf16()).sum::<usize>() as u64
}

/// Every non-overlapping literal occurrence. Case-insensitive folding is ASCII-only, so byte
/// offsets in the folded scan are the offsets in the original text.
fn find_fixed(text: &str, needle: &[u8], case_sensitive: bool) -> Vec<(usize, usize)> {
    let hay = text.as_bytes();
    let mut out = Vec::new();
    if needle.is_empty() || hay.len() < needle.len() {
        return out;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        let window = &hay[i..i + needle.len()];
        let hit = if case_sensitive {
            window == needle
        } else {
            window.iter().zip(needle).all(|(a, b)| a.eq_ignore_ascii_case(b))
        };
        if hit {
            out.push((i, i + needle.len()));
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

/// The matcher the search (for the highlight span) and the replace (for the edits) share, so the
/// two never disagree about where a hit sits. The regex flavour is the Rust `regex` crate over the
/// same translated pattern git grep searched with.
enum Matcher {
    Fixed { needle: Vec<u8>, case_sensitive: bool },
    Regex(Regex),
}

impl Matcher {
    /// None when the pattern cannot compile in this crate: git grep still returns the lines, only
    /// the highlight span is unknown.
    fn build(how: &SearchHow, query: &str) -> Option<Matcher> {
        if !how.regex {
            return Some(Matcher::Fixed { needle: query.as_bytes().to_vec(), case_sensitive: how.case_sensitive });
        }
        RegexBuilder::new(&posix_translate(query))
            .case_insensitive(!how.case_sensitive)
            .build()
            .ok()
            .map(Matcher::Regex)
    }

    /// First byte span in one line; word-delimited when the option is on.
    fn first(&self, text: &str, whole_word: bool) -> Option<(usize, usize)> {
        self.spans(text, whole_word).into_iter().next()
    }

    /// Every non-overlapping byte span, word-delimited when the option is on.
    fn spans(&self, text: &str, whole_word: bool) -> Vec<(usize, usize)> {
        let hits = match self {
            Matcher::Fixed { needle, case_sensitive } => find_fixed(text, needle, *case_sensitive),
            Matcher::Regex(re) => re.find_iter(text).map(|m| (m.start(), m.end())).collect(),
        };
        if whole_word {
            hits.into_iter().filter(|(s, e)| word_delimited(text, *s, *e)).collect()
        } else {
            hits
        }
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

fn grep_command(root: &Path, query: &str, how: &SearchHow, untracked: bool) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(["grep", "-n", "-z", "-I", "--no-color"]);
    if untracked {
        cmd.arg("--untracked");
    }
    cmd.arg(if how.regex { "-E" } else { "-F" });
    if how.whole_word {
        cmd.arg("-w");
    }
    if !how.case_sensitive {
        cmd.arg("-i");
    }
    // A bare glob pathspec matches across directories (git's fnmatch has no pathname flag), which
    // is what "include *.ts" means to a person; excludes use the same matching, negated.
    let pattern = if how.regex { posix_translate(query) } else { query.to_string() };
    cmd.arg("-e").arg(pattern).arg("--");
    let has_include = !how.include.is_empty();
    if !has_include {
        cmd.arg(".");
    }
    for g in &how.include {
        cmd.arg(g);
    }
    for g in &how.exclude {
        cmd.arg(format!(":(exclude){g}"));
    }
    for dir in TREE_SKIP {
        cmd.arg(format!(":(exclude,glob)**/{dir}/**"));
    }
    cmd
}

fn mtime_ms_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The replace staleness token: modified time in milliseconds plus size, the same cheap pair the
/// live viewer polls (#14104). (0, 0) when the file cannot be stat'd.
fn stat_of(path: &Path) -> (u64, u64) {
    std::fs::metadata(path).map(|m| (mtime_ms_of(&m), m.len())).unwrap_or((0, 0))
}

/// One grep pass folded into `result`. `skip` holds the paths an earlier pass already
/// reported, so the untracked pass (which also re-lists tracked, unignored files) adds nothing twice.
fn grep_pass(
    root: &Path,
    query: &str,
    how: &SearchHow,
    untracked: bool,
    matcher: Option<&Matcher>,
    skip: &std::collections::HashSet<String>,
    result: &mut TextSearchResult,
) -> Result<(), String> {
    let mut child = grep_command(root, query, how, untracked)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git grep failed: {e}"))?;
    let stdout = child.stdout.take().ok_or("git grep gave no output")?;
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    let mut last: Option<String> = None;
    let start_files = result.files.len();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Some((path, line, text)) = parse_record(&buf) else { continue };
        let path = path.strip_prefix("./").unwrap_or(&path).to_string();
        if skip.contains(&path) {
            continue;
        }
        if last.as_deref() != Some(path.as_str()) {
            if result.files.len() >= MAX_FILES {
                result.truncated = true;
                break;
            }
            result.files.push(FileMatches { path: path.clone(), matches: Vec::new(), mtime_ms: 0, bytes: 0 });
            last = Some(path);
        }
        if result.total >= MAX_MATCHES {
            result.truncated = true;
            break;
        }
        let span = matcher.and_then(|m| m.first(&text, how.whole_word));
        let column = span.map(|(s, _)| utf16_units(&text[..s]) + 1).unwrap_or(1);
        let mark_len = span.map(|(s, e)| utf16_units(&text[s..e]));
        let cut: String = text.chars().take(MAX_LINE_CHARS).collect();
        if let Some(f) = result.files.last_mut() {
            f.matches.push(TextMatch { line, column, text: cut, mark_len });
        }
        result.total += 1;
    }
    if result.truncated {
        let _ = child.kill();
    }
    drop(reader);
    let out = child.wait_with_output().map_err(|e| format!("git grep failed: {e}"))?;
    // Exit 1 means no match; anything above that with nothing read is a real failure (not a repo,
    // or an expression git rejects, both belong in the box as an error, not as zero results).
    if result.files.len() == start_files && out.status.code().map(|c| c > 1).unwrap_or(false) {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

fn run_grep(root: &Path, query: &str, how: &SearchHow) -> Result<TextSearchResult, String> {
    let matcher = Matcher::build(how, query);
    let mut result = TextSearchResult::default();
    // #14268: the untracked flag drops a tracked file that an ignore rule matches, so tracked files
    // get their own pass (ignore rules do not apply to them) and the untracked pass adds new paths only.
    grep_pass(root, query, how, false, matcher.as_ref(), &std::collections::HashSet::new(), &mut result)?;
    if !result.truncated {
        let seen: std::collections::HashSet<String> = result.files.iter().map(|f| f.path.clone()).collect();
        grep_pass(root, query, how, true, matcher.as_ref(), &seen, &mut result)?;
    }
    result.files.sort_by(|a, b| a.path.cmp(&b.path));
    for f in result.files.iter_mut() {
        let (mtime, bytes) = stat_of(&root.join(&f.path));
        f.mtime_ms = mtime;
        f.bytes = bytes;
    }
    Ok(result)
}

pub(crate) fn search_in(root: &Path, query: &str, how: &SearchHow) -> Result<TextSearchResult, String> {
    if query.trim().is_empty() {
        return Ok(TextSearchResult::default());
    }
    if let Some(bad) = how.include.iter().chain(how.exclude.iter()).find(|g| g.contains("..")) {
        return Err(format!("a glob cannot leave the project: {bad}"));
    }
    run_grep(root, query, how)
}

fn split_globs(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(|g| g.trim())
        .filter(|g| !g.is_empty())
        .map(String::from)
        .collect()
}

/// Literal text search across a project checkout or a seat worktree, grouped by file.
/// Async so a slow grep on a big checkout runs off the main thread and the window keeps drawing.
#[tauri::command]
pub(crate) async fn search_text(
    project: String,
    query: String,
    seat: Option<String>,
    case_sensitive: Option<bool>,
    regex: Option<bool>,
    whole_word: Option<bool>,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    let how = SearchHow {
        case_sensitive: case_sensitive.unwrap_or(false),
        regex: regex.unwrap_or(false),
        whole_word: whole_word.unwrap_or(false),
        include: split_globs(include.as_deref()),
        exclude: split_globs(exclude.as_deref()),
    };
    let result = search_in(&root, &query, &how)?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

/// The one result a "replace this result" click targets, in the search's own units.
#[derive(Deserialize, Debug, PartialEq)]
pub(crate) struct MatchAt {
    pub(crate) line: u64,
    pub(crate) column: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct ReplaceOutcome {
    pub(crate) replaced: usize,
}

/// 1-based line number and 1-based UTF-16 column of a byte offset, the units the search reports.
fn line_col(text: &str, byte: usize) -> (u64, u64) {
    let before = &text[..byte];
    let line = before.matches('\n').count() as u64 + 1;
    let line_start = before.rfind('\n').map(|i| i + 1).unwrap_or(0);
    (line, utf16_units(&text[line_start..byte]) + 1)
}

/// Splices the picked spans into the text. `only` demands that exactly one replacement landed.
fn finish_splice(text: &str, picks: Vec<(usize, usize, String)>, only: Option<MatchAt>) -> Result<(String, usize), String> {
    if picks.is_empty() {
        if let Some(at) = only {
            return Err(format!("the match at line {} is no longer where the search found it; search again", at.line));
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (s, e, piece) in &picks {
        out.push_str(&text[at..*s]);
        out.push_str(piece);
        at = *e;
    }
    out.push_str(&text[at..]);
    Ok((out, picks.len()))
}

/// Replace every match (or the one at `only`) in one file's text. A fixed query replaces
/// literally; a regular expression expands `$1`-style group references.
fn replace_in_text(
    text: &str,
    query: &str,
    replacement: &str,
    how: &SearchHow,
    only: Option<MatchAt>,
) -> Result<(String, usize), String> {
    if how.regex {
        let re = RegexBuilder::new(&posix_translate(query))
            .case_insensitive(!how.case_sensitive)
            .build()
            .map_err(|e| format!("invalid regular expression: {e}"))?;
        let mut picks: Vec<(usize, usize, String)> = Vec::new();
        for cap in re.captures_iter(text) {
            // A zero-width match would splice the replacement at every gap between characters;
            // it replaces nothing real, so it is skipped rather than exploded.
            if let Some(m) = cap.get(0).filter(|m| !m.as_str().is_empty()) {
                if how.whole_word && !word_delimited(text, m.start(), m.end()) {
                    continue;
                }
                if let Some(want) = &only {
                    let (l, c) = line_col(text, m.start());
                    if l != want.line || c != want.column {
                        continue;
                    }
                }
                let mut piece = String::new();
                cap.expand(replacement, &mut piece);
                picks.push((m.start(), m.end(), piece));
            }
        }
        return finish_splice(text, picks, only);
    }
    let matcher = Matcher::Fixed { needle: query.as_bytes().to_vec(), case_sensitive: how.case_sensitive };
    let mut picks: Vec<(usize, usize, String)> = Vec::new();
    for (s, e) in matcher.spans(text, how.whole_word) {
        if let Some(want) = &only {
            let (l, c) = line_col(text, s);
            if l != want.line || c != want.column {
                continue;
            }
        }
        picks.push((s, e, replacement.to_string()));
    }
    finish_splice(text, picks, only)
}

/// Replace in ONE file under `root` and say how many replacements landed. The `mtime_ms`/`bytes`
/// pair is the stat the search returned: a file that changed since the search ran is refused,
/// never written over — the operator's editor or a seat could have moved it in between (#14104).
pub(crate) fn replace_in(
    root: &Path,
    path: &str,
    query: &str,
    replacement: &str,
    how: &SearchHow,
    only: Option<MatchAt>,
    mtime_ms: u64,
    bytes: u64,
) -> Result<ReplaceOutcome, String> {
    if path.contains("..") || Path::new(path).is_absolute() {
        return Err("path escapes the project".into());
    }
    if query.trim().is_empty() {
        return Err("nothing to replace: the search text is empty".into());
    }
    let full = root.join(path);
    let meta = std::fs::metadata(&full).map_err(|e| format!("cannot replace {path}: {e}"))?;
    if mtime_ms != 0 && (mtime_ms_of(&meta) != mtime_ms || meta.len() != bytes) {
        return Err(format!("{path} changed since the search ran; search again and replace from the fresh results"));
    }
    let raw = std::fs::read(&full).map_err(|e| format!("cannot replace {path}: {e}"))?;
    // A NUL in the head is the same cheap binary test read_file uses; a binary must not be spliced.
    if raw.iter().take(8192).any(|b| *b == 0) {
        return Err(format!("{path} is a binary file"));
    }
    let text = String::from_utf8(raw).map_err(|_| format!("cannot replace {path}: it is not UTF-8 text"))?;
    let (out, replaced) = replace_in_text(&text, query, replacement, how, only)?;
    std::fs::write(&full, out).map_err(|e| format!("cannot write {path}: {e}"))?;
    Ok(ReplaceOutcome { replaced })
}

/// Front-end entry: resolve the checkout, then splice one file. `mtimeMs`/`bytes` come from the
/// search result the operator confirmed against.
#[tauri::command]
pub(crate) fn replace_text(
    project: String,
    seat: Option<String>,
    path: String,
    query: String,
    replacement: String,
    case_sensitive: Option<bool>,
    regex: Option<bool>,
    whole_word: Option<bool>,
    only: Option<MatchAt>,
    mtime_ms: u64,
    bytes: u64,
) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    let how = SearchHow {
        case_sensitive: case_sensitive.unwrap_or(false),
        regex: regex.unwrap_or(false),
        whole_word: whole_word.unwrap_or(false),
        include: Vec::new(),
        exclude: Vec::new(),
    };
    let outcome = replace_in(&root, &path, &query, &replacement, &how, only, mtime_ms, bytes)?;
    serde_json::to_string(&outcome).map_err(|e| e.to_string())
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

    fn how(case: bool, regex: bool, whole: bool) -> SearchHow {
        SearchHow { case_sensitive: case, regex, whole_word: whole, include: Vec::new(), exclude: Vec::new() }
    }

    fn how_globs(include: &[&str], exclude: &[&str]) -> SearchHow {
        SearchHow {
            case_sensitive: false,
            regex: false,
            whole_word: false,
            include: include.iter().map(|s| s.to_string()).collect(),
            exclude: exclude.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn read(dir: &Path, rel: &str) -> String {
        String::from_utf8(std::fs::read(dir.join(rel)).unwrap()).unwrap()
    }

    #[test]
    fn finds_a_match_with_line_and_column() {
        let d = repo("basic");
        write(&d, "src/a.ts", "one\n  let Needle = 1;\n");
        let r = search_in(&d, "needle", &how(false, false, false)).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.files[0].path, "src/a.ts");
        assert_eq!(r.files[0].matches[0], TextMatch { line: 2, column: 7, text: "  let Needle = 1;".into(), mark_len: Some(6) });
        assert!(!r.truncated);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn case_sensitive_option_is_honoured() {
        let d = repo("case");
        write(&d, "a.txt", "Needle\n");
        assert_eq!(search_in(&d, "needle", &how(true, false, false)).unwrap().total, 0);
        assert_eq!(search_in(&d, "needle", &how(false, false, false)).unwrap().total, 1);
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
        let r = search_in(&d, "needle", &how(false, false, false)).unwrap();
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["kept.txt"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn binary_files_are_skipped() {
        let d = repo("bin");
        std::fs::write(d.join("b.bin"), b"needle\0\0\x01").unwrap();
        assert_eq!(search_in(&d, "needle", &how(false, false, false)).unwrap().total, 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn caps_set_the_truncated_flag() {
        let d = repo("cap");
        write(&d, "big.txt", &"needle\n".repeat(MAX_MATCHES + 50));
        let r = search_in(&d, "needle", &how(false, false, false)).unwrap();
        assert_eq!(r.total, MAX_MATCHES);
        assert!(r.truncated);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn long_lines_are_cut() {
        let d = repo("long");
        write(&d, "l.txt", &format!("needle {}\n", "x".repeat(1000)));
        let r = search_in(&d, "needle", &how(false, false, false)).unwrap();
        assert_eq!(r.files[0].matches[0].text.chars().count(), MAX_LINE_CHARS);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_query_returns_nothing_without_running() {
        let missing = std::env::temp_dir().join("trantor-textsearch-does-not-exist");
        assert_eq!(search_in(&missing, "   ", &how(false, false, false)).unwrap(), TextSearchResult::default());
    }

    #[test]
    fn posix_translation_is_pinned() {
        assert_eq!(posix_translate(r"foo\d+"), "foo[0-9]+");
        assert_eq!(posix_translate(r"a\wz"), "a[0-9A-Za-z_]z");
        assert_eq!(posix_translate(r"\s\S"), "[\t\n\x0b\x0c\r ][^\t\n\x0b\x0c\r ]");
        // inside a bracket the shorthand is a literal backslash and letter, as POSIX reads it
        assert_eq!(posix_translate(r"[\d]"), r"[\d]");
        assert_eq!(posix_translate(r"[a-z\d]"), r"[a-z\d]");
        assert_eq!(posix_translate(r"[]\d]"), r"[]\d]");
        // an escaped backslash is not an escape for the next letter
        assert_eq!(posix_translate(r"\\d"), r"\\d");
        assert_eq!(posix_translate("a\\"), "a\\");
    }

    #[test]
    fn regex_option_matches_posix_patterns() {
        let d = repo("regex");
        write(&d, "a.txt", "foo1 bar\nfood\n");
        let r = search_in(&d, "foo[0-9]+", &how(false, true, false)).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.files[0].matches[0].text, "foo1 bar");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn regex_shorthand_classes_are_translated() {
        let d = repo("short");
        write(&d, "a.txt", "foo1 bar\nfood\n");
        let r = search_in(&d, r"foo\d+", &how(false, true, false)).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.files[0].matches[0].text, "foo1 bar");
        assert_eq!(r.files[0].matches[0].column, 1);
        assert_eq!(r.files[0].matches[0].mark_len, Some(4));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn regex_reports_the_span_of_the_match() {
        let d = repo("span");
        write(&d, "a.txt", "  hello\n");
        let r = search_in(&d, "l+", &how(false, true, false)).unwrap();
        assert_eq!(r.files[0].matches[0].column, 5);
        assert_eq!(r.files[0].matches[0].mark_len, Some(2));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn whole_word_hides_partial_matches() {
        let d = repo("word");
        write(&d, "a.txt", "a needle here\nneedles everywhere\n");
        let r = search_in(&d, "needle", &how(false, false, true)).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.files[0].matches[0].text, "a needle here");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn whole_word_with_a_regular_expression() {
        let d = repo("wordre");
        write(&d, "a.txt", "xfoo1\nfoo1\n");
        let r = search_in(&d, "foo[0-9]+", &how(false, true, true)).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.files[0].matches[0].text, "foo1");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn include_globs_limit_the_files() {
        let d = repo("incl");
        write(&d, "a.ts", "needle\n");
        write(&d, "deep/b.md", "needle\n");
        let r = search_in(&d, "needle", &how_globs(&["*.ts"], &[])).unwrap();
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["a.ts"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn exclude_globs_remove_the_files() {
        let d = repo("excl");
        write(&d, "a.ts", "needle\n");
        write(&d, "deep/b.md", "needle\n");
        let r = search_in(&d, "needle", &how_globs(&[], &["*.md"])).unwrap();
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["a.ts"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_glob_that_escapes_the_project_is_refused() {
        let d = repo("esc");
        let r = search_in(&d, "needle", &how_globs(&["../**"], &[]));
        assert!(r.unwrap_err().contains("cannot leave the project"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_invalid_expression_is_an_error() {
        let d = repo("badre");
        write(&d, "a.txt", "needle\n");
        let r = search_in(&d, "needl(", &how(false, true, false));
        // git words this differently per platform, so only the refusal is pinned.
        assert!(!r.unwrap_err().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_fixed_every_occurrence_with_counts() {
        let d = repo("rep");
        write(&d, "a.txt", "needle one\nnope\nneedle two\n");
        let (out, n) = replace_in_text(&read(&d, "a.txt"), "needle", "pin", &how(false, false, false), None).unwrap();
        assert_eq!(n, 2);
        assert_eq!(out, "pin one\nnope\npin two\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_fixed_case_insensitive() {
        let d = repo("repcase");
        write(&d, "a.txt", "Needle needle NEEDLE\n");
        let (out, n) = replace_in_text(&read(&d, "a.txt"), "needle", "pin", &how(false, false, false), None).unwrap();
        assert_eq!(n, 3);
        assert_eq!(out, "pin pin pin\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_whole_word_only() {
        let d = repo("repword");
        write(&d, "a.txt", "needle needles needle\n");
        let (out, n) = replace_in_text(&read(&d, "a.txt"), "needle", "pin", &how(false, false, true), None).unwrap();
        assert_eq!(n, 2);
        assert_eq!(out, "pin needles pin\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_regular_expression_with_group_references() {
        let d = repo("repgroup");
        write(&d, "a.txt", "foo1 and foo2\n");
        let (out, n) = replace_in_text(&read(&d, "a.txt"), r"foo([0-9])", "bar$1", &how(false, true, false), None).unwrap();
        assert_eq!(n, 2);
        assert_eq!(out, "bar1 and bar2\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_one_result_only() {
        let d = repo("repone");
        write(&d, "a.txt", "a needle\nb needle\n");
        let (out, n) = replace_in_text(&read(&d, "a.txt"), "needle", "pin", &how(false, false, false), Some(MatchAt { line: 2, column: 3 })).unwrap();
        assert_eq!(n, 1);
        assert_eq!(out, "a needle\nb pin\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_a_gone_match_is_refused() {
        let d = repo("repgone");
        write(&d, "a.txt", "a needle\n");
        let r = replace_in_text(&read(&d, "a.txt"), "needle", "pin", &how(false, false, false), Some(MatchAt { line: 9, column: 1 }));
        assert!(r.unwrap_err().contains("no longer where the search found it"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_refuses_a_file_that_changed_since_the_search() {
        let d = repo("repstale");
        write(&d, "a.txt", "needle\n");
        write(&d, "keep.txt", "needle\n");
        let r = search_in(&d, "needle", &how(false, false, false)).unwrap();
        let target = r.files.iter().find(|f| f.path == "a.txt").unwrap();
        // Same size, new mtime: the refusal must not depend on the byte count alone.
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&d, "a.txt", "need1e\n");
        let err = replace_in(&d, "a.txt", "needle", "pin", &how(false, false, false), None, target.mtime_ms, target.bytes)
            .unwrap_err();
        assert!(err.contains("changed since the search ran"), "got: {err}");
        assert_eq!(read(&d, "a.txt"), "need1e\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_writes_when_the_file_is_unchanged() {
        let d = repo("repok");
        write(&d, "a.txt", "needle one\n");
        let r = search_in(&d, "needle", &how(false, false, false)).unwrap();
        let target = &r.files[0];
        let out = replace_in(&d, "a.txt", "needle", "pin", &how(false, false, false), None, target.mtime_ms, target.bytes).unwrap();
        assert_eq!(out.replaced, 1);
        assert_eq!(read(&d, "a.txt"), "pin one\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_refuses_a_path_that_escapes_the_project() {
        let d = repo("repesc");
        write(&d, "a.txt", "needle\n");
        let r = replace_in(&d, "../a.txt", "needle", "pin", &how(false, false, false), None, 0, 0);
        assert_eq!(r.unwrap_err(), "path escapes the project");
        let outside = std::env::temp_dir().join("trantor-textsearch-outside.txt");
        std::fs::write(&outside, "needle\n").unwrap();
        let r = replace_in(&d, &outside.to_string_lossy(), "needle", "pin", &how(false, false, false), None, 0, 0);
        assert_eq!(r.unwrap_err(), "path escapes the project");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "needle\n");
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_refuses_a_missing_file() {
        let d = repo("repmissing");
        let r = replace_in(&d, "gone.txt", "needle", "pin", &how(false, false, false), None, 0, 0);
        assert!(r.unwrap_err().contains("cannot replace gone.txt"));
        let _ = std::fs::remove_dir_all(&d);
    }

    fn stage(dir: &Path, paths: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).arg("add").args(paths).status().unwrap();
        assert!(ok.success());
    }

    // #14268: a repo shaped like the reported one, with tracked and untracked files plus the
    // ignore files another tool wrote.
    fn reported_repo(name: &str) -> std::path::PathBuf {
        let d = repo(name);
        write(&d, "src/app.ts", "import { add, multiply } from \"./math\";\n\n\n\n\n\n\nreturn items.map(x => multiply(x, k));\n");
        write(&d, "src/math.ts", "\n\n\n\n\n\n\n\nexport function multiply(a: number, b: number): number {\n");
        write(&d, ".gitignore", "graft/\n");
        write(&d, ".ignore", "graft/\n");
        write(&d, "graft/out.ts", "multiply\n");
        stage(&d, &["src/math.ts", ".gitignore"]);
        write(&d, "notes.txt", "untracked multiply note\n");
        d
    }

    #[test]
    fn finds_every_match_in_every_file() {
        let d = reported_repo("reported");
        let r = search_in(&d, "multiply", &how(false, false, false)).unwrap();
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["notes.txt", "src/app.ts", "src/math.ts"]);
        assert_eq!(r.total, 4);
        let app = r.files.iter().find(|f| f.path == "src/app.ts").unwrap();
        assert_eq!(app.matches.iter().map(|m| m.line).collect::<Vec<_>>(), vec![1, 8]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_tracked_file_that_an_ignore_rule_matches_is_still_searched() {
        let d = reported_repo("ignored-tracked");
        write(&d, ".gitignore", "graft/\n*.ts\n");
        let r = search_in(&d, "multiply", &how(false, false, false)).unwrap();
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();
        // math.ts is tracked, so it stays; app.ts is untracked and ignored, so it stays out
        assert_eq!(paths, vec!["notes.txt", "src/math.ts"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn toggles_still_narrow_the_matches() {
        let d = reported_repo("toggles");
        write(&d, "src/case.ts", "Multiply\nmultiplyAll\nmultiply\n");
        let all = search_in(&d, "multiply", &how(false, false, false)).unwrap();
        let case = search_in(&d, "multiply", &how(true, false, false)).unwrap();
        let word = search_in(&d, "multiply", &how(false, false, true)).unwrap();
        let re = search_in(&d, "multiply[(]x", &how(false, true, false)).unwrap();
        let count = |r: &TextSearchResult, p: &str| r.files.iter().find(|f| f.path == p).map(|f| f.matches.len()).unwrap_or(0);
        assert_eq!(count(&all, "src/case.ts"), 3);
        assert_eq!(count(&case, "src/case.ts"), 2);
        assert_eq!(count(&word, "src/case.ts"), 2);
        assert_eq!(count(&re, "src/app.ts"), 1);
        assert_eq!(count(&re, "src/math.ts"), 0);
        let _ = std::fs::remove_dir_all(&d);
    }
}
