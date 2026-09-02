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

/// The largest single write to the pty master, and the pause between writes. A paste can be many
/// kilobytes; the pty's input queue is bounded, so one giant `write_all` either blocks the whole
/// terminal thread or (on a non-blocking fd) returns EAGAIN and silently drops the rest. Chunked
/// writes with a drain beat keep the queue from overrunning.
const WRITE_CHUNK: usize = 512;
const WRITE_DRAIN: Duration = Duration::from_millis(2);

/// The bracketed-paste markers xterm wraps a paste in. Never split one across a chunk: a receiving
/// app that sees half a marker treats the rest as literal keystrokes (the "two inputs" symptom).
const BRACKETED_START: &[u8] = b"\x1b[200~";
const BRACKETED_END: &[u8] = b"\x1b[201~";

/// If `end` would cut a bracketed-paste marker in two, pull it back to the marker's start so the
/// marker rides whole in the next chunk.
fn avoid_splitting_marker(bytes: &[u8], end: usize) -> usize {
    for start in end.saturating_sub(BRACKETED_START.len() - 1)..end {
        let window = &bytes[start..];
        if window.starts_with(BRACKETED_START) || window.starts_with(BRACKETED_END) {
            return start;
        }
    }
    end
}

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
        let bytes = data.as_bytes();
        let mut offset = 0;
        while offset < bytes.len() {
            let mut end = (offset + WRITE_CHUNK).min(bytes.len());
            end = avoid_splitting_marker(bytes, end);
            writer
                .write_all(&bytes[offset..end])
                .and_then(|_| writer.flush())
                .map_err(|e| format!("term write {sub}: {e}"))?;
            offset = end;
            // Give the pty's bounded input queue a beat to drain into the child so a fast paste
            // cannot outrun a slow reader.
            if offset < bytes.len() {
                thread::sleep(WRITE_DRAIN);
            }
        }
        Ok(())
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
    fn a_large_bracketed_paste_survives_byte_for_byte() {
        let manager = TerminalManager::default();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let sub = manager
            .attach_command(
                // raw + no echo so the pty itself is transparent, then `cat` mirrors input to
                // output byte-for-byte — a byte-counting echo child.
                shell_command("stty raw -echo; printf 'READY'; exec cat"),
                Arc::new(move |bytes| {
                    tx.send(bytes).unwrap();
                }),
            )
            .expect("attach");

        // Wait for the child to put the pty in raw mode; a write before `stty raw` would sit in
        // the canonical line buffer (MAX_CANON) and is a different bug than the one under test.
        let mut pre = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && !String::from_utf8_lossy(&pre).contains("READY") {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(50)) {
                pre.extend(chunk);
            }
        }
        assert!(
            String::from_utf8_lossy(&pre).contains("READY"),
            "child never reached raw mode: {:?}",
            String::from_utf8_lossy(&pre)
        );

        let body = "x".repeat(4096);
        let paste = format!("\x1b[200~{body}\x1b[201~");
        manager.write(sub, &paste).expect("write");

        let expected = paste.as_bytes().to_vec();
        let mut got = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && got.len() < expected.len() {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                got.extend(chunk);
            }
        }
        assert_eq!(got.len(), expected.len(), "echoed {} of {} bytes", got.len(), expected.len());
        assert_eq!(got, expected, "paste was altered in transit");

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

    #[test]
    fn boundary_never_splits_a_bracketed_paste_marker() {
        // A marker starting at 510 would be cut by a 512-byte chunk boundary; the boundary must
        // pull back to 510 so the marker rides whole in the next chunk.
        let mut data = vec![b'x'; 520];
        data[510..516].copy_from_slice(BRACKETED_START);
        assert_eq!(avoid_splitting_marker(&data, 512), 510);

        // A marker that ends exactly on the boundary is whole — leave it.
        let mut data2 = vec![b'x'; 520];
        data2[506..512].copy_from_slice(BRACKETED_END);
        assert_eq!(avoid_splitting_marker(&data2, 512), 512);

        // No marker anywhere near the boundary: unchanged.
        assert_eq!(avoid_splitting_marker(&vec![b'x'; 600], 512), 512);
    }
}
