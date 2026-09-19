#[allow(unused_imports)]
use super::*;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
pub(crate) fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// The identity this app signs as. Configurable so a second machine or a test can use another key.
pub(crate) fn owner_identity() -> String {
    std::env::var("TRANTOR_IDENTITY").unwrap_or_else(|_| "sasha@mac".to_string())
}

#[tauri::command]
pub(crate) fn sign_request(
    method: String,
    path: String,
    body: Option<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    identity::sign(&owner_identity(), &method, &path, body.as_deref())
}

/// The name this app SIGNS as. The hub rejects any /send whose `from` does not match the signer,
/// so the web side has to know it rather than assume "sasha@mac" — TRANTOR_IDENTITY can change it,
/// and a hardcoded copy would 403 the moment it did.
#[tauri::command]
pub(crate) fn identity_name() -> String {
    owner_identity()
}

#[tauri::command]
pub(crate) fn hub_for_project(project: String) -> String {
    identity::hub_for_project(&project)
}

#[tauri::command]
pub(crate) fn known_projects() -> Vec<String> {
    identity::known_projects()
}

#[derive(serde::Serialize)]
pub struct HubResponse {
    pub status: u16,
    pub body: String,
}

#[tauri::command]
pub(crate) async fn hub_request(
    base: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<HubResponse, String> {
    let (status, body) = identity::request(&owner_identity(), &base, &method, &path, body).await?;
    Ok(HubResponse { status, body })
}

/// Streams already running, keyed by hub base URL: one stream per hub, fanned out over Tauri's
/// event bus, or BOARD and FEED each open their own connection and every event renders twice.
pub(crate) static STREAMS: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

#[tauri::command]
pub(crate) async fn start_stream(app: tauri::AppHandle, base: String) {
    use tauri::Emitter;
    {
        let mut g = STREAMS.lock().unwrap();
        let set = g.get_or_insert_with(std::collections::HashSet::new);
        if !set.insert(base.clone()) {
            return;
        } // already streaming this hub
    }
    tauri::async_runtime::spawn(async move {
        identity::stream(&owner_identity(), &base, move |data| {
            let _ = app.emit("hub-event", data);
        })
        .await;
    });
}

/// The PATH a terminal would have. A Finder-launched app inherits a bare PATH, so every brew/npm/
/// cargo CLI is invisible to what we spawn; the login shell's answer wins, then the usual roots.
pub(crate) fn terminal_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        for p in raw.split(':') {
            let p = p.trim();
            if !p.is_empty() && !parts.iter().any(|q| q == p) {
                parts.push(p.to_string());
            }
        }
    };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // -lic so rc files that set PATH are read. Take the LAST line: a noisy profile may print a
    // banner first, and a banner silently swallowing the PATH is exactly this bug again.
    if let Ok(out) = std::process::Command::new(&shell)
        .arg("-lic")
        .arg("printf '%s' \"$PATH\"")
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = text.lines().filter(|l| l.contains('/')).next_back() {
                push(line);
            }
        }
    }
    for p in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        &format!("{home}/.local/bin"),
        &format!("{home}/.bun/bin"),
        &format!("{home}/.cargo/bin"),
        &format!("{home}/.volta/bin"),
    ] {
        push(p);
    }
    push(&std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_string()));
    parts.join(":")
}

/// Run the installed Trantor CLI and hand back its JSON stdout. TRANTOR_ROOT deliberately changes
/// this same resolver for every app-spawned Trantor command; no command chooses its own checkout.
pub(crate) async fn run_cli_json(args: &[&str]) -> Result<String, String> {
    let mut cmd = trantor_cli::async_command();
    cmd.args(args);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("{}: {e}", args.join(" ")))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(text)
}

/// Run the EXISTING doctor engine and hand back its JSON.
#[tauri::command]
pub(crate) async fn doctor() -> Result<String, String> {
    run_cli_json(&["doctor", "--json"]).await
}

/// Bump this whenever a desktop Tauri command starts depending on a newer installed CLI surface.
/// The app probes it at launch and Accounts probes it again before using provider commands.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrantorCliCompatibility {
    pub(crate) installed: Option<String>,
    pub(crate) minimum: &'static str,
    pub(crate) compatible: bool,
    pub(crate) reason: Option<String>,
}

pub(crate) fn cli_compatibility(installed: Option<&str>) -> TrantorCliCompatibility {
    let reason = trantor_cli::incompatibility_reason(installed);
    let compatible = reason.is_none();
    let installed = installed.map(str::to_string);
    TrantorCliCompatibility {
        installed,
        minimum: trantor_cli::MIN_VERSION,
        compatible,
        reason,
    }
}

#[tauri::command]
pub(crate) async fn trantor_cli_compatibility() -> TrantorCliCompatibility {
    let installed = trantor_cli::version().await;
    cli_compatibility(installed.as_deref())
}

#[cfg(test)]
mod cli_compatibility_tests {
    use super::*;

    #[test]
    fn installed_version_is_checked_against_the_rust_owned_minimum() {
        let old = cli_compatibility(Some("0.18.46"));
        assert!(!old.compatible);
        assert_eq!(old.minimum, "0.18.47");
        let reason = old.reason.unwrap();
        assert!(reason.contains("trantor CLI 0.18.46 is older"), "{reason}");
        assert!(reason.contains("npm i -g trantor@0.18.47"), "{reason}");
        assert!(cli_compatibility(Some("0.18.47")).compatible);
        assert!(cli_compatibility(Some("0.19.0")).compatible);
    }
}

/// #6390 — the provider registry's frozen status contract (lib/providers.mjs →
/// `trantor provider status --json`): state + reason per provider, "connected" = a LIVE usage
/// call succeeded, never "file exists". The Accounts pane renders exactly this JSON; the CLI is
/// its only renderer, same rule as doctor above.
#[tauri::command]
pub(crate) async fn provider_status() -> Result<String, String> {
    trantor_cli::require_compatible().await?;
    run_cli_json(&["provider", "status", "--json"]).await
}

/// #6390 — the pre-save verify seam #6391 asked for: run the registry's own probe against a
/// CANDIDATE key and return the row, writing NOTHING anywhere. The pane can tell the operator a
/// key is live BEFORE `provider add --key` commits it to ~/.agent-bus/.env.
#[tauri::command]
pub(crate) async fn provider_verify(name: String, key: String) -> Result<String, String> {
    trantor_cli::require_compatible().await?;
    run_cli_json(&["provider", "verify", &name, "--key", &key, "--json"]).await
}

#[tauri::command]
pub(crate) async fn agent_settings_status() -> Result<String, String> {
    trantor_cli::require_compatible().await?;
    run_cli_json(&["agent-settings", "status", "--json"]).await
}

#[tauri::command]
pub(crate) async fn agent_settings_set_enabled(id: String, enabled: bool) -> Result<String, String> {
    trantor_cli::require_compatible().await?;
    run_cli_json(&[
        "agent-settings",
        "set-enabled",
        &id,
        if enabled { "true" } else { "false" },
        "--json",
    ])
    .await
}

#[tauri::command]
pub(crate) async fn agent_settings_set_default(id: Option<String>) -> Result<String, String> {
    trantor_cli::require_compatible().await?;
    run_cli_json(&[
        "agent-settings",
        "set-default",
        id.as_deref().unwrap_or("auto"),
        "--json",
    ])
    .await
}

/// Where a project's code lives on THIS machine. Convention first (~/development/<project>),
/// TRANTOR_DEV_ROOT to relocate, and a renamed checkout answers by the id it records (#6724).
/// Returns None when the repo simply isn't here — a card can reference code on another
/// operator's machine and the UI degrades to text.
pub(crate) fn project_dir(project: &str) -> Option<std::path::PathBuf> {
    identity::checkout_for(&identity::dev_root(), project)
}
