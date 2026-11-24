//! Agent CLI compatibility (#14030): one Rust-owned row per agent CLI — minimum, verified up to,
//! and per feature the verified range plus one line of why. Claude Code first; more CLIs join as
//! rows. Below the minimum is one banner; newer than verified is a quiet line; fine is nothing.

use serde::Serialize;

pub(crate) struct FeatureSpec {
    pub(crate) name: &'static str,
    pub(crate) verified_from: &'static str,
    pub(crate) verified_to: &'static str,
    pub(crate) why: &'static str,
}

pub(crate) struct AgentCliSpec {
    /// The binary name as it is probed (`claude --version`).
    pub(crate) cli: &'static str,
    /// The human name the shell and About page print.
    pub(crate) label: &'static str,
    pub(crate) minimum: &'static str,
    pub(crate) verified_up_to: &'static str,
    /// The CLI's own updater, verified from its help text (`claude update`: check for updates and
    /// install if available; package-manager installs update through the package manager). None
    /// means the command could not be confirmed for an install method — the UI then says "update
    /// it the way you installed it" instead of guessing.
    pub(crate) update_command: Option<&'static str>,
    pub(crate) features: &'static [FeatureSpec],
}

/// The table. Versions are Rust-owned data: 2.1.215 is the last hand audit, 2.1.326 the newest
/// release the Mode menu was verified on (#14022 reads the mode line under the input box).
pub(crate) const AGENT_CLIS: &[AgentCliSpec] = &[AgentCliSpec {
    cli: "claude",
    label: "Claude Code",
    minimum: "2.1.215",
    verified_up_to: "2.1.326",
    update_command: Some("claude update"),
    features: &[FeatureSpec {
        name: "Mode menu",
        verified_from: "2.1.326",
        verified_to: "2.1.326",
        why: "reads the mode line Claude Code prints under its input box",
    }],
}];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum State {
    NotInstalled,
    BelowMinimum,
    NewerThanVerified,
    Ok,
}

impl State {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            State::NotInstalled => "not_installed",
            State::BelowMinimum => "below_minimum",
            State::NewerThanVerified => "newer_than_verified",
            State::Ok => "ok",
        }
    }
}

/// `claude --version` prints "2.1.326 (Claude Code)": take the first word, tolerate a leading v.
/// A string without three numeric parts does not parse, so it can never pass as a version.
pub(crate) fn release_version_parts(version: &str) -> Option<Vec<u64>> {
    let core = version.trim().split_whitespace().next()?;
    let core = core.trim_start_matches('v');
    let parts: Option<Vec<u64>> = core.split('.').map(|part| part.parse::<u64>().ok()).collect();
    parts.filter(|parts| parts.len() >= 3)
}

fn feature_in_range(spec: &FeatureSpec, installed: Option<&[u64]>) -> bool {
    match (release_version_parts(spec.verified_from), release_version_parts(spec.verified_to), installed) {
        (Some(from), Some(to), Some(parts)) => parts >= from.as_slice() && parts <= to.as_slice(),
        _ => false,
    }
}

/// The CLI-level state. An unreadable version output reads as not installed: no banner can fire
/// on text the app cannot interpret, and every feature shows its honest unavailable state.
pub(crate) fn state_of(spec: &AgentCliSpec, raw_installed: Option<&str>) -> (State, Option<Vec<u64>>) {
    let Some(raw) = raw_installed else { return (State::NotInstalled, None) };
    let Some(parts) = release_version_parts(raw) else { return (State::NotInstalled, None) };
    let (Some(minimum), Some(verified)) = (release_version_parts(spec.minimum), release_version_parts(spec.verified_up_to))
    else { return (State::NotInstalled, None) };
    let state = if parts.as_slice() < minimum.as_slice() {
        State::BelowMinimum
    } else if parts.as_slice() > verified.as_slice() {
        State::NewerThanVerified
    } else {
        State::Ok
    };
    (state, Some(parts))
}

/// One sentence naming the feature that needs it. Below the minimum the reason backs the banner;
/// above the verified range it is the quiet line in About and doctor — never a warning.
fn reason(spec: &AgentCliSpec, state: State, raw_installed: Option<&str>, installed: Option<&[u64]>) -> Option<String> {
    let out_of_range: Vec<&FeatureSpec> = spec
        .features
        .iter()
        .filter(|f| !feature_in_range(f, installed))
        .collect();
    match state {
        State::BelowMinimum => Some(if out_of_range.is_empty() {
            format!("Trantor has audited {} only down to {}", spec.label, spec.minimum)
        } else {
            let needs = out_of_range
                .iter()
                .map(|f| format!("{} needs {} ({})", f.name, f.verified_from, f.why))
                .collect::<Vec<_>>()
                .join("; ");
            format!("the {needs}")
        }),
        State::NewerThanVerified => {
            let verified = out_of_range
                .iter()
                .map(|f| format!("{} was verified on {}..{}", f.name, f.verified_from, f.verified_to))
                .collect::<Vec<_>>()
                .join("; ");
            Some(match verified.is_empty() {
                true => format!("newer than the newest release Trantor has verified ({})", spec.verified_up_to),
                false => format!("newer than the newest release Trantor has verified ({}); {verified}", spec.verified_up_to),
            })
        }
        State::NotInstalled => raw_installed.map(|raw| format!("its version output could not be read: {raw}")),
        State::Ok => None,
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeatureCompat {
    pub(crate) name: &'static str,
    pub(crate) verified_from: &'static str,
    pub(crate) verified_to: &'static str,
    pub(crate) why: &'static str,
    pub(crate) in_range: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCliCompatibility {
    pub(crate) cli: &'static str,
    pub(crate) label: &'static str,
    /// The version as parsed from `--version`, or the raw output when it does not parse.
    pub(crate) installed: Option<String>,
    pub(crate) state: &'static str,
    pub(crate) minimum: &'static str,
    pub(crate) verified_up_to: &'static str,
    pub(crate) reason: Option<String>,
    pub(crate) update_command: Option<&'static str>,
    pub(crate) features: Vec<FeatureCompat>,
}

/// The pure half of the check, so every state is testable without spawning a CLI.
pub(crate) fn compatibility(spec: &AgentCliSpec, raw_installed: Option<&str>) -> AgentCliCompatibility {
    let (state, parts) = state_of(spec, raw_installed);
    let installed = match (raw_installed, &parts) {
        (Some(raw), Some(parts)) => Some(parts.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(".")),
        (Some(raw), None) => Some(raw.to_string()),
        (None, _) => None,
    };
    AgentCliCompatibility {
        cli: spec.cli,
        label: spec.label,
        installed,
        state: state.as_str(),
        minimum: spec.minimum,
        verified_up_to: spec.verified_up_to,
        reason: reason(spec, state, raw_installed, parts.as_deref()),
        update_command: spec.update_command,
        features: spec
            .features
            .iter()
            .map(|f| FeatureCompat {
                name: f.name,
                verified_from: f.verified_from,
                verified_to: f.verified_to,
                why: f.why,
                in_range: feature_in_range(f, parts.as_deref()),
            })
            .collect(),
    }
}

/// `claude --version` through the same scrubbed environment and terminal PATH the app's other
/// CLI spawns use, so a Finder-launched app still finds the binary.
async fn installed_version(cli: &str) -> Option<String> {
    let out = crate::identity_env::async_command(cli)
        .arg("--version")
        .env("PATH", crate::hub::terminal_path())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Per-CLI compatibility for the shell banner, the About list and the feature gates.
#[tauri::command]
pub(crate) async fn agent_cli_compatibility() -> Vec<AgentCliCompatibility> {
    let mut out = Vec::new();
    for spec in AGENT_CLIS {
        let raw = installed_version(spec.cli).await;
        out.push(compatibility(spec, raw.as_deref()));
    }
    out
}

#[cfg(test)]
#[path = "agent_cli_tests.rs"]
mod tests;
