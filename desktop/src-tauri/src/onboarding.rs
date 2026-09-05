// Onboarding — first-run wizard state, persisted in ~/.agent-bus/config.json under "onboarding".
//
// A fresh install has never pinned a hub, so it sees the wizard (closedAt: null). An install that
// already has real config — a hub pin from before onboarding existed — is migrated straight past
// it the first time this is read: closedAt gets set right then, so nobody already running Trantor
// is walked through a wizard for a machine they set up months ago.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const FLOW_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    pub flow_version: u32,
    pub closed_at: Option<u64>,
    pub last_completed_step: Option<String>,
}

fn config_path() -> PathBuf {
    crate::desktop_bus_dir().join("config.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A hub pin (`trantor hub set`) is the signal an install predates onboarding, or has already
/// done the "identity + hub" step by hand — either way, "already set".
pub fn has_hub_pin(config: &Value) -> bool {
    config
        .get("hubs")
        .and_then(Value::as_object)
        .map(|h| !h.is_empty())
        .unwrap_or(false)
}

fn state_from(config: &Value) -> Option<OnboardingState> {
    config
        .get("onboarding")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
}

/// The state to use for a config that has never carried an "onboarding" key. Pure so the
/// migration heuristic (pre-existing install vs brand new) is testable without touching disk.
fn migrated_state(config: &Value) -> OnboardingState {
    OnboardingState {
        flow_version: FLOW_VERSION,
        closed_at: if has_hub_pin(config) { Some(now_ms()) } else { None },
        last_completed_step: None,
    }
}

fn with_onboarding(config: &Value, state: &OnboardingState) -> Result<Value, String> {
    let mut config = config.clone();
    let obj = config
        .as_object_mut()
        .ok_or_else(|| "config.json is not an object".to_string())?;
    obj.insert(
        "onboarding".into(),
        serde_json::to_value(state).map_err(|e| e.to_string())?,
    );
    Ok(config)
}

fn read_config() -> Value {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

fn write_config(v: &Value) -> Result<(), String> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

/// Reads the onboarding state, migrating it into existence on first call.
pub fn get() -> Result<OnboardingState, String> {
    let config = read_config();
    if let Some(state) = state_from(&config) {
        return Ok(state);
    }
    let state = migrated_state(&config);
    write_config(&with_onboarding(&config, &state)?)?;
    Ok(state)
}

pub fn on_disk_has_hub_pin() -> bool {
    has_hub_pin(&read_config())
}

fn update(f: impl FnOnce(&mut OnboardingState)) -> Result<OnboardingState, String> {
    let config = read_config();
    let mut state = state_from(&config).unwrap_or_else(|| migrated_state(&config));
    f(&mut state);
    write_config(&with_onboarding(&config, &state)?)?;
    Ok(state)
}

pub fn set_step(step: String) -> Result<OnboardingState, String> {
    update(|s| s.last_completed_step = Some(step))
}

pub fn close() -> Result<OnboardingState, String> {
    update(|s| s.closed_at = Some(now_ms()))
}

/// "Show onboarding again" — resets progress but keeps flowVersion, since the flow itself has not
/// changed shape.
pub fn reopen() -> Result<OnboardingState, String> {
    update(|s| {
        s.closed_at = None;
        s.last_completed_step = None;
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_config_with_no_hub_pins_migrates_to_the_wizard_shown() {
        let config = json!({});
        let state = migrated_state(&config);
        assert_eq!(state.flow_version, FLOW_VERSION);
        assert_eq!(state.closed_at, None);
        assert_eq!(state.last_completed_step, None);
    }

    #[test]
    fn a_config_with_a_hub_pin_migrates_to_already_closed() {
        let config = json!({ "hubs": { "trantor": "http://127.0.0.1:4477" } });
        let state = migrated_state(&config);
        assert!(state.closed_at.is_some());
    }

    #[test]
    fn an_empty_hubs_object_still_counts_as_no_pin() {
        let config = json!({ "hubs": {} });
        assert!(!has_hub_pin(&config));
        assert_eq!(migrated_state(&config).closed_at, None);
    }

    #[test]
    fn state_from_reads_back_exactly_what_was_written() {
        let state = OnboardingState { flow_version: 1, closed_at: Some(42), last_completed_step: Some("providers".into()) };
        let config = with_onboarding(&json!({ "hubs": {} }), &state).unwrap();
        assert_eq!(state_from(&config), Some(state));
        // other keys survive the round trip untouched
        assert_eq!(config.get("hubs"), Some(&json!({})));
    }

    #[test]
    fn with_onboarding_refuses_a_non_object_config() {
        assert!(with_onboarding(&json!([1, 2]), &migrated_state(&json!({}))).is_err());
    }

    /// The real path end to end, against actual disk: a fresh bus dir shows the wizard, a
    /// pre-existing one (a hub pin already on disk) is migrated straight past it, and the public
    /// get/set_step/close/reopen commands round-trip through the same config.json file a real
    /// launch would use. The only test in this crate that touches AGENT_BUS_DIR — safe to run
    /// alongside the rest of the suite because nothing else reads or sets it.
    #[test]
    fn the_real_path_a_fresh_dir_then_an_existing_one() {
        let base = std::env::temp_dir().join(format!("trantor-onboarding-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // SAFETY: this is the crate's only test touching AGENT_BUS_DIR (grepped before adding
        // it), so no other test can observe or race this process-wide mutation.
        unsafe { std::env::set_var("AGENT_BUS_DIR", &base) };

        // Fresh install: no config.json at all yet.
        let fresh = get().unwrap();
        assert_eq!(fresh.closed_at, None, "a brand new machine must see the wizard");
        assert_eq!(fresh.flow_version, FLOW_VERSION);

        let after_step = set_step("providers".into()).unwrap();
        assert_eq!(after_step.last_completed_step, Some("providers".into()));
        assert_eq!(after_step.closed_at, None);

        let closed = close().unwrap();
        assert!(closed.closed_at.is_some());

        let reopened = reopen().unwrap();
        assert_eq!(reopened.closed_at, None);
        assert_eq!(reopened.last_completed_step, None);
        assert_eq!(reopened.flow_version, FLOW_VERSION, "reopen keeps the flow version");

        // Existing install: wipe just the onboarding key back out and pre-seed a hub pin, the way
        // a machine that ran `trantor hub set` months before onboarding existed would look.
        fs::write(
            base.join("config.json"),
            json!({ "hubs": { "trantor": "http://127.0.0.1:4477" } }).to_string(),
        )
        .unwrap();
        let migrated = get().unwrap();
        assert!(migrated.closed_at.is_some(), "a pre-existing hub pin must never see the wizard");

        unsafe { std::env::remove_var("AGENT_BUS_DIR") };
        let _ = fs::remove_dir_all(&base);
    }
}
