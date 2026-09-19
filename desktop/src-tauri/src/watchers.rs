#[allow(unused_imports)]
use super::*;

// Status and chat watchers share one stop flag keyed by `project:session`, tagged with the
// generation it was created with: a stale unwatch must not kill a fresh watcher (#6113).
pub(crate) static CHAT_WATCHERS: std::sync::Mutex<Option<std::collections::HashMap<String, (u64, Arc<AtomicBool>)>>> =
    std::sync::Mutex::new(None);
pub(crate) static CHAT_WATCH_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) static FILE_WATCHERS: std::sync::Mutex<Option<std::collections::HashMap<String, Arc<AtomicBool>>>> =
    std::sync::Mutex::new(None);

pub(crate) fn seed_tail(path: &Path) -> (TranscriptTail, u64, ChatMeta) {
    let mut tail = TranscriptTail::default();
    let mut meta = ChatMeta {
        context: chat_context(None, read_context_window()),
        ..ChatMeta::default()
    };
    if let Ok(raw) = std::fs::read_to_string(path) {
        tail.seed_from_raw(&raw);
        meta = decode_chat_lines(complete_lines(&raw), tail.line_offset).meta;
    }
    let total = tail.line_offset as u64;
    (tail, total, meta)
}

pub(crate) fn chat_watcher_key(project: &str, session_id: Option<&str>) -> String {
    format!("{project}:{}", session_id.unwrap_or("orchestrator"))
}

pub(crate) fn forget_chat_watcher(key: &str, stop: &Arc<AtomicBool>) {
    let mut g = CHAT_WATCHERS.lock().unwrap();
    if let Some(map) = g.as_mut() {
        if map.get(key).is_some_and(|(_, live)| Arc::ptr_eq(live, stop)) {
            map.remove(key);
        }
    }
}

/// Look up (or create) the watcher entry for `key`. Returns the entry's generation, its stop
/// flag, and whether this call just created it (false means a live watcher was already there —
/// the caller should not spawn a second one).
pub(crate) fn chat_watchers_watch(key: &str) -> (u64, Arc<AtomicBool>, bool) {
    let mut g = CHAT_WATCHERS.lock().unwrap();
    let map = g.get_or_insert_with(std::collections::HashMap::new);
    if let Some((generation, stop)) = map.get(key) {
        return (*generation, Arc::clone(stop), false);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let generation = CHAT_WATCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    map.insert(key.to_string(), (generation, Arc::clone(&stop)));
    (generation, stop, true)
}

/// Stop and remove the watcher at `key` only when `generation` matches (or is None, for older
/// callers). A stale unwatch after a fresh chat_watch is a no-op (#6113).
pub(crate) fn chat_watchers_unwatch(key: &str, generation: Option<u64>) -> Option<Arc<AtomicBool>> {
    let mut g = CHAT_WATCHERS.lock().unwrap();
    let map = g.as_mut()?;
    let matches = match generation {
        Some(gen) => map.get(key).is_some_and(|(live_gen, _)| *live_gen == gen),
        None => true,
    };
    if matches {
        map.remove(key).map(|(_, stop)| stop)
    } else {
        None
    }
}

pub(crate) fn spawn_chat_watcher(
    window: tauri::Window,
    project: String,
    initial_session_id: String,
    initial_path: PathBuf,
    pinned: bool,
    watcher_key: String,
    mut tail: TranscriptTail,
    mut meta: ChatMeta,
    stop: Arc<AtomicBool>,
) {
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        let mut session_id = initial_session_id;
        let mut path = Some(initial_path);
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }

            if !pinned {
                if let Some(next_session_id) = orch_session_id(&project) {
                    if next_session_id != session_id {
                        session_id = next_session_id;
                        tail.reset();
                        meta = ChatMeta {
                            context: chat_context(None, read_context_window()),
                            ..ChatMeta::default()
                        };
                        path = orchestrator_transcript_path(&project, &session_id).ok();
                        let payload = ChatSessionChangedPayload {
                            project: project.clone(),
                            session_id: session_id.clone(),
                        };
                        if window.emit("chat-session-changed", payload).is_err() {
                            break;
                        }
                    }
                }
            }

            if let Some(p) = path.as_deref() {
                match tail.read_new_lines(p) {
                    Ok((after, lines, total)) if !lines.is_empty() => {
                        let snap = decode_chat_lines(lines, total);
                        merge_chat_meta(&mut meta, snap.meta.clone());
                        let payload = ChatRowsPayload {
                            project: project.clone(),
                            session_id: session_id.clone(),
                            after,
                            total,
                            turns: snap.turns,
                            results: snap.results,
                            meta: meta.clone(),
                            receipt_texts: snap.receipt_texts,
                            turn_ended: snap.turn_ended,
                        };
                        if window.emit("chat-rows", payload).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => {}
                }
            }

            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        stop.store(true, Ordering::SeqCst);
        forget_chat_watcher(&watcher_key, &stop);
    });
}

/// Re-query the providers NOW through their owner (SYSTEM-CONTRACT §4: balances belong to
/// lib/balances.mjs; the app never calls a provider itself). The strip re-reads the snapshot after.
#[tauri::command]
pub(crate) fn balances_refresh() -> Result<(), String> {
    let out = trantor_cli::command()
        .args(["balances", "--json"])
        .output()
        .map_err(|e| format!("trantor balances: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct OrchStatusPayload {
    project: String,
    pane: String,
    status: String,
}

/// Push the orchestrator's lifecycle state instead of polling for it: one per-pane
/// `pane.agent_status_changed` subscription replaces a 3s `herdr agent list` subprocess loop.
/// The stream's quiet tick doubles as the health loop (re-check pane mapping, re-seed status).
pub(crate) fn spawn_status_watcher(window: tauri::Window, project: String, stop: Arc<AtomicBool>) {
    use tauri::Emitter;
    // Emits go through an async task, never straight from this OS thread: a `window.emit()` from a
    // raw std::thread reports ok and never reaches the frontend listener (#5993).
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<OrchStatusPayload>();
    tauri::async_runtime::spawn(async move {
        while let Some(payload) = rx.recv().await {
            let ok = window.emit("orch-status", payload.clone()).is_ok();
            trace(format!(
                "status: emit pane={} st={} ok={ok}",
                payload.pane, payload.status
            ));
        }
    });
    std::thread::spawn(move || {
        let mut last = String::new();
        let emit = |status: &str, pane: &str, last: &mut String| -> bool {
            if *last == status {
                trace(format!("status: emit skipped (unchanged) pane={pane} st={status}"));
                return true;
            }
            *last = status.to_string();
            tx.send(OrchStatusPayload {
                project: project.clone(),
                pane: pane.to_string(),
                status: status.to_string(),
            })
            .is_ok()
        };
        let orch_pane = |project: &str| -> Option<String> {
            let rows = std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt"))
                .unwrap_or_default();
            orch_pane_from_rows(&rows, project)
        };
        let nap = |stop: &AtomicBool, ticks: u32| -> bool {
            for _ in 0..ticks {
                if stop.load(Ordering::SeqCst) {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            true
        };
        trace(format!("status: watcher start project={project}"));
        while !stop.load(Ordering::SeqCst) {
            let Some(pane) = orch_pane(&project) else {
                trace(format!("status: no orch pane for project={project}"));
                if !emit("none", "", &mut last) {
                    return;
                }
                if !nap(&stop, 10) {
                    return;
                }
                continue;
            };
            let seeded = herdr::agent_status(&pane).unwrap_or_else(|| "unknown".to_string());
            trace(format!("status: seed pane={pane} st={seeded}"));
            if !emit(&seeded, &pane, &mut last) {
                return;
            }
            // Consecutive quiet ticks whose socket query came back None. One is a doubt; three
            // in a row is a dead subscription — the stream that froze on `working` for 40
            // minutes (#5993) never errored, it just went silent. Break and resubscribe: the
            // fresh pass re-seeds from one socket query on arrival.
            let mut dead_ticks: u32 = 0;
            match herdr::subscribe_status(&pane, Duration::from_secs(15)) {
                Ok(mut stream) => {
                  trace(format!("status: subscribed pane={pane}"));
                  loop {
                    if stop.load(Ordering::SeqCst) {
                        trace(format!("status: watcher stopped (stop flag) pane={pane}"));
                        return;
                    }
                    match stream.next_line() {
                        Ok(Some(line)) => {
                            // The stop flag can flip while next_line() was blocked waiting on
                            // the socket — an unwatched thread must never emit the frame it woke
                            // up with (#6113: a stale orch-status after chat_unwatch already ran).
                            if stop.load(Ordering::SeqCst) {
                                trace(format!("status: watcher stopped (stop flag) pane={pane}"));
                                return;
                            }
                            let parsed = herdr::status_from_frame(&line, &pane);
                            let head: String = line.trim().chars().take(220).collect();
                            trace(format!("status: frame parsed={parsed:?} raw={head}"));
                            if let Some(st) = parsed {
                                if !emit(&st, &pane, &mut last) {
                                    return;
                                }
                            }
                        }
                        Ok(None) => {
                            // Quiet tick: is this still the orch pane, and did we miss a frame?
                            if orch_pane(&project).as_deref() != Some(pane.as_str()) {
                                trace(format!("status: orch pane moved away from {pane}, resubscribing"));
                                break;
                            }
                            let st = herdr::agent_status(&pane);
                            trace(format!("status: quiet tick pane={pane} agent_status={st:?}"));
                            match st {
                                Some(st) => {
                                    dead_ticks = 0;
                                    if !emit(&st, &pane, &mut last) {
                                        return;
                                    }
                                }
                                None => {
                                    dead_ticks += 1;
                                    if dead_ticks >= 3 {
                                        app_trace(&format!(
                                            "status: pane={pane} agent_status=None for {dead_ticks} quiet ticks — resubscribing"
                                        ));
                                        break;
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            trace(format!("status: stream error pane={pane} err={e}"));
                            break;
                        }
                    }
                  }
                }
                Err(e) => {
                    trace(format!("status: subscribe failed pane={pane} err={e}"));
                    if !nap(&stop, 6) {
                        return;
                    }
                }
            }
        }
        trace(format!("status: watcher exit project={project}"));
    });
}

/// #6094 acceptance drill: fires the same async-task emit spawn_status_watcher uses, on the drill
/// script's own schedule. Gated on TRANTOR_ASK_DRILL so the capability never exists in a normal run.
#[tauri::command]
pub(crate) fn ask_drill_fire_status(window: tauri::Window, project: String, status: String) -> Result<(), String> {
    if std::env::var("TRANTOR_ASK_DRILL").is_err() {
        return Err("ask_drill_fire_status is drill-only (TRANTOR_ASK_DRILL not set)".into());
    }
    use tauri::Emitter;
    let payload = OrchStatusPayload { project, pane: "ask-drill-real-emit".into(), status };
    tauri::async_runtime::spawn(async move {
        let ok = window.emit("orch-status", payload.clone()).is_ok();
        trace(format!(
            "ask-drill: fired the real emit path pane={} st={} ok={ok}",
            payload.pane, payload.status
        ));
    });
    Ok(())
}

/// `current` keeps the old shape's meaning (the tail cursor at seed time); `generation` is the
/// token chat_unwatch must echo back so a stale unwatch can't kill a fresher watcher (#6113).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatWatchResult {
    current: u64,
    generation: u64,
}

#[tauri::command]
pub(crate) fn chat_watch(window: tauri::Window, project: String, session_id: Option<String>) -> Result<ChatWatchResult, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    let pinned = session_id.is_some();
    let sid = match session_id.as_deref() {
        Some(id) => id.to_string(),
        None => orch_session_id(&project)
            .ok_or_else(|| "no orchestrator session for this project yet".to_string())?,
    };
    let path = match session_id.as_deref() {
        Some(id) => sessions::claude_transcript_path(&project, id)?,
        None => orchestrator_transcript_path(&project, &sid)?,
    };
    let (tail, current, meta) = seed_tail(&path);
    let watcher_key = chat_watcher_key(&project, session_id.as_deref());

    let (generation, stop, is_new) = chat_watchers_watch(&watcher_key);
    if !is_new {
        trace(format!("chat_watch key={watcher_key} pinned={pinned} existing=true generation={generation}"));
        return Ok(ChatWatchResult { current, generation });
    }
    trace(format!("chat_watch key={watcher_key} pinned={pinned} existing=false generation={generation}"));

    if !pinned {
        spawn_status_watcher(window.clone(), project.clone(), Arc::clone(&stop));
    }
    spawn_chat_watcher(window, project, sid, path, pinned, watcher_key, tail, meta, stop);
    Ok(ChatWatchResult { current, generation })
}

#[tauri::command]
pub(crate) fn chat_unwatch(project: String, session_id: Option<String>, generation: Option<u64>) {
    let project = project.trim();
    if project.is_empty() {
        return;
    }
    let key = chat_watcher_key(project, session_id.as_deref());
    let stop = chat_watchers_unwatch(&key, generation);
    trace(format!(
        "chat_unwatch key={key} found={} generation={generation:?}",
        stop.is_some()
    ));
    if let Some(stop) = stop {
        stop.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod chat_watcher_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A key unique to this test run, so parallel `cargo test` threads sharing the global
    /// CHAT_WATCHERS map never collide with each other.
    fn unique_key(name: &str) -> String {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        format!("chat-watcher-test-{name}-{nonce}")
    }

    #[test]
    fn stale_unwatch_with_old_generation_does_not_stop_fresh_watcher() {
        let key = unique_key("stale-vs-fresh");

        // The old watcher: created, then its own task tears itself down the way
        // spawn_chat_watcher's loop does on natural exit (forget_chat_watcher), leaving the
        // stop flag alone — this mirrors a watcher that finished without ever being unwatched.
        let (old_generation, old_stop, old_is_new) = chat_watchers_watch(&key);
        assert!(old_is_new);
        forget_chat_watcher(&key, &old_stop);

        // A fresh chat_watch for the SAME key lands next, minting a new generation.
        let (fresh_generation, fresh_stop, fresh_is_new) = chat_watchers_watch(&key);
        assert!(fresh_is_new, "fresh watch must recreate the entry once the old one is gone");
        assert_ne!(old_generation, fresh_generation, "each watch gets its own generation token");

        // The stale unwatch — still carrying the OLD generation — arrives late and must be a
        // no-op against the fresh entry.
        let stopped = chat_watchers_unwatch(&key, Some(old_generation));
        assert!(stopped.is_none(), "a stale generation must not match the fresh entry");
        assert!(!fresh_stop.load(Ordering::SeqCst), "the fresh watcher's stop flag must be untouched");

        // The fresh entry is still there, unharmed.
        let (still_generation, _, still_is_new) = chat_watchers_watch(&key);
        assert!(!still_is_new, "the fresh entry must still be registered");
        assert_eq!(still_generation, fresh_generation);

        // A matching-generation unwatch DOES stop it.
        let stopped = chat_watchers_unwatch(&key, Some(fresh_generation));
        assert!(stopped.is_some(), "the matching generation must be allowed to stop the watcher");
        stopped.unwrap().store(true, Ordering::SeqCst);
        assert!(fresh_stop.load(Ordering::SeqCst), "the shared stop flag must now be set");

        // And the entry is gone from the map.
        let (_, _, recreated_is_new) = chat_watchers_watch(&key);
        assert!(recreated_is_new, "unwatch must have removed the entry");
        forget_chat_watcher(&key, &fresh_stop); // cleanup: don't leak this test's key into CHAT_WATCHERS
    }

    #[test]
    fn unwatch_with_no_generation_keeps_old_caller_behavior() {
        let key = unique_key("no-generation");
        let (_, stop, is_new) = chat_watchers_watch(&key);
        assert!(is_new);

        // An older caller that never learned about generations passes None — it should still
        // unconditionally stop whatever is at the key, exactly like before this fix.
        let stopped = chat_watchers_unwatch(&key, None);
        assert!(stopped.is_some());
        assert!(Arc::ptr_eq(&stopped.unwrap(), &stop));
    }
}

pub(crate) fn forget_file_watcher(project: &str, stop: &Arc<AtomicBool>) {
    let mut g = FILE_WATCHERS.lock().unwrap();
    if let Some(map) = g.as_mut() {
        if let Some(existing) = map.get(project) {
            if Arc::ptr_eq(existing, stop) {
                map.remove(project);
            }
        }
    }
}

pub(crate) fn is_ignored(path: &Path, ignore_list: &[&str]) -> bool {
    path.components().any(|c| ignore_list.contains(&c.as_os_str().to_string_lossy().as_ref()))
}

#[tauri::command]
pub(crate) fn file_watch(window: tauri::Window, project: String) -> Result<(), String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("project is required".into());
    }
    let root = project_dir(&project).ok_or_else(|| format!("no local checkout for {project}"))?;

    {
        let g = FILE_WATCHERS.lock().unwrap();
        if let Some(map) = g.as_ref() {
            if map.contains_key(&project) {
                return Ok(());
            }
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);

    {
        let mut g = FILE_WATCHERS.lock().unwrap();
        let map = g.get_or_insert_with(std::collections::HashMap::new);
        map.insert(project.clone(), Arc::clone(&stop));
    }

    let (tx, rx) = std::sync::mpsc::channel();

    let mut watcher = notify::recommended_watcher(
        move |res| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        },
    )
    .map_err(|e| format!("failed to create watcher: {e}"))?;

    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {project}: {e}"))?;

    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let mut batch: Vec<String> = Vec::new();
        let mut last_emit = Instant::now();
        let ignore_list = TREE_SKIP;

        loop {
            if stop_clone.load(Ordering::SeqCst) {
                break;
            }

            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(event) => {
                    for path in event.paths {
                        let rel = path.strip_prefix(&root).unwrap_or(&path);
                        let rel_str = rel.to_string_lossy().to_string();
                        if !rel_str.is_empty() && !is_ignored(rel, ignore_list) {
                            batch.push(rel_str);
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }

            if last_emit.elapsed() >= Duration::from_millis(200) && !batch.is_empty() {
                let paths = std::mem::take(&mut batch);
                last_emit = Instant::now();
                let payload = serde_json::json!({ "project": project, "paths": paths });
                if window.emit("file-changed", payload).is_err() {
                    break;
                }
            }
        }

        if !batch.is_empty() {
            let payload = serde_json::json!({ "project": project, "paths": batch });
            let _ = window.emit("file-changed", payload);
        }

        stop_clone.store(true, Ordering::SeqCst);
        forget_file_watcher(&project, &stop_clone);
    });

    Ok(())
}

#[tauri::command]
pub(crate) fn file_unwatch(project: String) {
    let project = project.trim();
    if project.is_empty() {
        return;
    }
    let stop = {
        let mut g = FILE_WATCHERS.lock().unwrap();
        g.as_mut().and_then(|map| map.remove(project))
    };
    if let Some(stop) = stop {
        stop.store(true, Ordering::SeqCst);
    }
}
