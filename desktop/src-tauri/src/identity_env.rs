use std::ffi::{OsStr, OsString};

/// Every name a terminal session exports to say WHO it is: the project badge, the seat, the pane
/// and the tab it sits in, the Claude session behind it. A child inheriting one becomes that
/// session (#7414: the hand-off chain reattached to the badge's project, not the clicked one).
const IDENTITY_KEYS: &[&str] = &[
    "TRANTOR_ORCH",
    "TRANTOR_SEAT",
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_SESSION_ID",
    "CLAUDE_PROJECT_DIR",
];

/// RELAY_* is the bus seat and its hub pin, CLAUDE_CODE_* the session's sockets and markers.
const IDENTITY_PREFIXES: &[&str] = &["RELAY_", "CLAUDE_CODE_"];

pub(crate) fn is_identity_key(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        return false;
    };
    IDENTITY_KEYS.contains(&key) || IDENTITY_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
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

/// The identity names the process carries right now.
fn inherited_identity() -> Vec<OsString> {
    std::env::vars_os()
        .map(|(key, _)| key)
        .filter(|key| is_identity_key(key))
        .collect()
}

/// Remove a terminal session's identity before the desktop runtime or any worker thread starts.
/// macOS `open` preserves the caller's environment, so a desktop app launched from an orchestrator
/// pane otherwise impersonates that pane in every CLI it starts.
pub(crate) fn scrub_launch_identity() {
    for key in inherited_identity() {
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

/// A pty child (the herdr attach behind every terminal pane) copies the process environment when
/// its builder is made; drop the identity names from it the way the process factories do.
pub(crate) fn scrub_pty_command(command: &mut portable_pty::CommandBuilder) {
    for key in IDENTITY_KEYS {
        command.env_remove(key);
    }
    for key in inherited_identity() {
        command.env_remove(key);
    }
}

/// Headless real-binary probe for the launch contract. It spawns a child through the same factory
/// production uses and reports only leaked identity names, never unrelated environment values.
pub(crate) fn run_scrub_drill() -> Result<(), String> {
    let process_leaks = inherited_identity();
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
            ("HERDR_WORKSPACE_ID", "w2"),
            ("HERDR_TAB_ID", "t1"),
            ("HERDR_ENV", "1"),
            ("TRANTOR_SEAT", "codex"),
            ("RELAY_PROJECT", "wrong-project"),
            ("RELAY_SESSION", "claude:wrong-project"),
            ("RELAY_AGENT", "claude"),
            ("RELAY_URL", "http://wrong.invalid"),
            ("CLAUDE_SESSION_ID", "session"),
            ("CLAUDE_PROJECT_DIR", "/wrong/project"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_PID", "2009"),
            ("CLAUDE_CODE_CHILD_SESSION", "1"),
            ("CLAUDE_CODE_FUTURE_SESSION_MARKER", "future"),
            ("CLAUDE_AGENT_TEAMS", "feature-not-identity"),
            ("TRANTOR_ROOT", "/dev/checkout"),
        ];
        let filtered = filtered_environment(
            input.map(|(key, value)| (OsString::from(key), OsString::from(value))),
        );
        let names: Vec<&OsStr> = filtered.iter().map(|(key, _)| key.as_os_str()).collect();

        assert_eq!(
            names,
            [
                OsStr::new("PATH"),
                OsStr::new("CLAUDE_AGENT_TEAMS"),
                OsStr::new("TRANTOR_ROOT")
            ]
        );
    }

    #[test]
    fn pty_children_lose_the_identity_the_process_carries() {
        std::env::set_var("HERDR_TAB_ID", "t-badge");
        std::env::set_var("RELAY_DUTY_SESSION", "duty");
        let mut builder = portable_pty::CommandBuilder::new("herdr");
        assert!(builder.get_env("HERDR_TAB_ID").is_some(), "the builder copies the process env");
        scrub_pty_command(&mut builder);
        std::env::remove_var("HERDR_TAB_ID");
        std::env::remove_var("RELAY_DUTY_SESSION");
        assert!(builder.get_env("HERDR_TAB_ID").is_none());
        assert!(builder.get_env("RELAY_DUTY_SESSION").is_none());
        assert!(builder.get_env("PATH").is_some() || std::env::var_os("PATH").is_none());
    }
}
