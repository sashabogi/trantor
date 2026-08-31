use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const DETACH_REAP_TIMEOUT: Duration = Duration::from_secs(2);

type ByteSink = Arc<dyn Fn(Vec<u8>) + Send + Sync + 'static>;

struct TerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    reaped: Arc<AtomicBool>,
    pid: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DetachReport {
    pid: Option<u32>,
    reaped: bool,
}

#[derive(Default)]
pub struct TerminalManager {
    next_sub: AtomicU64,
    sessions: Mutex<HashMap<u64, Arc<TerminalSession>>>,
}

impl TerminalManager {
    fn attach_command(&self, mut cmd: CommandBuilder, on_bytes: ByteSink) -> Result<u64, String> {
        cmd.env("PATH", crate::terminal_path());
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                cols: DEFAULT_COLS,
                rows: DEFAULT_ROWS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("open pty: {e}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take pty writer: {e}"))?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn attach: {e}"))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        let reaped = Arc::new(AtomicBool::new(false));
        let reaped_for_waiter = Arc::clone(&reaped);

        thread::spawn(move || {
            let _ = child.wait();
            reaped_for_waiter.store(true, Ordering::SeqCst);
        });

        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => on_bytes(buf[..n].to_vec()),
                    Err(_) => break,
                }
            }
        });

        let sub = self.next_sub.fetch_add(1, Ordering::SeqCst) + 1;
        let session = Arc::new(TerminalSession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            reaped,
            pid,
        });
        self.sessions.lock().unwrap().insert(sub, session);
        Ok(sub)
    }

    fn write(&self, sub: u64, data: &str) -> Result<(), String> {
        let session = self.session(sub)?;
        let mut writer = session.writer.lock().unwrap();
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| format!("term write {sub}: {e}"))
    }

    fn resize(&self, sub: u64, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(sub)?;
        let result = {
            let master = session.master.lock().unwrap();
            master
                .resize(PtySize {
                    cols,
                    rows,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("term resize {sub}: {e}"))
        };
        result
    }

    fn detach(&self, sub: u64) -> Result<DetachReport, String> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(&sub)
            .ok_or_else(|| format!("unknown terminal subscription {sub}"))?;
        {
            let mut killer = session.killer.lock().unwrap();
            let _ = killer.kill();
        }
        drop(session.writer.lock().unwrap());
        let deadline = Instant::now() + DETACH_REAP_TIMEOUT;
        while !session.reaped.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        Ok(DetachReport {
            pid: session.pid,
            reaped: session.reaped.load(Ordering::SeqCst),
        })
    }

    fn session(&self, sub: u64) -> Result<Arc<TerminalSession>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(&sub)
            .cloned()
            .ok_or_else(|| format!("unknown terminal subscription {sub}"))
    }

    #[cfg(test)]
    fn contains(&self, sub: u64) -> bool {
        self.sessions.lock().unwrap().contains_key(&sub)
    }
}

/// The one boot prompt a WOKEN session gets. Same doctrine as handoff_now's KICKOFF_PROMPT —
/// a session never runs a turn unprompted, so without this the wake delivered a silent pane
/// (2026-08-31, crebral-health: no recap, operator waiting) — but wake must not assert a
/// handoff exists, because a woken project may simply have been asleep.
const WAKE_KICKOFF_PROMPT: &str = "You were just woken via Trantor. Catch up from your context \
    — the handoff you were handed if one exists, otherwise the project board and memory — then \
    recap where things stand in at most 3 sentences and wait.";

#[tauri::command]
pub fn orchestrator_open(project: String) -> Result<String, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    // The 2026-08-31 crebral-health wake: `trantor open` inherits the caller's cwd (crew.sh's
    // DIR="$(pwd)"), and the app's cwd is nowhere near the checkout — so claude booted in the
    // wrong folder: a trust prompt for a directory the operator never chose, transcripts under
    // the wrong slug, no project memory, and ACTIVE NOW blind (it maps sessions by cwd).
    // handoff_now always resolved the dir before running the CLI; open now does the same.
    let dir = crate::project_dir(&project)
        .ok_or_else(|| format!("no local checkout for {project}"))?;
    let out = Command::new("trantor")
        .arg("open")
        .arg(&project)
        .current_dir(&dir)
        .env("PATH", crate::terminal_path())
        .output()
        .map_err(|e| format!("trantor open: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        return Err(format!("trantor open failed: {}", stderr.trim()));
    }
    let target = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if target.is_empty() {
        return Err("trantor open returned no herdr target".into());
    }
    // KICKOFF-AFTER-WAKE: only when this open actually STARTED a conversation. A pure reattach
    // ("already hosted: reattached" on stderr — the exact phrase crew.sh open_orchestrator
    // prints, bound by comment there) is someone's live session and must not be typed into.
    // The waiter is a plain thread: the fresh claude takes seconds to boot (and may sit at a
    // dialog), and herdr::prompt refuses Blocked/NotReady/NoAgent BEFORE any bytes land, so
    // retrying is safe. Stalled means bytes may have landed — never retry past it.
    if !stderr.contains("already hosted: reattached") {
        if let Some(pane) = target.rsplit('/').next().map(str::to_string) {
            std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
                loop {
                    match crate::herdr::prompt(&pane, WAKE_KICKOFF_PROMPT) {
                        Ok(crate::herdr::PromptOutcome::Delivered) => break,
                        Ok(crate::herdr::PromptOutcome::Stalled) => break,
                        Ok(_) | Err(_) => {
                            if std::time::Instant::now() > deadline {
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_secs(3));
                        }
                    }
                }
            });
        }
    }
    Ok(target)
}

#[tauri::command]
pub async fn term_attach(
    target: String,
    on_bytes: Channel<Vec<u8>>,
    terminals: State<'_, TerminalManager>,
) -> Result<u64, String> {
    if target.trim().is_empty() {
        return Err("target is required".into());
    }
    let mut cmd = CommandBuilder::new("herdr");
    cmd.args(["agent", "attach", target.as_str()]);
    terminals.attach_command(
        cmd,
        Arc::new(move |bytes| {
            let _ = on_bytes.send(bytes);
        }),
    )
}

#[tauri::command]
pub fn term_write(
    sub: u64,
    data: String,
    terminals: State<'_, TerminalManager>,
) -> Result<(), String> {
    terminals.write(sub, &data)
}

#[tauri::command]
pub fn term_resize(
    sub: u64,
    cols: u16,
    rows: u16,
    terminals: State<'_, TerminalManager>,
) -> Result<(), String> {
    terminals.resize(sub, cols, rows)
}

#[tauri::command]
pub fn term_detach(sub: u64, terminals: State<'_, TerminalManager>) -> Result<(), String> {
    let report = terminals.detach(sub)?;
    if report.reaped {
        Ok(())
    } else {
        Err(format!(
            "terminal subscription {sub} child {:?} did not exit after detach",
            report.pid
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn shell_command(script: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-lc", script]);
        cmd
    }

    #[test]
    fn sub_ids_are_monotonic_and_removed_on_detach() {
        let manager = TerminalManager::default();
        let sink: ByteSink = Arc::new(|_| {});

        let first = manager
            .attach_command(
                shell_command("while :; do sleep 1; done"),
                Arc::clone(&sink),
            )
            .expect("first attach");
        let second = manager
            .attach_command(shell_command("while :; do sleep 1; done"), sink)
            .expect("second attach");

        assert_eq!(first, 1);
        assert_eq!(second, 2);
        assert!(manager.contains(first));
        assert!(manager.contains(second));

        assert!(manager.detach(first).expect("detach first").reaped);
        assert!(!manager.contains(first));
        assert!(manager.contains(second));

        assert!(manager.detach(second).expect("detach second").reaped);
        assert!(!manager.contains(second));
    }

    #[test]
    fn detach_kills_and_reaps_the_child() {
        let manager = TerminalManager::default();
        let sub = manager
            .attach_command(
                shell_command("trap 'exit 0' TERM; while :; do sleep 1; done"),
                Arc::new(|_| {}),
            )
            .expect("attach");

        let report = manager.detach(sub).expect("detach");
        assert!(
            report.pid.is_some(),
            "portable-pty should expose the child pid on Unix"
        );
        assert!(
            report.reaped,
            "detach must wait for the waiter thread to reap the child"
        );
        assert!(!manager.contains(sub));
    }

    #[test]
    fn output_streams_bytes_and_write_passes_raw_input() {
        let manager = TerminalManager::default();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let sub = manager
            .attach_command(
                shell_command("IFS= read -r line; printf 'echo:%s\\n' \"$line\""),
                Arc::new(move |bytes| {
                    tx.send(bytes).unwrap();
                }),
            )
            .expect("attach");

        manager.write(sub, "hello\u{1b}[D\n").expect("write");
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline
            && !String::from_utf8_lossy(&seen).contains("echo:hello\u{1b}[D")
        {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(50)) {
                seen.extend(chunk);
            }
        }
        let text = String::from_utf8_lossy(&seen);
        assert!(text.contains("echo:hello\u{1b}[D"), "got {text:?}");
        assert!(manager.detach(sub).expect("detach").reaped);
    }

    #[test]
    fn resize_survives_after_child_exit_until_detach() {
        let manager = TerminalManager::default();
        let sub = manager
            .attach_command(shell_command("exit 0"), Arc::new(|_| {}))
            .expect("attach");
        thread::sleep(Duration::from_millis(100));

        let _ = manager.resize(sub, 100, 30);
        assert!(manager.detach(sub).expect("detach").reaped);
    }
}
