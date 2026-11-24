// #14030: every state and the feature range are pure functions of the table + the raw
// `--version` output, so no test needs to spawn a CLI.
use super::*;

const SPEC: &AgentCliSpec = &AGENT_CLIS[0];

fn claude() -> &'static AgentCliSpec {
    AGENT_CLIS.iter().find(|s| s.cli == "claude").expect("claude row")
}

#[test]
fn version_parse_accepts_the_claude_code_suffix_and_rejects_non_versions() {
    assert_eq!(release_version_parts("2.1.326 (Claude Code)").as_deref(), Some(&[2, 1, 326][..]));
    assert_eq!(release_version_parts("  2.1.326 (Claude Code)  ").as_deref(), Some(&[2, 1, 326][..]));
    assert_eq!(release_version_parts("2.1.326").as_deref(), Some(&[2, 1, 326][..]));
    assert_eq!(release_version_parts("v2.1.326").as_deref(), Some(&[2, 1, 326][..]));
    assert_eq!(release_version_parts("2.1").map(|p| p.len()), None);
    assert_eq!(release_version_parts("Claude Code 2.1.326").map(|p| p.len()), None);
    assert_eq!(release_version_parts("").map(|p| p.len()), None);
}

#[test]
fn the_table_only_declares_versions_that_parse() {
    for spec in AGENT_CLIS {
        assert!(release_version_parts(spec.minimum).is_some(), "{} minimum", spec.cli);
        assert!(release_version_parts(spec.verified_up_to).is_some(), "{} verified_up_to", spec.cli);
        for f in spec.features {
            assert!(release_version_parts(f.verified_from).is_some(), "{} {}", spec.cli, f.name);
            assert!(release_version_parts(f.verified_to).is_some(), "{} {}", spec.cli, f.name);
        }
    }
}

#[test]
fn each_state_classifies_against_the_rust_owned_table() {
    let below = compatibility(SPEC, Some("2.1.100 (Claude Code)"));
    assert_eq!(below.state, "below_minimum");
    assert_eq!(below.installed.as_deref(), Some("2.1.100"));
    let reason = below.reason.expect("below minimum carries a reason");
    assert!(reason.contains("Mode menu needs 2.1.326"), "{reason}");
    assert!(reason.contains("reads the mode line"), "{reason}");

    assert_eq!(compatibility(SPEC, Some("2.1.215")).state, "ok");
    assert_eq!(compatibility(SPEC, Some("2.1.326 (Claude Code)")).state, "ok");
    assert_eq!(compatibility(SPEC, Some("2.1.326 (Claude Code)")).reason, None);

    let newer = compatibility(SPEC, Some("2.1.400"));
    assert_eq!(newer.state, "newer_than_verified");
    let reason = newer.reason.expect("newer than verified carries the quiet line");
    assert!(reason.contains("newer than the newest release Trantor has verified (2.1.326)"), "{reason}");
    assert!(reason.contains("Mode menu was verified on 2.1.326..2.1.326"), "{reason}");

    assert_eq!(compatibility(SPEC, None).state, "not_installed");
    assert_eq!(compatibility(SPEC, None).installed, None);
}

#[test]
fn an_unreadable_version_never_fires_the_banner_but_shows_the_raw_output() {
    let unreadable = compatibility(SPEC, Some("something went wrong"));
    assert_eq!(unreadable.state, "not_installed");
    assert_eq!(unreadable.installed.as_deref(), Some("something went wrong"));
    let reason = unreadable.reason.expect("the raw output is named");
    assert!(reason.contains("could not be read"), "{reason}");
    assert!(unreadable.features.iter().all(|f| !f.in_range));
}

#[test]
fn a_feature_is_in_range_only_inside_its_verified_range() {
    let in_range = compatibility(SPEC, Some("2.1.326"));
    assert_eq!(in_range.features.len(), 1);
    assert!(in_range.features[0].in_range);

    // Inside the app's range but outside the feature's: the CLI reads ok, the feature says so.
    let below_feature = compatibility(SPEC, Some("2.1.220"));
    assert_eq!(below_feature.state, "ok");
    assert!(!below_feature.features[0].in_range);
    assert!(below_feature.reason.is_none());

    let above_feature = compatibility(SPEC, Some("2.1.400"));
    assert!(!above_feature.features[0].in_range);
    assert_eq!(compatibility(SPEC, None).features[0].in_range, false);
}

#[test]
fn the_update_command_is_the_verified_cli_owned_updater() {
    let report = compatibility(claude(), Some("2.1.100"));
    assert_eq!(report.update_command, Some("claude update"));
    assert_eq!(report.cli, "claude");
    assert_eq!(report.label, "Claude Code");
}
