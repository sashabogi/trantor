// First-run setup checks and guided installs for the trantor CLI and herdr (#14322).
use serde::Serialize;
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};

/// herdr's own installer, the same one-liner `trantor open` tells a user to run.
const HERDR_INSTALL: &str = "curl -fsSL https://herdr.dev/install.sh | sh";

#[derive(Debug, Eq, PartialEq, Clone, Copy)]
pub(crate) enum Target {
    Trantor,
    Herdr,
}

impl Target {
    fn parse(s: &str) -> Option<Target> {
        match s {
            "trantor" => Some(Target::Trantor),
            "herdr" => Some(Target::Herdr),
            _ => None,
        }
    }
}

/// Pure: the program and arguments an install runs.
pub(crate) fn install_command(target: Target) -> (&'static str, Vec<&'static str>) {
    match target {
        Target::Trantor => ("npm", vec!["i", "-g", "trantor@latest"]),
        Target::Herdr => ("sh", vec!["-c", HERDR_INSTALL]),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupReport {
    pub node: Option<String>,
    pub npm: bool,
    pub trantor: Option<String>,
    pub trantor_compatible: bool,
    pub trantor_minimum: &'static str,
    pub herdr: Option<String>,
}

fn which_in_path(name: &str) -> Option<std::path::PathBuf> {
    crate::terminal_path()
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|d| std::path::Path::new(d).join(name))
        .find(|p| p.is_file())
}

#[tauri::command]
pub(crate) async fn setup_check() -> SetupReport {
    let node = match which_in_path("node") {
        Some(p) => tokio::process::Command::new(p)
            .arg("--version")
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()),
        None => None,
    };
    let trantor = crate::trantor_cli::version().await;
    SetupReport {
        node,
        npm: which_in_path("npm").is_some(),
        trantor_compatible: trantor.as_deref().is_some_and(crate::trantor_cli::version_is_compatible),
        trantor,
        trantor_minimum: crate::trantor_cli::MIN_VERSION,
        herdr: crate::local_sessions::find_herdr_binary().map(|p| p.to_string_lossy().into_owned()),
    }
}

static CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> = std::sync::Mutex::new(None);

#[derive(Serialize, Clone)]
struct Line {
    target: String,
    line: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    pub cancelled: bool,
    pub code: Option<i32>,
}

async fn pump<R: tokio::io::AsyncRead + Unpin>(app: tauri::AppHandle, target: String, stream: R) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let _ = app.emit("setup-install-line", Line { target: target.clone(), line });
    }
}

/// Run an install, streaming each output line as a `setup-install-line` event.
#[tauri::command]
pub(crate) async fn setup_install(app: tauri::AppHandle, target: String) -> Result<InstallResult, String> {
    let kind = Target::parse(&target).ok_or_else(|| format!("unknown install target {target}"))?;
    let (program, args) = install_command(kind);
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut slot = crate::lock_or_recover(&CANCEL);
        if slot.is_some() {
            return Err("an install is already running".into());
        }
        *slot = Some(tx);
    }
    let result = run_install(app, target, program, args, rx).await;
    *crate::lock_or_recover(&CANCEL) = None;
    result
}

async fn run_install(
    app: tauri::AppHandle,
    target: String,
    program: &str,
    args: Vec<&str>,
    rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<InstallResult, String> {
    let mut command = crate::identity_env::async_command(program);
    command
        .args(args)
        .env("PATH", crate::terminal_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = command.spawn().map_err(|e| format!("could not run {program}: {e}"))?;
    let pid = child.id();
    let out = child.stdout.take().map(|s| tokio::spawn(pump(app.clone(), target.clone(), s)));
    let err = child.stderr.take().map(|s| tokio::spawn(pump(app.clone(), target.clone(), s)));
    let (status, cancelled) = tokio::select! {
        s = child.wait() => (s.map_err(|e| e.to_string())?, false),
        _ = rx => {
            if let Some(pid) = pid {
                // SAFETY: signalling the install's own process group; pid came from this child.
                unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
            }
            (child.wait().await.map_err(|e| e.to_string())?, true)
        }
    };
    for task in [out, err].into_iter().flatten() {
        let _ = task.await;
    }
    Ok(InstallResult { ok: status.success() && !cancelled, cancelled, code: status.code() })
}

#[tauri::command]
pub(crate) fn setup_install_cancel() {
    if let Some(tx) = crate::lock_or_recover(&CANCEL).take() {
        let _ = tx.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_trantor_install_is_a_global_npm_install_of_latest() {
        assert_eq!(install_command(Target::Trantor), ("npm", vec!["i", "-g", "trantor@latest"]));
    }

    #[test]
    fn the_herdr_install_is_the_repo_one_liner() {
        let (program, args) = install_command(Target::Herdr);
        assert_eq!(program, "sh");
        assert_eq!(args, vec!["-c", HERDR_INSTALL]);
    }

    #[test]
    fn only_known_targets_parse() {
        assert_eq!(Target::parse("herdr"), Some(Target::Herdr));
        assert_eq!(Target::parse("trantor"), Some(Target::Trantor));
        assert_eq!(Target::parse("rm -rf"), None);
    }
}
