use std::ffi::{OsStr, OsString};
use std::path::Path;

pub(crate) const MIN_VERSION: &str = "0.18.47";
const MIN_VERSION_PARTS: [u64; 3] = [0, 18, 47];

#[derive(Debug, Eq, PartialEq)]
struct Invocation {
    program: OsString,
    prefix_args: Vec<OsString>,
}

fn node_binary() -> OsString {
    [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    .iter()
    .find(|path| Path::new(path).exists())
    .map_or_else(|| OsString::from("node"), OsString::from)
}

/// Resolve the app's one Trantor CLI. Production always uses the installed `trantor` on PATH.
/// Setting TRANTOR_ROOT switches every call, including the version probe and interactive login,
/// to that checkout's dispatcher. There is no per-command fallback between the two sources.
fn resolve() -> Invocation {
    resolve_from_root(std::env::var_os("TRANTOR_ROOT"))
}

fn resolve_from_root(root: Option<OsString>) -> Invocation {
    match root {
        Some(root) => Invocation {
            program: node_binary(),
            prefix_args: vec![Path::new(&root).join("bin/cli.mjs").into_os_string()],
        },
        None => Invocation {
            program: OsString::from("trantor"),
            prefix_args: Vec::new(),
        },
    }
}

pub(crate) fn command() -> std::process::Command {
    let invocation = resolve();
    let mut command = crate::identity_env::command(invocation.program);
    command
        .args(invocation.prefix_args)
        .env("PATH", crate::terminal_path());
    command
}

pub(crate) fn async_command() -> tokio::process::Command {
    let invocation = resolve();
    let mut command = crate::identity_env::async_command(invocation.program);
    command
        .args(invocation.prefix_args)
        .env("PATH", crate::terminal_path());
    command
}

fn shell_quote(word: &OsStr) -> String {
    let word = word.to_string_lossy();
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// Command text for a Trantor invocation that must run inside an existing interactive pane.
pub(crate) fn shell_command(args: &[&str]) -> String {
    let invocation = resolve();
    std::iter::once(invocation.program.as_os_str())
        .chain(invocation.prefix_args.iter().map(OsString::as_os_str))
        .chain(args.iter().map(|arg| OsStr::new(arg)))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn release_version_parts(version: &str) -> Option<Vec<u64>> {
    let parts: Option<Vec<u64>> = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect();
    parts.filter(|parts| parts.len() >= 3)
}

pub(crate) fn version_is_compatible(installed: &str) -> bool {
    release_version_parts(installed)
        .is_some_and(|parts| parts.as_slice() >= MIN_VERSION_PARTS.as_slice())
}

fn installed_version(output: std::process::Output) -> Option<String> {
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

pub(crate) async fn version() -> Option<String> {
    installed_version(async_command().arg("--version").output().await.ok()?)
}

pub(crate) fn version_blocking() -> Option<String> {
    installed_version(command().arg("--version").output().ok()?)
}

pub(crate) fn incompatibility_reason(installed: Option<&str>) -> Option<String> {
    if installed.is_some_and(version_is_compatible) {
        return None;
    }
    Some(match installed {
        Some(version) => format!(
            "trantor CLI {version} is older than this app needs ({MIN_VERSION}); run: npm i -g trantor@{MIN_VERSION}"
        ),
        None => format!(
            "trantor CLI is unavailable; this app needs {MIN_VERSION}; run: npm i -g trantor@{MIN_VERSION}"
        ),
    })
}

pub(crate) fn require_compatible_blocking() -> Result<(), String> {
    let installed = version_blocking();
    match incompatibility_reason(installed.as_deref()) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

pub(crate) async fn require_compatible() -> Result<(), String> {
    let installed = version().await;
    match incompatibility_reason(installed.as_deref()) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolver_uses_path_unless_the_dev_override_selects_the_checkout_for_every_call() {
        let installed = resolve_from_root(None);
        assert_eq!(installed.program, OsString::from("trantor"));
        assert!(installed.prefix_args.is_empty());

        let checkout = resolve_from_root(Some(OsString::from("/tmp/dev checkout")));
        assert_ne!(checkout.program, OsString::from("trantor"));
        assert_eq!(
            checkout.prefix_args,
            vec![OsString::from("/tmp/dev checkout/bin/cli.mjs")]
        );
    }

    #[test]
    fn every_app_trantor_call_site_uses_the_shared_resolver() {
        let surfaces = [
            ("lib.rs", include_str!("lib.rs")),
            ("provider_accounts.rs", include_str!("provider_accounts.rs")),
            ("asks.rs", include_str!("asks.rs")),
            ("herdr.rs", include_str!("herdr.rs")),
            ("genesis.rs", include_str!("genesis.rs")),
            ("terminal.rs", include_str!("terminal.rs")),
        ];
        let forbidden = [
            "identity_env::command(\"trantor\")",
            "identity_env::async_command(\"trantor\")",
            "Command::new(\"trantor\")",
            "trantor provider login {provider}",
        ];
        for (name, source) in surfaces {
            for needle in forbidden {
                assert!(
                    !source.contains(needle),
                    "{name} bypasses resolver with {needle}"
                );
            }
        }
    }

    #[test]
    fn declared_minimum_rejects_the_pre_remove_cli() {
        assert_eq!(MIN_VERSION, "0.18.47");
        assert_eq!(
            release_version_parts(MIN_VERSION).as_deref(),
            Some(MIN_VERSION_PARTS.as_slice())
        );
        assert!(!version_is_compatible("0.18.46"));
        assert!(version_is_compatible("0.18.47"));
        assert!(version_is_compatible("0.19.0"));
        let Some(reason) = incompatibility_reason(Some("0.18.46")) else {
            panic!("0.18.46 must be rejected")
        };
        assert!(reason.contains("trantor CLI 0.18.46 is older"), "{reason}");
        assert!(reason.contains("npm i -g trantor@0.18.47"), "{reason}");
    }
}
