#[allow(unused_imports)]
use super::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Seconds since the epoch as text; the panic hook must not pull in a date crate or allocate much.
pub(crate) fn chrono_free_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

/// The message inside a panic payload: `panic!("...")` arrives as `&str`, `panic!(String)` as
/// `String`, and everything else still gets a named line rather than vanishing (#5917).
pub(crate) fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic payload".to_string())
}

/// One app-panics.log record. The crash reports of #5917 showed ONLY the abort, so the record
/// carries everything they never can: the message, the thread, the location, the backtrace.
pub(crate) fn panic_log_line(now: &str, thread: &str, msg: &str, loc: &str, backtrace: &str) -> String {
    if backtrace.is_empty() {
        format!("{now} thread={thread} {msg} at {loc}\n")
    } else {
        format!("{now} thread={thread} {msg} at {loc}\n{backtrace}\n")
    }
}

/// Append one panic record to ~/.agent-bus/app-panics.log. Fail-open by construction: a logging
/// error is dropped, never allowed to become a second panic inside the panic path.
pub(crate) fn append_panic_log(msg: &str, loc: &str, backtrace: &str) {
    let line = panic_log_line(
        &chrono_free_now(),
        std::thread::current().name().unwrap_or("?"),
        msg,
        loc,
        backtrace,
    );
    let path = desktop_bus_dir().join("app-panics.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

/// A panic on the main thread inside AppKit's sendEvent cannot unwind: SIGABRT, and the crash report
/// shows only the abort (#5917, #6317). This hook writes the message, location, thread and backtrace
/// BEFORE the abort. The default hook still runs after.
pub(crate) fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = panic_payload_message(info.payload());
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        append_panic_log(&msg, &loc, &backtrace);
        default_hook(info);
    }));
}

/// #6317 acceptance drill: TRANTOR_PANIC_DRILL=1 reproduces the tao crash shape, a panic unwinding
/// through a plain `extern "C" fn` boundary, headless before tauri::Builder. Proves the hook sees
/// the ORIGINAL panic as well as the compiler's "cannot unwind" one.
pub(crate) fn run_panic_drill() -> ! {
    fn panics_directly(arg: u32) -> u32 {
        if arg == std::hint::black_box(arg) {
            panic!("panic-drill: original panic message (#6317)");
        }
        arg
    }
    extern "C" fn nounwind_boundary(arg: u32) -> u32 {
        panics_directly(arg)
    }
    std::hint::black_box(nounwind_boundary(std::hint::black_box(1)));
    unreachable!("nounwind_boundary should have aborted the process");
}

/// #6317: launching via `open -a` (as the operator does) points the process's stderr at
/// `/dev/null` — the default panic hook's own crash summary, and anything AppKit itself
/// prints about the abort, has nowhere to land. Reopen fd 2 onto a real file before anything
/// can write to it. Fail-open: if the file can't be opened, stderr just stays wherever it was.
pub(crate) fn redirect_stderr_to_log() {
    let path = desktop_bus_dir().join("app-stderr.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::os::unix::io::AsRawFd;
        let fd = file.as_raw_fd();
        unsafe {
            libc::dup2(fd, libc::STDERR_FILENO);
        }
        // dup2'd fd 2 now owns the underlying file description; drop our copy of the handle.
        drop(file);
    }
}

pub fn run() {
    identity_env::scrub_launch_identity();
    if std::env::var_os("TRANTOR_ENV_SCRUB_DRILL").is_some() {
        identity_env::run_scrub_drill().unwrap();
        return;
    }
    redirect_stderr_to_log();
    install_panic_hook();
    key_drill::install_objc_exception_reporter();
    key_drill::prepare();
    if std::env::var("TRANTOR_PANIC_DRILL").is_ok() {
        run_panic_drill();
    }
    tauri::Builder::default()
        .manage(terminal::TerminalManager::default())
        .manage(HandoffChains::default())
        .manage(genesis::WakeChains::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // #6094 acceptance drill: TRANTOR_ASK_DRILL=<project> mounts Chat headlessly on that
            // project's orch pane and drives the real blocked path (src/features/chat/askDrill.ts).
            // TRANTOR_ASK_DRILL_WRITE_TARGET=<pane-id> also proves the write path against a pane the
            // operator set up, never the real orchestrator. Inert in normal runs.
            use tauri::{Emitter, Manager};
            // #6317 acceptance drill: TRANTOR_KEY_DRILL=post|throw posts a real right-arrow key
            // event through AppKit once the webview is live (src/key_drill.rs). Inert otherwise.
            key_drill::arm(app.handle());
            // #6668 acceptance drill: TRANTOR_HANDOFF_DRILL=<project> opens that project's Chat
            // on a pane holding a bare shell and proves no chain starts (src/handoff_drill.rs).
            handoff_drill::arm(app.handle());
            if let Ok(project) = std::env::var("TRANTOR_ASK_DRILL") {
                let write_target = std::env::var("TRANTOR_ASK_DRILL_WRITE_TARGET").ok();
                if let Some(window) = app.get_webview_window("main") {
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(5));
                        let payload = serde_json::json!({ "project": project, "writeTarget": write_target });
                        let _ = window.emit("ask-drill", payload.to_string());
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(|invoke: tauri::ipc::Invoke<tauri::Wry>| {
            // #5917 guard: tauri has no catch_unwind, so a panic in any command would unwind through
            // the AppKit extern "C" callback and abort. Catch: log it, drop the invoke, the app lives.
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            greet,
            sign_request,
            identity_name,
            hub_for_project,
            known_projects,
            hub_request,
            start_stream,
            doctor,
            card_code,
            open_code,
            project_icon,
            local_sessions,
            project_sessions,
            herdr_pane_read,
            herdr_seats,
            seat_diff,
            git_panel,
            git_stage,
            git_commit,
            git_push,
            project_files,
            search_files,
            read_file,
            file_stat,
            file_diff,
            read_file_at_head,
            seat_state,
            sessions::sessions_list,
            sessions::session_transcript,
            orchestrator_chat,
            balances_refresh,
            trantor_cli_compatibility,
            provider_status,
            provider_verify,
            agent_settings_status,
            agent_settings_set_enabled,
            agent_settings_set_default,
            chat_watch,
            chat_unwatch,
            file_watch,
            file_unwatch,
            ghost::ghost_complete,
            ghost::ghost_complete_stream,
            ghost::ghost_cancel,
            pane_send,
            pane_keys,
            ask_answer,
            asks::ask_watch,
            asks::ask_target,
            asks::ask_answer_session,
            asks::ask_drill_start,
            asks::ask_drill_probe,
            key_drill::key_drill_post,
            key_drill::key_drill_finish,
            handoff_drill::handoff_drill_probe,
            handoff_drill::handoff_drill_finish,
            asks::ask_drill_close,
            ask_drill_fire_status,
            orchestrator_status,
            genesis::project_dev_root,
            genesis::genesis_read_brief,
            genesis::project_new,
            genesis::project_wake,
            genesis::wake_in_progress,
            drill_mode::drill_screenshot,
            drill_mode::drill_key_post,
            drill_mode::drill_panics_since,
            handoff_now,
            handoff_in_progress,
            takeover_now,
            orch_restorables,
            dismissed_sessions_list,
            dismissed_sessions_dismiss,
            dismissed_sessions_clear,
            right_panel_get,
            right_panel_set,
            save_pasted_image,
            attachment_info,
            draft_persist,
            draft_load,
            draft_forget,
            file_write_plain,
            project_changes,
            graft_cli::code_graph,
            app_log,
            create_file,
            delete_file,
            rename_file,
            autonomy_get,
            autonomy_set,
            onboarding_get,
            onboarding_has_hub_pin,
            onboarding_set_step,
            onboarding_close,
            onboarding_reopen,
            duty_start,
            duty_stop,
            duty_log_path,
            policy_set_level,
            policy_link_projects,
            policy_unlink_projects,
            app_update_check,
            app_update_install,
            terminal::orchestrator_open,
            provider_accounts::provider_login,
            provider_accounts::provider_verify_key,
            provider_accounts::provider_save_key,
            provider_accounts::provider_remove,
            terminal::term_attach,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_detach
            ];
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || handler(invoke))) {
                Ok(handled) => handled,
                Err(payload) => {
                    // Log and report the invoke as unhandled; JS sees a rejected command instead
                    // of the process it was talking to dying mid-keystroke.
                    append_panic_log(
                        &format!("invoke handler: {}", panic_payload_message(&*payload)),
                        "desktop_lib invoke_handler guard",
                        "",
                    );
                    false
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // #5917 guard, part two: tao's run loop calls this closure on the main thread for
            // every event, and a panic here would unwind out through the same extern "C" boundary
            // and abort — so catch and log it the way the invoke guard does.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let _ = event;
            }));
            if let Err(payload) = result {
                append_panic_log(
                    &format!("RunEvent handler: {}", panic_payload_message(&*payload)),
                    "desktop_lib RunEvent guard",
                    "",
                );
            }
        });
}

#[cfg(test)]
mod panic_guard_tests {
    use super::*;

    #[test]
    fn payload_message_reads_both_string_shapes_and_survives_anything_else() {
        let borrowed: &(dyn std::any::Any + Send) = &"borrowed boom";
        assert_eq!(panic_payload_message(borrowed), "borrowed boom");
        let owned: &(dyn std::any::Any + Send) = &String::from("owned boom");
        assert_eq!(panic_payload_message(owned), "owned boom");
        let other: &(dyn std::any::Any + Send) = &7u32;
        assert_eq!(panic_payload_message(other), "non-string panic payload");
    }

    #[test]
    fn panic_log_line_carries_everything_the_ips_reports_never_had() {
        // The crash reports of #5917 showed ONLY the abort frames, so the log line must
        // name the message, the thread, the location and the backtrace.
        let line = panic_log_line("1788374793", "main", "called `Option::unwrap()` on a `None` value", "view.rs:546", "0: tao::send_event");
        assert!(line.contains("1788374793 thread=main"));
        assert!(line.contains("called `Option::unwrap()` on a `None` value"));
        assert!(line.contains("at view.rs:546"));
        assert!(line.contains("0: tao::send_event"));
        // A guard-caught panic has no backtrace to add; the line still stands alone.
        let bare = panic_log_line("1788374793", "main", "boom", "guard", "");
        assert_eq!(bare, "1788374793 thread=main boom at guard\n");
    }

    #[test]
    fn the_catch_unwind_guard_traps_a_panicking_body_and_keeps_its_message() {
        // The same pattern run() puts around the invoke and RunEvent handlers: a panic inside the
        // body is caught instead of unwinding into the extern "C" event boundary, and the payload
        // message survives for the log.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            panic!("simulated main-thread panic");
        }));
        let err = outcome.expect_err("the panicking body must be caught");
        assert_eq!(panic_payload_message(&*err), "simulated main-thread panic");
        let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| true));
        assert_eq!(ok.expect("a clean body passes through"), true);
    }
}
