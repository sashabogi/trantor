// Tail and follow of the app's own log files for the Output tab; the channel is an enum, never a path (#14081).
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_LINES: usize = 2_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum OutputChannel {
    AppTrace,
    AppErrors,
    Crashes,
}

impl OutputChannel {
    fn filename(&self) -> &'static str {
        match self {
            Self::AppTrace => "app-trace.log",
            Self::AppErrors => "app-stderr.log",
            Self::Crashes => "app-panics.log",
        }
    }
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub(crate) struct OutputLogPage {
    pub(crate) lines: Vec<String>,
    pub(crate) offset: u64,
    pub(crate) missing: bool,
    pub(crate) reset: bool,
}

pub(crate) fn read_output_log(path: &Path, offset: Option<u64>) -> Result<OutputLogPage, String> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OutputLogPage { missing: true, ..OutputLogPage::default() });
        }
        Err(error) => return Err(format!("could not open {}: {error}", path.display())),
    };
    let len = file
        .metadata()
        .map_err(|error| format!("could not stat {}: {error}", path.display()))?
        .len();
    let reset = offset.is_some_and(|value| value > len);
    let previous = offset.filter(|value| *value <= len).unwrap_or(0);
    let start = previous.max(len.saturating_sub(MAX_READ_BYTES));
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("could not seek {}: {error}", path.display()))?;
    let mut raw = Vec::new();
    file.take(len - start)
        .read_to_end(&mut raw)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let next_offset = start + raw.len() as u64;

    if start > 0 && (start > previous || offset.is_none() || reset) {
        let after_partial = raw.iter().position(|byte| *byte == b'\n').map(|index| index + 1);
        raw = after_partial.map_or_else(Vec::new, |index| raw[index..].to_vec());
    }
    let text = String::from_utf8_lossy(&raw);
    let all_lines: Vec<String> = text.lines().map(ToString::to_string).collect();
    let skip = all_lines.len().saturating_sub(MAX_LINES);
    let lines = all_lines.into_iter().skip(skip).collect();
    Ok(OutputLogPage { lines, offset: next_offset, missing: false, reset })
}

#[tauri::command]
pub(crate) async fn output_log_read(
    channel: OutputChannel,
    offset: Option<u64>,
) -> Result<String, String> {
    let page = read_output_log(&crate::desktop_bus_dir().join(channel.filename()), offset)?;
    serde_json::to_string(&page).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("trantor-output-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn tail_returns_the_last_two_thousand_lines() {
        let dir = fixture("tail");
        let path = dir.join("app-trace.log");
        let body = (1..=2_100).map(|line| format!("line {line}\n")).collect::<String>();
        std::fs::write(&path, &body).unwrap();
        let page = read_output_log(&path, None).unwrap();
        assert_eq!(page.lines.len(), MAX_LINES);
        assert_eq!(page.lines.first().map(String::as_str), Some("line 101"));
        assert_eq!(page.lines.last().map(String::as_str), Some("line 2100"));
        assert_eq!(page.offset, body.len() as u64);
        assert!(!page.missing);
        assert!(!page.reset);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn follow_returns_only_appended_bytes() {
        let dir = fixture("follow");
        let path = dir.join("app-trace.log");
        std::fs::write(&path, "one\n").unwrap();
        let first = read_output_log(&path, None).unwrap();
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let next = read_output_log(&path, Some(first.offset)).unwrap();
        assert_eq!(next.lines, ["two", "three"]);
        assert_eq!(next.offset, 14);
        assert!(!next.reset);
        let empty = read_output_log(&path, Some(next.offset)).unwrap();
        assert!(empty.lines.is_empty());
        assert_eq!(empty.offset, next.offset);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_shrunk_file_starts_over() {
        let dir = fixture("shrink");
        let path = dir.join("app-trace.log");
        std::fs::write(&path, "old line that is long\n").unwrap();
        let first = read_output_log(&path, None).unwrap();
        std::fs::write(&path, "new\n").unwrap();
        let page = read_output_log(&path, Some(first.offset)).unwrap();
        assert_eq!(page.lines, ["new"]);
        assert_eq!(page.offset, 4);
        assert!(page.reset);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_an_empty_page() {
        let dir = fixture("missing");
        let page = read_output_log(&dir.join("absent.log"), Some(99)).unwrap();
        assert_eq!(page, OutputLogPage { lines: vec![], offset: 0, missing: true, reset: false });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_read_never_exceeds_the_byte_cap() {
        let dir = fixture("bytes");
        let path = dir.join("app-trace.log");
        let body = format!("{}\nlast\n", "x".repeat(MAX_READ_BYTES as usize + 100));
        std::fs::write(&path, &body).unwrap();
        let page = read_output_log(&path, None).unwrap();
        assert_eq!(page.lines, ["last"]);
        assert_eq!(page.offset, body.len() as u64);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
