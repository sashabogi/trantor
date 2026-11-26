// Existence checks behind the chat's links (#14327): a path or a short hash that merely looks
// like one only becomes a link once the project's checkout confirms it is real.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// One batch never checks more than this many names: a transcript reply holds a handful, and a
/// pasted wall of text must not turn into a thousand filesystem or repository probes.
const MAX_BATCH: usize = 200;
const MAX_PATH_BYTES: usize = 1024;

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

/// The real location of `raw` when it names an existing file or folder inside `root` or `home`. A
/// leading `~/` is the home folder, a relative path is taken from `root`, and anything that
/// resolves (symlinks and `..` included) outside both is refused, so a link can never confirm a
/// file elsewhere on disk.
fn resolve_real(root: &Path, home: &Path, raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || raw.len() > MAX_PATH_BYTES || raw.contains('\0') {
        return None;
    }
    let joined = if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else if raw == "~" {
        home.to_path_buf()
    } else if raw.starts_with('/') {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    };
    let real = joined.canonicalize().ok()?;
    [root, home]
        .iter()
        .filter_map(|base| base.canonicalize().ok())
        .any(|base| real.starts_with(base))
        .then_some(real)
}

pub(crate) fn path_exists_in(root: &Path, home: &Path, raw: &str) -> bool {
    resolve_real(root, home, raw).is_some()
}

/// Where a confirmed link path lives, for opening it: `path` is checkout-relative when `inside`
/// the checkout ("" is the checkout itself), otherwise the absolute location under home.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct LinkPath {
    pub(crate) path: String,
    pub(crate) dir: bool,
    pub(crate) inside: bool,
}

pub(crate) fn resolve_in(root: &Path, home: &Path, raw: &str) -> Option<LinkPath> {
    let real = resolve_real(root, home, raw)?;
    let dir = real.is_dir();
    if let Some(rel) = root.canonicalize().ok().and_then(|r| real.strip_prefix(r).ok().map(Path::to_path_buf)) {
        return Some(LinkPath { path: rel.to_string_lossy().into_owned(), dir, inside: true });
    }
    Some(LinkPath { path: real.to_string_lossy().into_owned(), dir, inside: false })
}

pub(crate) fn paths_exist_in(root: &Path, home: &Path, paths: &[String]) -> Vec<bool> {
    paths.iter().enumerate().map(|(i, p)| i < MAX_BATCH && path_exists_in(root, home, p)).collect()
}

fn is_sha(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Which of `shas` name a commit in the checkout at `root`: one `cat-file --batch-check` process
/// for the whole batch. An ambiguous short hash is not a commit link.
pub(crate) fn commits_exist_in(root: &Path, shas: &[String]) -> Vec<bool> {
    let mut answers = vec![false; shas.len()];
    let asked: Vec<usize> = (0..shas.len()).filter(|&i| i < MAX_BATCH && is_sha(&shas[i])).collect();
    if asked.is_empty() {
        return answers;
    }
    let Ok(mut child) = Command::new("git")
        .args(["cat-file", "--batch-check"])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return answers;
    };
    let input: String = asked.iter().map(|&i| format!("{}^{{commit}}\n", shas[i])).collect();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }
    let Ok(out) = child.wait_with_output() else { return answers };
    for (&i, line) in asked.iter().zip(String::from_utf8_lossy(&out.stdout).lines()) {
        answers[i] = line.contains(" commit ");
    }
    answers
}

fn checkout(project: &str) -> Option<PathBuf> {
    crate::hub::project_dir(project).filter(|d| d.is_dir())
}

#[tauri::command]
pub(crate) fn paths_exist(project: String, paths: Vec<String>) -> Vec<bool> {
    match checkout(&project) {
        Some(root) => paths_exist_in(&root, &home(), &paths),
        None => vec![false; paths.len()],
    }
}

#[tauri::command]
pub(crate) fn resolve_link_path(project: String, path: String) -> Option<LinkPath> {
    resolve_in(&checkout(&project)?, &home(), &path)
}

#[tauri::command]
pub(crate) fn commits_exist(project: String, shas: Vec<String>) -> Vec<bool> {
    match checkout(&project) {
        Some(root) => commits_exist_in(&root, &shas),
        None => vec![false; shas.len()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("trantor-link-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn paths_resolve_against_the_checkout_and_never_escape_it_or_home() {
        let base = scratch("paths");
        let root = base.join("repo");
        let home = base.join("home");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(root.join("src/a.ts"), "x").unwrap();
        std::fs::write(home.join("notes.md"), "x").unwrap();
        std::fs::write(base.join("outside.txt"), "x").unwrap();
        let abs = root.join("src/a.ts").to_string_lossy().into_owned();
        let outside_abs = base.join("outside.txt").to_string_lossy().into_owned();
        let asked: Vec<String> = ["src/a.ts", "src", "src/missing.ts", "~/notes.md", "../outside.txt", abs.as_str(), outside_abs.as_str(), "", "src/../src/a.ts"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            paths_exist_in(&root, &home, &asked),
            [true, true, false, true, false, true, false, false, true]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_checkout_is_refused() {
        let base = scratch("symlink");
        let root = base.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(base.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(base.join("secret"), root.join("link")).unwrap();
        assert!(!path_exists_in(&root, &base.join("nohome"), "link"));
    }

    #[test]
    fn commits_are_confirmed_by_the_checkout() {
        let root = scratch("commits");
        let run = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&root).output().unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        run(&["init", "-q"]);
        std::fs::write(root.join("f"), "x").unwrap();
        run(&["add", "f"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
        let full = run(&["rev-parse", "HEAD"]);
        let short = full[..8].to_string();
        let asked = vec![short, full.clone(), "deadbeef".to_string(), "xyz1234".to_string(), "abc".to_string()];
        assert_eq!(commits_exist_in(&root, &asked), [true, true, false, false, false]);
        assert_eq!(commits_exist_in(&root, &[]), Vec::<bool>::new());
    }

    #[test]
    fn a_link_path_resolves_to_the_checkout_relative_name_and_says_if_it_is_a_folder() {
        let base = scratch("resolve");
        let root = base.join("repo");
        let home = base.join("home");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(root.join("src/a.ts"), "x").unwrap();
        std::fs::write(home.join("n.md"), "x").unwrap();
        let abs = root.join("src/a.ts").to_string_lossy().into_owned();
        let link = |path: &str, dir: bool, inside: bool| Some(LinkPath { path: path.to_string(), dir, inside });
        assert_eq!(resolve_in(&root, &home, &abs), link("src/a.ts", false, true));
        assert_eq!(resolve_in(&root, &home, "src"), link("src", true, true));
        assert_eq!(resolve_in(&root, &home, "src/../src/a.ts"), link("src/a.ts", false, true));
        assert_eq!(resolve_in(&root, &home, "~/n.md"), link(&home.join("n.md").to_string_lossy(), false, false));
        assert_eq!(resolve_in(&root, &home, "nope"), None);
        assert_eq!(resolve_in(&root, &home, "../outside"), None);
    }

    #[test]
    fn a_folder_that_is_not_a_repo_confirms_no_commit() {
        let root = scratch("norepo");
        assert_eq!(commits_exist_in(&root, &["deadbeef".to_string()]), [false]);
    }
}
