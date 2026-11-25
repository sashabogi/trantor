// On demand TypeScript and Rust checks for the Developer mode Problems tab (#14086).
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::files::source_root;

const RUN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const RAW_LINE_LIMIT: usize = 20;
const DISCOVERY_SKIP: &[&str] = &["node_modules", "dist", "target"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProblemKind {
    Typescript,
    Rust,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProblemCheck {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) kind: ProblemKind,
    pub(crate) directory: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProblemItem {
    pub(crate) path: String,
    pub(crate) line: u64,
    pub(crate) column: u64,
    pub(crate) severity: String,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProblemRun {
    pub(crate) items: Vec<ProblemItem>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) duration_ms: u64,
    pub(crate) raw: Vec<String>,
    pub(crate) timed_out: bool,
}

fn candidate_dirs(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut dirs = vec![root.to_path_buf()];
    let mut level = dirs.clone();
    for _ in 0..max_depth {
        let mut next = Vec::new();
        for dir in level {
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let name = entry.file_name();
                if DISCOVERY_SKIP.contains(&name.to_string_lossy().as_ref()) {
                    continue;
                }
                if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    next.push(entry.path());
                }
            }
        }
        dirs.extend(next.iter().cloned());
        level = next;
    }
    dirs.sort();
    dirs
}

fn relative_directory(root: &Path, dir: &Path) -> String {
    dir.strip_prefix(root)
        .unwrap_or(dir)
        .to_string_lossy()
        .replace('\\', "/")
}

fn check_at(root: &Path, dir: &Path, kind: ProblemKind) -> Option<ProblemCheck> {
    let manifest = match kind {
        ProblemKind::Typescript => "tsconfig.json",
        ProblemKind::Rust => "Cargo.toml",
    };
    if !dir.join(manifest).is_file() {
        return None;
    }
    let directory = relative_directory(root, dir);
    let family = match kind {
        ProblemKind::Typescript => "TypeScript",
        ProblemKind::Rust => "Rust",
    };
    let id_family = match kind {
        ProblemKind::Typescript => "typescript",
        ProblemKind::Rust => "rust",
    };
    let id = if directory.is_empty() {
        format!("{id_family}:root")
    } else {
        format!("{id_family}:{directory}")
    };
    let label = if directory.is_empty() {
        family.to_string()
    } else {
        format!("{family} ({directory})")
    };
    Some(ProblemCheck { id, label, kind, directory })
}

pub(crate) fn discover_checks(root: &Path) -> Vec<ProblemCheck> {
    let mut checks = Vec::new();
    for (kind, depth) in [(ProblemKind::Typescript, 1), (ProblemKind::Rust, 2)] {
        checks.extend(candidate_dirs(root, depth).iter().filter_map(|dir| check_at(root, dir, kind)));
    }
    checks
}

fn normalized_relative_path(root: &Path, cwd: &Path, raw: &str) -> String {
    let raw = raw.trim().strip_prefix("./").unwrap_or(raw.trim());
    let supplied = Path::new(raw);
    let absolute = if supplied.is_absolute() { supplied.to_path_buf() } else { cwd.join(supplied) };
    let relative = absolute.strip_prefix(root).unwrap_or(&absolute);
    let mut normalized = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => {}
        }
    }
    normalized.to_string_lossy().replace('\\', "/")
}

fn diagnostic_tail(tail: &str) -> Option<(String, String, String)> {
    let (head, message) = tail.split_once(": ")?;
    let (severity, code) = match head.split_once(' ') {
        Some((severity, code)) => (severity, code.to_string()),
        None => match head.find('[').and_then(|open| head.rfind(']').map(|close| (open, close))) {
            Some((open, close)) if close > open => (&head[..open], head[open + 1..close].to_string()),
            _ => (head, String::new()),
        },
    };
    if severity != "error" && severity != "warning" {
        return None;
    }
    Some((severity.to_string(), code, message.to_string()))
}

fn problem_item(
    root: &Path,
    cwd: &Path,
    path: &str,
    line: &str,
    column: &str,
    tail: &str,
) -> Option<ProblemItem> {
    let (severity, code, message) = diagnostic_tail(tail)?;
    Some(ProblemItem {
        path: normalized_relative_path(root, cwd, path),
        line: line.parse().ok()?,
        column: column.parse().ok()?,
        severity,
        code,
        message,
    })
}

pub(crate) fn parse_typescript_line(line: &str, root: &Path, cwd: &Path) -> Option<ProblemItem> {
    let close = line.find("): ")?;
    let open = line[..close].rfind('(')?;
    let (line_number, column) = line[open + 1..close].split_once(',')?;
    problem_item(root, cwd, &line[..open], line_number, column, &line[close + 3..])
}

pub(crate) fn parse_rust_line(line: &str, root: &Path, cwd: &Path) -> Option<ProblemItem> {
    let error = line.find(": error");
    let warning = line.find(": warning");
    let marker = match (error, warning) {
        (Some(error), Some(warning)) => error.min(warning),
        (Some(error), None) => error,
        (None, Some(warning)) => warning,
        (None, None) => return None,
    };
    let mut location = line[..marker].rsplitn(3, ':');
    let column = location.next()?;
    let line_number = location.next()?;
    let path = location.next()?;
    problem_item(root, cwd, path, line_number, column, &line[marker + 2..])
}

fn parse_output(kind: ProblemKind, output: &std::process::Output, root: &Path, cwd: &Path) -> Vec<ProblemItem> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .filter_map(|line| match kind {
            ProblemKind::Typescript => parse_typescript_line(line, root, cwd),
            ProblemKind::Rust => parse_rust_line(line, root, cwd),
        })
        .collect()
}

fn raw_tail(output: &std::process::Output) -> Vec<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lines: Vec<String> = stdout.lines().chain(stderr.lines()).map(ToString::to_string).collect();
    let skip = lines.len().saturating_sub(RAW_LINE_LIMIT);
    lines.into_iter().skip(skip).collect()
}

fn check_command(root: &Path, check: &ProblemCheck) -> tokio::process::Command {
    let mut command = match check.kind {
        ProblemKind::Typescript => {
            let mut command = tokio::process::Command::new("npx");
            command.args(["tsc", "--noEmit", "--pretty", "false"]);
            command
        }
        ProblemKind::Rust => {
            let mut command = tokio::process::Command::new("cargo");
            command.args(["check", "--message-format=short"]);
            command
        }
    };
    command
        .current_dir(root.join(&check.directory))
        .env("PATH", crate::terminal_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

async fn run_check(root: &Path, check: &ProblemCheck) -> Result<ProblemRun, String> {
    let started = Instant::now();
    let cwd = root.join(&check.directory);
    let child = check_command(root, check)
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", check.label))?;
    let elapsed = || started.elapsed().as_millis() as u64;
    match tokio::time::timeout(RUN_TIMEOUT, child.wait_with_output()).await {
        Err(_) => Ok(ProblemRun {
            items: Vec::new(),
            exit_code: None,
            duration_ms: elapsed(),
            raw: vec!["Check stopped after 5 minutes.".to_string()],
            timed_out: true,
        }),
        Ok(Err(error)) => Err(format!("could not read {}: {error}", check.label)),
        Ok(Ok(output)) => {
            let items = parse_output(check.kind, &output, root, &cwd);
            let exit_code = output.status.code();
            let raw = if items.is_empty() && exit_code != Some(0) { raw_tail(&output) } else { Vec::new() };
            Ok(ProblemRun { items, exit_code, duration_ms: elapsed(), raw, timed_out: false })
        }
    }
}

#[tauri::command]
pub(crate) async fn problems_checks(project: String, seat: Option<String>) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    serde_json::to_string(&discover_checks(&root)).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn problems_run(project: String, seat: Option<String>, id: String) -> Result<String, String> {
    let root = source_root(&project, seat.as_deref())?;
    let check = discover_checks(&root)
        .into_iter()
        .find(|check| check.id == id)
        .ok_or_else(|| "The selected check no longer exists.".to_string())?;
    let result = run_check(&root, &check).await?;
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trantor-problems-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, relative: &str) {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[test]
    fn discovers_root_and_bounded_nested_checks() {
        let dir = fixture("discovery");
        for manifest in [
            "tsconfig.json",
            "desktop/tsconfig.json",
            "desktop/deep/tsconfig.json",
            "Cargo.toml",
            "src-tauri/Cargo.toml",
            "crates/core/Cargo.toml",
            "crates/core/deep/Cargo.toml",
        ] {
            write(&dir, manifest);
        }
        let checks = discover_checks(&dir);
        let ids: Vec<&str> = checks.iter().map(|check| check.id.as_str()).collect();
        assert_eq!(ids, [
            "typescript:root",
            "typescript:desktop",
            "rust:root",
            "rust:crates/core",
            "rust:src-tauri",
        ]);
        assert_eq!(checks[1].label, "TypeScript (desktop)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovery_skips_dependency_and_output_directories() {
        let dir = fixture("skip");
        for manifest in [
            "node_modules/pkg/tsconfig.json",
            "dist/tsconfig.json",
            "target/Cargo.toml",
            "node_modules/pkg/Cargo.toml",
            "dist/nested/Cargo.toml",
        ] {
            write(&dir, manifest);
        }
        assert!(discover_checks(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_typescript_errors_and_warnings_relative_to_the_checkout() {
        let root = Path::new("/repo");
        let cwd = root.join("desktop");
        let error = parse_typescript_line(
            "src/app.ts(14,9): error TS2322: Type string is not assignable to (number).",
            root,
            &cwd,
        ).unwrap();
        assert_eq!(error, ProblemItem {
            path: "desktop/src/app.ts".into(),
            line: 14,
            column: 9,
            severity: "error".into(),
            code: "TS2322".into(),
            message: "Type string is not assignable to (number).".into(),
        });
        let warning = parse_typescript_line("./src/app.ts(2,1): warning TS1000: Check this.", root, &cwd).unwrap();
        assert_eq!(warning.severity, "warning");
        assert_eq!(warning.path, "desktop/src/app.ts");
        assert!(parse_typescript_line("not a diagnostic", root, &cwd).is_none());
    }

    #[test]
    fn parses_rust_errors_and_warnings_including_absolute_paths() {
        let root = Path::new("/repo");
        let cwd = root.join("src-tauri");
        let error = parse_rust_line(
            "src/main.rs:20:7: error[E0425]: cannot find value `missing` in this scope",
            root,
            &cwd,
        ).unwrap();
        assert_eq!(error, ProblemItem {
            path: "src-tauri/src/main.rs".into(),
            line: 20,
            column: 7,
            severity: "error".into(),
            code: "E0425".into(),
            message: "cannot find value `missing` in this scope".into(),
        });
        let warning = parse_rust_line("/repo/src/lib.rs:3:1: warning: unused import", root, &cwd).unwrap();
        assert_eq!(warning.path, "src/lib.rs");
        assert_eq!(warning.severity, "warning");
        assert_eq!(warning.code, "");
        assert!(parse_rust_line("cargo finished", root, &cwd).is_none());
    }
}
