//! The agent socket: `<bus>/browser.sock`, mode 0600, one JSON object per line each way.

use super::core::BrowserCore;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_LINE: u64 = 1 << 20;

pub fn socket_path(bus: &Path) -> PathBuf {
    bus.join("browser.sock")
}

/// Binds the socket and serves it on background threads. Returns the path, or an error when
/// another live app already owns the socket.
pub fn serve(core: Arc<BrowserCore>) -> std::io::Result<PathBuf> {
    let bus = core.bus_dir().clone();
    std::fs::create_dir_all(&bus)?;
    let path = socket_path(&bus);
    if path.exists() {
        if UnixStream::connect(&path).is_ok() {
            return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "another Trantor already serves the browser socket"));
        }
        let _ = std::fs::remove_file(&path);
    }
    // owner-only from creation: the bus dir is world-readable, so a chmod after bind leaves a gap
    let old_mask = unsafe { libc::umask(0o177) };
    let bound = UnixListener::bind(&path);
    unsafe { libc::umask(old_mask) };
    let listener = bound?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let core = core.clone();
            std::thread::spawn(move || serve_connection(&core, conn));
        }
    });
    Ok(path)
}

pub fn serve_connection(core: &Arc<BrowserCore>, conn: UnixStream) {
    let Ok(mut out) = conn.try_clone() else { return };
    let mut reader = BufReader::new(conn);
    loop {
        let mut line = String::new();
        match reader.by_ref().take(MAX_LINE).read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if line.trim().is_empty() {
            continue;
        }
        let mut resp = core.handle_line(line.trim());
        resp.push('\n');
        if out.write_all(resp.as_bytes()).is_err() {
            return;
        }
    }
}

pub fn remove(bus: &Path) {
    let _ = std::fs::remove_file(socket_path(bus));
}
