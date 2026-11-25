// Plain project shells for Developer mode's bottom panel: a login shell in the checkout, not a seat (#14080).
use crate::terminal::{EndSink, TerminalManager};
use portable_pty::CommandBuilder;
use std::{path::Path, sync::Arc};
use tauri::{ipc::Channel, Emitter, State};

const FALLBACK_SHELL: &str = "/bin/zsh";
/// The webview learns a shell ended on its own through this event; the payload is the sub.
pub(crate) const SHELL_EXIT_EVENT: &str = "term-shell-exit";
/// Names the shell must never inherit from an app launched out of an agent pane; the shared
/// scrub covers the rest (TRANTOR_ORCH, HERDR_*, RELAY_*, CLAUDE_CODE_*, CLAUDECODE).
const EXTRA_IDENTITY_KEYS: &[&str] = &["TRANTOR_PROJECT"];

/// What the shell is told about the terminal it runs in.
const TERMINAL_ENV: &[(&str, &str)] = &[
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("TERM_PROGRAM", "Trantor"),
    ("SHELL_SESSIONS_DISABLE", "1"),
];
/// Apple Terminal's own session markers, which an app launched from Terminal would otherwise pass on.
const INHERITED_TERMINAL_KEYS: &[&str] = &["TERM_SESSION_ID", "TERM_PROGRAM_VERSION"];

/// The exit event payload: the code is absent when the child could not be reaped in time (#14268).
#[derive(Clone, serde::Serialize)]
struct ShellExit {
    sub: u64,
    code: Option<u32>,
}

pub(crate) fn shell_command(dir: &Path, shell: Option<String>, carried_env: &[(&str, &str)]) -> CommandBuilder {
    let program = shell
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| FALLBACK_SHELL.to_string());
    let mut cmd = CommandBuilder::new(program);
    for (key, value) in carried_env {
        cmd.env(key, value);
    }
    cmd.arg("-l");
    cmd.cwd(dir);
    // #14268: macOS zsh restores a per-session history ("Restored session: ...") when it sees Apple Terminal's variables.
    for (key, value) in TERMINAL_ENV {
        cmd.env(key, value);
    }
    for key in EXTRA_IDENTITY_KEYS.iter().chain(INHERITED_TERMINAL_KEYS) {
        cmd.env_remove(key);
    }
    cmd
}

#[tauri::command]
pub fn term_shell_open(
    project: String,
    on_bytes: Channel<Vec<u8>>,
    app: tauri::AppHandle,
    terminals: State<'_, TerminalManager>,
) -> Result<u64, String> {
    let dir = crate::files::source_root(project.trim(), None)?;
    let cmd = shell_command(&dir, std::env::var("SHELL").ok(), &[]);
    let on_end: EndSink = Arc::new(move |sub, code| {
        let _ = app.emit(SHELL_EXIT_EVENT, ShellExit { sub, code });
    });
    terminals.attach_shell(
        cmd,
        Arc::new(move |bytes| {
            let _ = on_bytes.send(bytes);
        }),
        on_end,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };

    struct Probe {
        sub: u64,
        out: mpsc::Receiver<Vec<u8>>,
        ended: mpsc::Receiver<u64>,
        seen: String,
    }

    impl Probe {
        fn wait_for(&mut self, needle: &str) -> bool {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && !self.seen.contains(needle) {
                if let Ok(chunk) = self.out.recv_timeout(Duration::from_millis(50)) {
                    self.seen.push_str(&String::from_utf8_lossy(&chunk));
                }
            }
            self.seen.contains(needle)
        }
    }

    fn open(manager: &TerminalManager, dir: &Path, extra_env: &[(&str, &str)]) -> Probe {
        let (tx, out) = mpsc::channel::<Vec<u8>>();
        let (end_tx, ended) = mpsc::channel::<u64>();
        let cmd = shell_command(dir, Some("/bin/sh".into()), extra_env);
        let sub = manager
            .attach_shell(
                cmd,
                Arc::new(move |bytes| {
                    let _ = tx.send(bytes);
                }),
                Arc::new(move |sub, _code| {
                    let _ = end_tx.send(sub);
                }),
            )
            .expect("attach shell");
        Probe { sub, out, ended, seen: String::new() }
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("trantor-shell-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.canonicalize().expect("canonical temp dir")
    }

    #[test]
    fn a_shell_opens_in_the_given_folder() {
        let manager = TerminalManager::default();
        let dir = temp_dir("cwd");
        let mut shell = open(&manager, &dir, &[]);
        manager.write(shell.sub, "pwd\n").expect("write");
        assert!(shell.wait_for(dir.to_str().expect("utf8")), "got {:?}", shell.seen);
        assert!(manager.detach(shell.sub).expect("detach").reaped);
    }

    #[test]
    fn two_shells_are_independent_children() {
        let manager = TerminalManager::default();
        let dir = temp_dir("two");
        let mut a = open(&manager, &dir, &[]);
        let mut b = open(&manager, &dir, &[]);
        assert_ne!(a.sub, b.sub);
        manager.write(a.sub, "export WHO=alpha\necho who-$WHO\n").expect("write a");
        manager.write(b.sub, "echo who-${WHO:-none}\n").expect("write b");
        assert!(a.wait_for("who-alpha"), "got {:?}", a.seen);
        assert!(b.wait_for("who-none"), "got {:?}", b.seen);
        assert!(manager.detach(a.sub).expect("detach a").reaped);
        assert!(manager.write(b.sub, "true\n").is_ok(), "killing one shell must leave the other");
        assert!(manager.detach(b.sub).expect("detach b").reaped);
    }

    #[test]
    fn detach_kills_the_shell_and_reports_its_end() {
        let manager = TerminalManager::default();
        let dir = temp_dir("kill");
        let shell = open(&manager, &dir, &[]);
        assert!(manager.detach(shell.sub).expect("detach").reaped);
        assert!(manager.write(shell.sub, "x").is_err());
        assert_eq!(shell.ended.recv_timeout(Duration::from_secs(5)), Ok(shell.sub));
    }

    #[test]
    fn a_shell_that_exits_by_itself_reports_its_end() {
        let manager = TerminalManager::default();
        let dir = temp_dir("exit");
        let shell = open(&manager, &dir, &[]);
        manager.write(shell.sub, "exit\n").expect("write");
        assert_eq!(shell.ended.recv_timeout(Duration::from_secs(5)), Ok(shell.sub));
        let _ = manager.detach(shell.sub);
    }

    #[test]
    fn identity_variables_never_reach_the_shell() {
        let manager = TerminalManager::default();
        let dir = temp_dir("env");
        let leaks = [
            ("TRANTOR_ORCH", "1"), ("HERDR_PANE_ID", "p"), ("HERDR_TAB_ID", "t"),
            ("HERDR_WORKSPACE_ID", "w"), ("HERDR_ENV", "e"), ("RELAY_PROJECT", "r"),
            ("TRANTOR_PROJECT", "x"), ("CLAUDECODE", "1"), ("CLAUDE_CODE_SESSION_ID", "s"),
        ];
        let mut shell = open(&manager, &dir, &leaks);
        manager.write(shell.sub, "env | sort; echo ENV-$((40+2))\n").expect("write");
        assert!(shell.wait_for("ENV-42"), "got {:?}", shell.seen);
        for (key, _) in leaks {
            assert!(!shell.seen.contains(&format!("\n{key}=")), "{key} leaked: {:?}", shell.seen);
        }
        assert!(shell.seen.contains("TERM=xterm-256color"));
        assert!(manager.detach(shell.sub).expect("detach").reaped);
    }

    #[test]
    fn the_shell_env_names_trantor_and_drops_apple_terminal_session_markers() {
        std::env::set_var("TERM_SESSION_ID", "w0t0p0:ABC");
        std::env::set_var("TERM_PROGRAM", "Apple_Terminal");
        let cmd = shell_command(Path::new("/tmp"), Some("/bin/zsh".into()), &[]);
        assert_eq!(cmd.get_env("SHELL_SESSIONS_DISABLE").and_then(|v| v.to_str()), Some("1"));
        assert_eq!(cmd.get_env("TERM_PROGRAM").and_then(|v| v.to_str()), Some("Trantor"));
        assert_eq!(cmd.get_env("TERM").and_then(|v| v.to_str()), Some("xterm-256color"));
        assert_eq!(cmd.get_env("COLORTERM").and_then(|v| v.to_str()), Some("truecolor"));
        assert!(cmd.get_env("TERM_SESSION_ID").is_none());
        assert!(cmd.get_argv().iter().any(|a| a == "-l"));
    }

    #[test]
    fn a_shell_that_exits_reports_its_exit_code() {
        let manager = TerminalManager::default();
        let dir = temp_dir("code");
        let (end_tx, ended) = mpsc::channel::<(u64, Option<u32>)>();
        let cmd = shell_command(&dir, Some("/bin/sh".into()), &[]);
        let sub = manager
            .attach_shell(cmd, Arc::new(|_| {}), Arc::new(move |sub, code| { let _ = end_tx.send((sub, code)); }))
            .expect("attach shell");
        manager.write(sub, "exit 3\n").expect("write");
        assert_eq!(ended.recv_timeout(Duration::from_secs(5)), Ok((sub, Some(3))));
        let _ = manager.detach(sub);
    }
}
