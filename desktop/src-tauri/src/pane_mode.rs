//! Claude Code's permission mode in a herdr pane (#14022). A running session changes mode only by
//! Shift+Tab, which CYCLES, so setting one is a closed loop: read the footer, press once, read back.
//! Indicator strings were captured from claude 2.1.326 in a throwaway PTY (fixtures/pane-mode).
use serde::Serialize;
use std::process::Stdio;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Default,
    AcceptEdits,
    Plan,
    Auto,
    Bypass,
    Unknown,
}

impl Mode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Mode::Default => "default",
            Mode::AcceptEdits => "acceptEdits",
            Mode::Plan => "plan",
            Mode::Auto => "auto",
            Mode::Bypass => "bypassPermissions",
            Mode::Unknown => "unknown",
        }
    }

    fn parse(s: &str) -> Mode {
        [Mode::Default, Mode::AcceptEdits, Mode::Plan, Mode::Auto, Mode::Bypass]
            .into_iter()
            .find(|m| m.as_str() == s)
            .unwrap_or(Mode::Unknown)
    }
}

/// The footer line Claude Code draws under the input box, glyph included, per mode.
const INDICATORS: &[(&str, Mode)] = &[
    ("⏸ manual mode on", Mode::Default),
    ("⏵⏵ accept edits on", Mode::AcceptEdits),
    ("⏸ plan mode on", Mode::Plan),
    ("⏵⏵ auto mode on", Mode::Auto),
    ("⏵⏵ bypass permissions on", Mode::Bypass),
];

/// Text Claude Code shows only while a permission, plan-approval or question picker waits.
const PROMPT_MARKERS: &[&str] = &[
    "Do you want to proceed?",
    "Do you want to make this edit",
    "Do you want to create",
    "Would you like to proceed?",
    "Esc to cancel",
    "Enter to select",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Screen {
    pub(crate) mode: Mode,
    pub(crate) prompt_showing: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct ModeRead {
    pub(crate) mode: &'static str,
    pub(crate) prompt_showing: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct ModeSwitch {
    pub(crate) mode: &'static str,
    /// Every mode read on the way, the start included: the cycle this session offers.
    pub(crate) seen: Vec<&'static str>,
}

fn is_rule(line: &str) -> bool {
    let t = line.trim();
    t.chars().count() >= 10 && t.chars().all(|c| c == '─')
}

/// Pure parse of a visible screen. The mode comes only from below the input box's last rule, so a
/// transcript line that names a mode never counts; no rule at all means not a Claude Code screen.
pub(crate) fn parse_screen(text: &str) -> Screen {
    let lines: Vec<&str> = text.lines().collect();
    let tail_from = lines.len().saturating_sub(30);
    let prompt_showing = lines[tail_from..].iter().any(|l| {
        PROMPT_MARKERS.iter().any(|m| l.contains(m))
    });
    let mode = match lines.iter().rposition(|l| is_rule(l)) {
        None => Mode::Unknown,
        Some(at) => lines[at + 1..]
            .iter()
            .find_map(|l| {
                let t = l.trim_start();
                INDICATORS.iter().find(|(s, _)| t.starts_with(s)).map(|(_, m)| *m)
            })
            .unwrap_or(Mode::Unknown),
    };
    Screen { mode, prompt_showing }
}

/// The pane as the switch loop sees it: injected so the loop is tested without herdr.
pub(crate) trait ModePane {
    fn read(&mut self) -> Result<Screen, String>;
    fn press_shift_tab(&mut self) -> Result<(), String>;
    fn pause(&mut self);
}

const MAX_PRESSES: usize = 6;
const SETTLE_READS: usize = 12;

/// Re-read until the mode differs from `from`, a prompt shows, or the settle budget runs out.
fn read_after_press(pane: &mut impl ModePane, from: Mode) -> Result<Screen, String> {
    let mut last = pane.read()?;
    for _ in 0..SETTLE_READS {
        if last.prompt_showing || (last.mode != from && last.mode != Mode::Unknown) {
            return Ok(last);
        }
        pane.pause();
        last = pane.read()?;
    }
    Ok(last)
}

fn names(seen: &[Mode]) -> String {
    seen.iter().map(|m| m.as_str()).collect::<Vec<_>>().join(" → ")
}

/// Press until `start` reads back again; the error says where the session was left if it cannot.
fn restore(pane: &mut impl ModePane, start: Mode, mut at: Mode) -> Result<(), String> {
    for _ in 0..MAX_PRESSES {
        if at == start {
            return Ok(());
        }
        pane.press_shift_tab()?;
        let s = read_after_press(pane, at)?;
        if s.prompt_showing || s.mode == Mode::Unknown || s.mode == at {
            break;
        }
        at = s.mode;
    }
    if at == start { Ok(()) } else { Err(format!("and could not get back to {}: the session is in {}", start.as_str(), at.as_str())) }
}

/// The closed loop: refuse at a prompt, one Shift+Tab per step, stop on anything it cannot read.
pub(crate) fn switch_mode(pane: &mut impl ModePane, target: Mode) -> Result<ModeSwitch, String> {
    if target == Mode::Unknown {
        return Err("that is not a Claude Code mode".into());
    }
    let first = pane.read()?;
    if first.prompt_showing {
        return Err("A prompt is waiting in the pane; answer it first. Nothing was pressed.".into());
    }
    if first.mode == Mode::Unknown {
        return Err("Cannot read the current mode in the pane. Nothing was pressed.".into());
    }
    let start = first.mode;
    let mut seen = vec![start];
    let mut at = start;
    for _ in 0..MAX_PRESSES {
        if at == target {
            return Ok(ModeSwitch { mode: at.as_str(), seen: seen.iter().map(|m| m.as_str()).collect() });
        }
        pane.press_shift_tab()?;
        let s = read_after_press(pane, at)?;
        if s.prompt_showing {
            return Err(format!("A prompt appeared while switching; stopped in {}.", at.as_str()));
        }
        if s.mode == Mode::Unknown || s.mode == at {
            return Err(format!("The mode did not read back after Shift+Tab; last read {}.", at.as_str()));
        }
        at = s.mode;
        if !seen.contains(&at) {
            seen.push(at);
        }
        if at == start && at != target {
            return Err(format!("{} is not available in this session (it cycles {}).", target.as_str(), names(&seen)));
        }
    }
    if at == target {
        return Ok(ModeSwitch { mode: at.as_str(), seen: seen.iter().map(|m| m.as_str()).collect() });
    }
    let back = restore(pane, start, at);
    Err(match back {
        Ok(()) => format!("{} did not come up in {MAX_PRESSES} presses (saw {}); back in {}.", target.as_str(), names(&seen), start.as_str()),
        Err(e) => format!("{} did not come up in {MAX_PRESSES} presses (saw {}) {e}.", target.as_str(), names(&seen)),
    })
}

/// A local herdr pane id ("w4:p1"). The read and key paths below are the local herdr CLI/socket.
fn local_pane(target: &str) -> Result<String, String> {
    let t = target.trim();
    let ok = t.split_once(':').is_some_and(|(w, p)| {
        w.starts_with('w') && p.starts_with('p') && w.len() > 1 && p.len() > 1
            && t.chars().all(|c| c.is_ascii_alphanumeric() || c == ':')
    });
    if ok { Ok(t.to_string()) } else { Err("Mode switching is not supported for remote panes yet.".into()) }
}

struct HerdrPane {
    pane: String,
}

impl ModePane for HerdrPane {
    fn read(&mut self) -> Result<Screen, String> {
        let bin = crate::local_sessions::find_herdr_binary().ok_or("herdr is not installed")?;
        let out = crate::identity_env::command(bin)
            .args(["pane", "read", &self.pane, "--source", "visible"])
            .env("PATH", crate::hub::terminal_path())
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("herdr pane read could not start: {e}"))?;
        if !out.status.success() {
            return Err(format!("herdr pane read failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let mut s = parse_screen(&String::from_utf8_lossy(&out.stdout));
        // herdr's own integration knows a picker is up even when the screen text is unfamiliar.
        s.prompt_showing |= crate::herdr::agent_kind_and_status(&self.pane).1.as_deref() == Some("blocked");
        Ok(s)
    }
    fn press_shift_tab(&mut self) -> Result<(), String> {
        crate::herdr::send_text(&self.pane, "\x1b[Z")
    }
    fn pause(&mut self) {
        std::thread::sleep(Duration::from_millis(120));
    }
}

fn claude_pane(target: &str) -> Result<HerdrPane, String> {
    let pane = local_pane(target)?;
    match crate::herdr::agent_kind_and_status(&pane).0.as_deref() {
        Some("claude") => Ok(HerdrPane { pane }),
        _ => Err("not a Claude Code pane".into()),
    }
}

#[tauri::command]
pub(crate) async fn pane_mode_get(target: String) -> Result<ModeRead, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = claude_pane(&target)?.read()?;
        Ok(ModeRead { mode: s.mode.as_str(), prompt_showing: s.prompt_showing })
    })
    .await
    .map_err(|e| format!("mode read task failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn pane_mode_set(target: String, mode: String) -> Result<ModeSwitch, String> {
    tauri::async_runtime::spawn_blocking(move || switch_mode(&mut claude_pane(&target)?, Mode::parse(&mode)))
        .await
        .map_err(|e| format!("mode switch task failed: {e}"))?
}

#[cfg(test)]
#[path = "pane_mode_tests.rs"]
mod tests;
