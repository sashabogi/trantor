// Doctrine rule 6, card #6448: production code never panics on an unwrap. The deny is lifted for
// test builds, where an expect IS the assertion and a panic IS the failure report.
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

mod herdr;
mod asks;
mod dismissals;
mod drill_mode;
mod genesis;
mod graft_cli;
mod right_panel;
mod ghost;
mod handoff_drill;
mod identity_env;
mod key_drill;
mod onboarding;
mod provider_accounts;
pub mod identity;
mod sessions;
mod terminal;
mod trantor_cli;
mod hub;
mod files;
mod chat;
mod watchers;
mod panes;
mod file_ops;
mod settings;
mod icons;
mod local_sessions;
mod succession;
mod drafts;
mod git_panel;
mod update;
mod app;
mod changes;
#[allow(unused_imports)]
use hub::*;
#[allow(unused_imports)]
use files::*;
#[allow(unused_imports)]
use chat::*;
#[allow(unused_imports)]
use watchers::*;
#[allow(unused_imports)]
use panes::*;
#[allow(unused_imports)]
use file_ops::*;
#[allow(unused_imports)]
use settings::*;
#[allow(unused_imports)]
use icons::*;
#[allow(unused_imports)]
use local_sessions::*;
#[allow(unused_imports)]
use succession::*;
#[allow(unused_imports)]
use drafts::*;
#[allow(unused_imports)]
use git_panel::*;
#[allow(unused_imports)]
use update::*;
#[allow(unused_imports)]
use app::*;
/// main.rs calls this: the Tauri entry point keeps its crate-root name after the split.
pub use app::run;
#[allow(unused_imports)]
use changes::*;

use notify::Watcher;
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime};

/// A poisoned lock means another thread panicked while holding it. Every Mutex in this app guards
/// a plain registry, not an invariant a panic could have broken halfway, so the honest move is to
/// keep serving the state rather than cascade one thread's panic into every later caller (#6448).
pub(crate) fn lock_or_recover<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Doctrine rule 8: a panic inside a callback the platform drives — an FSEvents watcher closure, a
/// PTY reader loop feeding the UI — has nowhere to unwind to. On macOS it crosses an extern "C"
/// frame and aborts the whole app (#5917); in a spawned thread it kills the thread and the feature
/// it served goes quiet with nothing written down. Trap it, name the boundary in app-panics.log,
/// and let the caller decide whether to carry on.
pub(crate) fn guard_boundary<R>(boundary: &str, body: impl FnOnce() -> R) -> Option<R> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(value) => Some(value),
        Err(payload) => {
            append_panic_log(&panic_payload_message(&*payload), boundary, "");
            None
        }
    }
}

#[cfg(test)]
mod boundary_guard_tests {
    use super::*;

    #[test]
    fn a_panicking_callback_is_trapped_and_named_in_the_panic_log() {
        let _lock = local_sessions::BUS_DIR_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let prior = std::env::var("AGENT_BUS_DIR").ok();
        let dir = std::env::temp_dir().join(format!("t6448-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp bus dir");
        unsafe { std::env::set_var("AGENT_BUS_DIR", &dir) };
        let log = dir.join("app-panics.log");
        let _ = std::fs::remove_file(&log);

        assert_eq!(guard_boundary("drill", || 7), Some(7), "a clean body returns its value");

        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let trapped: Option<()> = guard_boundary("fsevents drill", || panic!("callback blew up"));
        std::panic::set_hook(hook);
        assert_eq!(trapped, None, "the panic is swallowed, not propagated");

        let written = std::fs::read_to_string(&log).expect("the guard wrote a record");
        assert!(written.contains("callback blew up"), "the message survives: {written}");
        assert!(written.contains("fsevents drill"), "the boundary is named: {written}");

        match prior {
            Some(v) => unsafe { std::env::set_var("AGENT_BUS_DIR", v) },
            None => unsafe { std::env::remove_var("AGENT_BUS_DIR") },
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
