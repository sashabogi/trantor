// #14177: desktop notifications through the system's own API. The plugin's macOS path posts
// through NSUserNotificationCenter and drops the result, so a banner could silently never show.
// Here every outcome becomes one line in the app trace.
use std::path::Path;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::changes::app_trace;

const NOT_A_BUNDLE: &str = "not running from an app bundle";
const NO_ANSWER: &str = "no answer";
const PROMPT_WAIT: Duration = Duration::from_secs(120);
const SEND_WAIT: Duration = Duration::from_secs(30);

/// True when the executable sits inside a `Something.app` folder.
pub(crate) fn in_app_bundle(exe: &Path) -> bool {
    exe.components().any(|c| {
        c.as_os_str().to_str().is_some_and(|s| s.len() > 4 && s.ends_with(".app"))
    })
}

/// Maps the authorization callback's two arguments to the answer the command returns.
pub(crate) fn auth_answer(granted: bool, error: Option<&str>) -> String {
    match (granted, error) {
        (true, _) => "granted".to_string(),
        (false, Some(e)) => format!("unavailable: {e}"),
        (false, None) => "denied".to_string(),
    }
}

/// Maps the add-request callback's error to the command result.
pub(crate) fn send_result(error: Option<String>) -> Result<(), String> {
    error.map_or(Ok(()), Err)
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn permission_line(answer: &str, fallback: bool) -> String {
    let via = if fallback { " (plugin fallback)" } else { "" };
    format!("notify permission{via}: {answer}")
}

pub(crate) fn sent_line(title: &str, fallback: bool) -> String {
    let via = if fallback { " (plugin fallback)" } else { "" };
    format!("notify sent{via}: {}", one_line(title))
}

pub(crate) fn failed_line(reason: &str) -> String {
    format!("notify failed: {}", one_line(reason))
}

fn plugin_permission(app: &AppHandle) -> String {
    use tauri::plugin::PermissionState;
    let notification = app.notification();
    let state = match notification.permission_state() {
        Ok(PermissionState::Prompt | PermissionState::PromptWithRationale) => notification.request_permission(),
        other => other,
    };
    match state {
        Ok(PermissionState::Granted) => "granted".to_string(),
        Ok(_) => "denied".to_string(),
        Err(e) => format!("unavailable: {e}"),
    }
}

fn plugin_send(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notify_permission(app: AppHandle) -> String {
    let (answer, fallback) = match native_permission().await {
        Some(answer) => (answer, false),
        None => (plugin_permission(&app), true),
    };
    app_trace(&permission_line(&answer, fallback));
    answer
}

#[tauri::command]
pub async fn notify_send(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let (result, fallback) = match native_send(&title, &body).await {
        Some(result) => (result, false),
        None => (plugin_send(&app, &title, &body), cfg!(target_os = "macos")),
    };
    match &result {
        Ok(()) => app_trace(&sent_line(&title, fallback)),
        Err(reason) => app_trace(&failed_line(reason)),
    }
    result
}

/// Installs the foreground-banner delegate; call once from the app's setup (main thread).
pub(crate) fn install_delegate() {
    #[cfg(target_os = "macos")]
    mac::install_delegate();
}

#[cfg(target_os = "macos")]
async fn native_permission() -> Option<String> {
    if mac::bundle_guard().is_err() {
        return None;
    }
    let rx = match mac::begin_authorization() {
        Ok(rx) => rx,
        Err(e) => return Some(format!("unavailable: {e}")),
    };
    match tokio::time::timeout(PROMPT_WAIT, rx).await {
        Ok(Ok(answer)) => Some(answer),
        _ => Some(format!("unavailable: {NO_ANSWER}")),
    }
}

#[cfg(target_os = "macos")]
async fn native_send(title: &str, body: &str) -> Option<Result<(), String>> {
    if mac::bundle_guard().is_err() {
        return None;
    }
    let rx = match mac::begin_send(title, body) {
        Ok(rx) => rx,
        Err(e) => return Some(Err(e)),
    };
    Some(match tokio::time::timeout(SEND_WAIT, rx).await {
        Ok(Ok(error)) => send_result(error),
        _ => Err(NO_ANSWER.to_string()),
    })
}

#[cfg(not(target_os = "macos"))]
async fn native_permission() -> Option<String> {
    let _ = (PROMPT_WAIT, NO_ANSWER, NOT_A_BUNDLE);
    None
}

#[cfg(not(target_os = "macos"))]
async fn native_send(_title: &str, _body: &str) -> Option<Result<(), String>> {
    let _ = (SEND_WAIT, send_result(None));
    None
}

#[cfg(target_os = "macos")]
mod mac {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::{Mutex, OnceLock};

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tokio::sync::oneshot;

    use super::{app_trace, auth_answer, failed_line, in_app_bundle, NOT_A_BUNDLE};

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and Delegate has no Drop.
        #[unsafe(super = NSObject)]
        struct Delegate;

        // SAFETY: NSObjectProtocol has no safety requirements.
        unsafe impl NSObjectProtocol for Delegate {}

        // SAFETY: the selector and signature match the protocol method.
        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                let shown = UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound;
                if catch_unwind(AssertUnwindSafe(|| completion_handler.call((shown,)))).is_err() {
                    app_trace("notify failed: panic in the presentation callback");
                }
            }
        }
    );

    // SAFETY: the object holds no state, so every thread may use it.
    unsafe impl Send for Delegate {}
    // SAFETY: as above.
    unsafe impl Sync for Delegate {}

    impl Delegate {
        fn create() -> Retained<Self> {
            // SAFETY: NSObject's init takes no arguments and the class has no ivars.
            unsafe { msg_send![super(Self::alloc().set_ivars(())), init] }
        }
    }

    // The center holds its delegate weakly, so this owner keeps it alive for the whole process.
    static DELEGATE: OnceLock<Retained<Delegate>> = OnceLock::new();

    fn guarded<R>(f: impl FnOnce() -> R) -> Result<R, String> {
        objc2::exception::catch(AssertUnwindSafe(f))
            .map_err(|e| format!("objective-c exception: {}", e.map(|x| format!("{x:?}")).unwrap_or_default()))
    }

    /// Err when UserNotifications must not be touched (it raises outside an app bundle).
    pub(super) fn bundle_guard() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        if !in_app_bundle(&exe) {
            return Err(NOT_A_BUNDLE.to_string());
        }
        let has_id = guarded(|| NSBundle::mainBundle().bundleIdentifier().is_some())?;
        if has_id { Ok(()) } else { Err(NOT_A_BUNDLE.to_string()) }
    }

    pub(super) fn install_delegate() {
        if bundle_guard().is_err() {
            return;
        }
        let installed = guarded(|| {
            let delegate = DELEGATE.get_or_init(Delegate::create);
            let proto = ProtocolObject::from_ref(&**delegate);
            UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(proto));
        });
        if let Err(e) = installed {
            app_trace(&failed_line(&format!("delegate not installed: {e}")));
        }
    }

    fn error_text(err: *mut NSError) -> Option<String> {
        // SAFETY: the system passes either null or a live NSError for the callback's duration.
        unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string())
    }

    pub(super) fn begin_authorization() -> Result<oneshot::Receiver<String>, String> {
        guarded(|| {
            let (tx, rx) = oneshot::channel();
            let slot = Mutex::new(Some(tx));
            let block = RcBlock::new(move |granted: Bool, err: *mut NSError| {
                let outcome = catch_unwind(AssertUnwindSafe(|| {
                    let answer = auth_answer(granted.as_bool(), error_text(err).as_deref());
                    if let Some(tx) = slot.lock().ok().and_then(|mut s| s.take()) {
                        let _ = tx.send(answer);
                    }
                }));
                if outcome.is_err() {
                    app_trace("notify failed: panic in the authorization callback");
                }
            });
            let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound;
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(options, &block);
            rx
        })
    }

    pub(super) fn begin_send(title: &str, body: &str) -> Result<oneshot::Receiver<Option<String>>, String> {
        guarded(|| {
            let (tx, rx) = oneshot::channel();
            let slot = Mutex::new(Some(tx));
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(title));
            content.setBody(&NSString::from_str(body));
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            let id = NSString::from_str(&format!("trantor-{:016x}", rand::random::<u64>()));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
            let block = RcBlock::new(move |err: *mut NSError| {
                let outcome = catch_unwind(AssertUnwindSafe(|| {
                    if let Some(tx) = slot.lock().ok().and_then(|mut s| s.take()) {
                        let _ = tx.send(error_text(err));
                    }
                }));
                if outcome.is_err() {
                    app_trace("notify failed: panic in the send callback");
                }
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, Some(&block));
            rx
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn bundle_guard_accepts_an_app_path_and_rejects_a_bare_one() {
        assert!(in_app_bundle(&PathBuf::from("/Applications/Foo.app/Contents/MacOS/foo")));
        assert!(!in_app_bundle(&PathBuf::from("/repo/target/debug/desktop")));
        assert!(!in_app_bundle(&PathBuf::from("/repo/.app/x")));
    }

    #[test]
    fn authorization_results_map_to_the_returned_strings() {
        assert_eq!(auth_answer(true, None), "granted");
        assert_eq!(auth_answer(true, Some("ignored")), "granted");
        assert_eq!(auth_answer(false, None), "denied");
        assert_eq!(auth_answer(false, Some("boom")), "unavailable: boom");
    }

    #[test]
    fn a_send_error_becomes_the_err_text() {
        assert_eq!(send_result(None), Ok(()));
        assert_eq!(send_result(Some("not allowed".into())), Err("not allowed".to_string()));
    }

    #[test]
    fn trace_lines_have_one_fixed_shape() {
        assert_eq!(permission_line("granted", false), "notify permission: granted");
        assert_eq!(permission_line("denied", true), "notify permission (plugin fallback): denied");
        assert_eq!(sent_line("Verify gate opened", false), "notify sent: Verify gate opened");
        assert_eq!(sent_line("a\nb", true), "notify sent (plugin fallback): a b");
        assert_eq!(failed_line("no answer"), "notify failed: no answer");
    }
}
