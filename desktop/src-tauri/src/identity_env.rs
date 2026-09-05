use std::ffi::{OsStr, OsString};

const IDENTITY_KEYS: &[&str] = &[
    "TRANTOR_ORCH",
    "HERDR_PANE_ID",
    "HERDR_ENV",
    "TRANTOR_SEAT",
    "RELAY_PROJECT",
    "RELAY_SESSION",
    "RELAY_AGENT",
    "CLAUDE_SESSION_ID",
    "CLAUDE_PROJECT_DIR",
    "CLAUDECODE",
];

fn is_identity_key(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        return false;
    };
    IDENTITY_KEYS.contains(&key) || key.starts_with("CLAUDE_CODE_")
}

fn filtered_environment(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    environment
        .into_iter()
        .filter(|(key, _)| !is_identity_key(key))
        .collect()
}

fn child_environment() -> Vec<(OsString, OsString)> {
    filtered_environment(std::env::vars_os())
}

/// Remove a terminal session's identity before the desktop runtime or any worker thread starts.
/// macOS `open` preserves the caller's environment, so a desktop app launched from an orchestrator
/// pane otherwise impersonates that pane in every CLI it starts.
pub(crate) fn scrub_launch_identity() {
    let inherited: Vec<OsString> = std::env::vars_os()
        .map(|(key, _)| key)
        .filter(|key| is_identity_key(key))
        .collect();
    for key in inherited {
        std::env::remove_var(key);
    }
}

/// Build every synchronous child from the scrubbed environment, even if a caller later restores a
/// session variable in the long-lived app process.
pub(crate) fn command(program: impl AsRef<OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command.env_clear().envs(child_environment());
    command
}

/// Async twin of [`command`]. Both factories share the same filter so trantor and herdr never see
/// a different identity depending on which command path invoked them.
pub(crate) fn async_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command.env_clear().envs(child_environment());
    command
}

/// Headless real-binary probe for the launch contract. It spawns a child through the same factory
/// production uses and reports only leaked identity names, never unrelated environment values.
pub(crate) fn run_scrub_drill() -> Result<(), String> {
    let process_leaks: Vec<OsString> = std::env::vars_os()
        .map(|(key, _)| key)
        .filter(|key| is_identity_key(key))
        .collect();
    if !process_leaks.is_empty() {
        let names: Vec<String> = process_leaks
            .iter()
            .map(|key| key.to_string_lossy().into_owned())
            .collect();
        return Err(format!(
            "desktop process retained identity environment: {}",
            names.join(", ")
        ));
    }
    let output = command("/usr/bin/env")
        .output()
        .map_err(|error| format!("env scrub drill could not spawn its child: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let leaks: Vec<&str> = stdout
        .lines()
        .filter_map(|line| line.split_once('=').map(|(key, _)| key))
        .filter(|key| is_identity_key(OsStr::new(key)))
        .collect();
    if leaks.is_empty() {
        println!("IDENTITY_ENV_CLEAN");
        Ok(())
    } else {
        Err(format!("identity environment leaked: {}", leaks.join(", ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_environment_drops_exact_and_prefixed_session_identity() {
        let input = [
            ("PATH", "/fixture/bin"),
            ("TRANTOR_ORCH", "wrong-project"),
            ("HERDR_PANE_ID", "w2:p8"),
            ("HERDR_ENV", "1"),
            ("TRANTOR_SEAT", "codex"),
            ("RELAY_PROJECT", "wrong-project"),
            ("RELAY_SESSION", "claude:wrong-project"),
            ("RELAY_AGENT", "claude"),
            ("CLAUDE_SESSION_ID", "session"),
            ("CLAUDE_PROJECT_DIR", "/wrong/project"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_CHILD_SESSION", "1"),
            ("CLAUDE_CODE_FUTURE_SESSION_MARKER", "future"),
            ("CLAUDE_AGENT_TEAMS", "feature-not-identity"),
        ];
        let filtered = filtered_environment(
            input.map(|(key, value)| (OsString::from(key), OsString::from(value))),
        );
        let names: Vec<&OsStr> = filtered.iter().map(|(key, _)| key.as_os_str()).collect();

        assert_eq!(
            names,
            [OsStr::new("PATH"), OsStr::new("CLAUDE_AGENT_TEAMS")]
        );
    }
}
