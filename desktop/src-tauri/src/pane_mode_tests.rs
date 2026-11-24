use super::*;

const DEFAULT: &str = include_str!("fixtures/pane-mode/default.txt");
const ACCEPT: &str = include_str!("fixtures/pane-mode/accept-edits.txt");
const PLAN: &str = include_str!("fixtures/pane-mode/plan.txt");
const AUTO: &str = include_str!("fixtures/pane-mode/auto.txt");
const BYPASS: &str = include_str!("fixtures/pane-mode/bypass.txt");
const PLAN_IN_BYPASS: &str = include_str!("fixtures/pane-mode/plan-in-bypass-session.txt");
const PERMISSION: &str = include_str!("fixtures/pane-mode/permission-prompt.txt");
const PLAN_APPROVAL: &str = include_str!("fixtures/pane-mode/plan-approval.txt");
const GARBAGE: &str = include_str!("fixtures/pane-mode/garbage.txt");

#[test]
fn each_captured_footer_reads_as_its_mode() {
    for (screen, mode) in [
        (DEFAULT, Mode::Default),
        (ACCEPT, Mode::AcceptEdits),
        (PLAN, Mode::Plan),
        (AUTO, Mode::Auto),
        (BYPASS, Mode::Bypass),
    ] {
        assert_eq!(parse_screen(screen), Screen { mode, prompt_showing: false }, "{}", mode.as_str());
    }
}

#[test]
fn only_the_footer_decides_never_a_transcript_line() {
    // The bypass-started session's notice names "bypass permissions"; the footer says plan.
    assert_eq!(parse_screen(PLAN_IN_BYPASS).mode, Mode::Plan);
}

#[test]
fn permission_and_plan_approval_pickers_read_as_prompts() {
    assert!(parse_screen(PERMISSION).prompt_showing);
    assert_eq!(parse_screen(PERMISSION).mode, Mode::Unknown);
    assert!(parse_screen(PLAN_APPROVAL).prompt_showing);
}

#[test]
fn garbage_and_empty_screens_are_unknown() {
    assert_eq!(parse_screen(GARBAGE), Screen { mode: Mode::Unknown, prompt_showing: false });
    assert_eq!(parse_screen("").mode, Mode::Unknown);
}

#[test]
fn mode_names_round_trip_and_strangers_are_unknown() {
    for m in [Mode::Default, Mode::AcceptEdits, Mode::Plan, Mode::Auto, Mode::Bypass] {
        assert_eq!(Mode::parse(m.as_str()), m);
    }
    assert_eq!(Mode::parse("dontAsk"), Mode::Unknown);
}

#[test]
fn only_local_pane_ids_are_accepted() {
    assert_eq!(local_pane(" w4:p1 ").as_deref(), Ok("w4:p1"));
    assert!(local_pane("wS:p4").is_ok());
    assert!(local_pane("netcup:w4:p1").is_err());
    assert!(local_pane("user@host").is_err());
    assert!(local_pane("w4:p1;rm").is_err());
}

/// A fake Claude Code pane: Shift+Tab steps through `cycle`; `prompt` pins a picker on screen.
struct FakePane {
    cycle: Vec<Mode>,
    at: usize,
    prompt: bool,
    presses: usize,
}

impl FakePane {
    fn new(cycle: &[Mode]) -> Self {
        FakePane { cycle: cycle.to_vec(), at: 0, prompt: false, presses: 0 }
    }
    fn mode(&self) -> Mode {
        self.cycle[self.at]
    }
}

impl ModePane for FakePane {
    fn read(&mut self) -> Result<Screen, String> {
        Ok(Screen { mode: self.mode(), prompt_showing: self.prompt })
    }
    fn press_shift_tab(&mut self) -> Result<(), String> {
        self.presses += 1;
        self.at = (self.at + 1) % self.cycle.len();
        Ok(())
    }
    fn pause(&mut self) {}
}

const FULL: &[Mode] = &[Mode::Default, Mode::AcceptEdits, Mode::Plan, Mode::Auto];

#[test]
fn reaches_the_target_and_reports_the_cycle_it_saw() {
    let mut pane = FakePane::new(FULL);
    let r = switch_mode(&mut pane, Mode::Plan);
    assert_eq!(r, Ok(ModeSwitch { mode: "plan", seen: vec!["default", "acceptEdits", "plan"] }));
    assert_eq!(pane.presses, 2);
    assert_eq!(pane.mode(), Mode::Plan);
}

#[test]
fn already_there_presses_nothing() {
    let mut pane = FakePane::new(FULL);
    assert!(switch_mode(&mut pane, Mode::Default).is_ok());
    assert_eq!(pane.presses, 0);
}

#[test]
fn refuses_at_a_prompt_and_presses_nothing() {
    // Shift+Tab at a plan approval APPROVES the plan: never press while a picker is up.
    let mut pane = FakePane::new(FULL);
    pane.prompt = true;
    let e = switch_mode(&mut pane, Mode::Plan).unwrap_err();
    assert!(e.contains("A prompt is waiting"), "{e}");
    assert_eq!(pane.presses, 0);
}

#[test]
fn an_absent_mode_stops_back_where_it_started_and_says_so() {
    let mut pane = FakePane::new(&[Mode::Default, Mode::AcceptEdits, Mode::Plan]);
    let e = switch_mode(&mut pane, Mode::Auto).unwrap_err();
    assert_eq!(e, "auto is not available in this session (it cycles default → acceptEdits → plan).");
    assert_eq!(pane.mode(), Mode::Default);
    assert_eq!(pane.presses, 3);
}

#[test]
fn a_cycle_too_long_for_the_budget_is_restored_to_the_start() {
    let long = [Mode::Default, Mode::AcceptEdits, Mode::Plan, Mode::AcceptEdits, Mode::Plan,
        Mode::AcceptEdits, Mode::Plan];
    // Seven steps before it wraps: the six-press budget runs out first, then it presses home.
    let mut pane = FakePane::new(&long);
    let e = switch_mode(&mut pane, Mode::Auto).unwrap_err();
    assert!(e.contains("did not come up in 6 presses") && e.contains("back in default"), "{e}");
    assert_eq!(pane.mode(), Mode::Default);
}

#[test]
fn an_unreadable_start_presses_nothing() {
    let mut pane = FakePane::new(&[Mode::Unknown, Mode::Default]);
    assert!(switch_mode(&mut pane, Mode::Default).unwrap_err().contains("Cannot read"));
    assert_eq!(pane.presses, 0);
}

#[test]
fn a_mode_that_stops_reading_back_stops_the_loop() {
    let mut pane = FakePane::new(&[Mode::Default, Mode::Unknown]);
    let e = switch_mode(&mut pane, Mode::Plan).unwrap_err();
    assert!(e.contains("did not read back"), "{e}");
    assert_eq!(pane.presses, 1);
}
