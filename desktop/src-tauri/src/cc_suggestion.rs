// Claude Code's own suggested next prompt (#11649). CC persists the live suggestion nowhere (the
// transcript records it only once accepted, promptSource "suggestion_accepted"), but the terminal
// screen carries it: the input line is `❯` + NBSP and then the suggestion rendered in SGR 2 (dim),
// where typed text is not dim. `herdr pane read <pane> --source visible --format ansi` returns that
// screen with its escapes, and `parse_suggestion` lifts the dim text off the LAST prompt line.
use std::process::Stdio;

const NBSP: char = '\u{a0}';
const PLACEHOLDER_OPENER: &str = "Try \"";

#[derive(Clone, Copy)]
struct Cell {
    ch: char,
    dim: bool,
    inverse: bool,
}

/// One screen line as visible cells carrying the SGR state they were drawn in. Only the attributes
/// that decide ghost-vs-typed are tracked; colours, bold and every other CSI/OSC are skipped.
fn cells(line: &str) -> Vec<Cell> {
    let mut out = Vec::new();
    let (mut dim, mut inverse) = (false, false);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(Cell { ch: c, dim, inverse });
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                let mut params = String::new();
                let mut fin = None;
                for p in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&p) {
                        fin = Some(p);
                        break;
                    }
                    params.push(p);
                }
                if fin == Some('m') {
                    apply_sgr(&params, &mut dim, &mut inverse);
                }
            }
            Some(']') => {
                // OSC: runs to BEL or ST (ESC \).
                chars.next();
                while let Some(p) = chars.next() {
                    if p == '\x07' {
                        break;
                    }
                    if p == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            Some(_) => { chars.next(); }
            None => {}
        }
    }
    out
}

fn apply_sgr(params: &str, dim: &mut bool, inverse: &mut bool) {
    let mut it = params.split(';').map(|p| p.parse::<u32>().unwrap_or(0)).peekable();
    if params.is_empty() {
        *dim = false;
        *inverse = false;
        return;
    }
    while let Some(p) = it.next() {
        match p {
            0 => { *dim = false; *inverse = false; }
            2 => *dim = true,
            22 => *dim = false,
            7 => *inverse = true,
            27 => *inverse = false,
            // Extended colours carry sub-parameters that must not be read as attributes:
            // 38;5;n / 48;5;n / 58;5;n, and 38;2;r;g;b and the same for 48 / 58.
            38 | 48 | 58 => match it.next() {
                Some(5) => { it.next(); }
                Some(2) => { it.next(); it.next(); it.next(); }
                _ => {}
            },
            _ => {}
        }
    }
}

fn first_visible(cells: &[Cell]) -> Option<usize> {
    cells.iter().position(|c| !c.ch.is_whitespace() && c.ch != NBSP)
}

fn is_prompt(cells: &[Cell]) -> bool {
    first_visible(cells).is_some_and(|i| cells[i].ch == '❯')
}

fn is_rule(cells: &[Cell]) -> bool {
    first_visible(cells).is_some_and(|i| matches!(cells[i].ch, '─' | '━' | '╌' | '┄'))
}

fn blank(cells: &[Cell]) -> bool {
    first_visible(cells).is_none()
}

/// The dim text of a line's cells, or None when anything visible in it is not dim. A cursor block
/// (an inverse-video space) is not text.
fn dim_text(cells: &[Cell]) -> Option<String> {
    let mut s = String::new();
    for c in cells {
        let space = c.ch.is_whitespace() || c.ch == NBSP;
        if space && c.inverse {
            continue;
        }
        if !space && !c.dim {
            return None;
        }
        s.push(if c.ch == NBSP { ' ' } else { c.ch });
    }
    Some(s.trim().to_string())
}

/// The suggestion Claude Code is showing on its LAST prompt line, or None. A suggestion is text in
/// dim right after the prompt; typed text, a mix of dim and non-dim, an empty line and the
/// first-launch `Try "…"` placeholder are all not a suggestion. A long one wraps onto the lines
/// below the prompt (up to the box's bottom rule) and is joined back into one line.
pub fn parse_suggestion(ansi: &str) -> Option<String> {
    let lines: Vec<Vec<Cell>> = ansi.split('\n').map(|l| cells(l.trim_end_matches('\r'))).collect();
    let at = lines.iter().rposition(|l| is_prompt(l))?;
    let first = &lines[at];
    let after_prompt = &first[first_visible(first)? + 1..];
    let mut text = dim_text(after_prompt)?;
    if text.is_empty() {
        return None;
    }
    for line in &lines[at + 1..] {
        if is_rule(line) || blank(line) {
            break;
        }
        let more = dim_text(line)?;
        text.push(' ');
        text.push_str(&more);
    }
    // Wrapped lines are indented to align under the text; whitespace runs collapse to one space.
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || text.starts_with(PLACEHOLDER_OPENER) {
        return None;
    }
    Some(text)
}

/// The visible screen of `pane`, escapes included. A read-only herdr CLI call; None when herdr is
/// missing or refuses (a pane that went away reads as no suggestion, never as an error).
fn read_visible(pane: &str) -> Option<String> {
    let bin = crate::local_sessions::find_herdr_binary()?;
    let out = crate::identity_env::command(bin)
        .args(["pane", "read", pane, "--source", "visible", "--format", "ansi"])
        .env("PATH", crate::hub::terminal_path())
        .stdin(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// What Claude Code is suggesting in `pane` right now, if the screen shows one.
pub fn suggestion_for(pane: &str) -> Option<String> {
    parse_suggestion(&read_visible(pane)?)
}

/// Statuses at which the input line is waiting for the operator: the only time a suggestion is
/// shown. Working, blocked and unknown never read the screen.
pub fn status_shows_suggestion(status: &str) -> bool {
    matches!(status, "idle" | "done")
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULE: &str = "\x1b[0m\x1b[38;2;136;136;136m────────────────────────────────────────\x1b[0m";

    /// The verbatim capture the card quotes: ghost text in SGR 2 right after the prompt + NBSP.
    fn screen(prompt_lines: &str) -> String {
        format!("\x1b[0m● Done. Header changes are ready.\n\n{RULE}\n{prompt_lines}\n{RULE}\n  ? for shortcuts\n")
    }

    #[test]
    fn a_ghost_suggestion_is_extracted() {
        let s = screen("❯\u{a0}\x1b[0m\x1b[2mok, ping me when the header changes are ready\x1b[0m");
        assert_eq!(parse_suggestion(&s).as_deref(), Some("ok, ping me when the header changes are ready"));
    }

    #[test]
    fn the_verbatim_capture_shape_parses() {
        let raw = "❯ \x1b[0m\x1b[2mok, ping me when the header changes are ready\x1b[0m\n\x1b[0m\x1b[38;2;136;136;136m─────────\n";
        assert_eq!(parse_suggestion(raw).as_deref(), Some("ok, ping me when the header changes are ready"));
    }

    #[test]
    fn typed_text_is_not_a_suggestion() {
        let s = screen("❯\u{a0}run the tests");
        assert_eq!(parse_suggestion(&s), None);
        let bold = screen("❯\u{a0}\x1b[1mrun the tests\x1b[0m");
        assert_eq!(parse_suggestion(&bold), None);
    }

    #[test]
    fn mixed_dim_and_typed_text_is_not_a_suggestion() {
        let s = screen("❯\u{a0}run \x1b[2mthe tests\x1b[0m");
        assert_eq!(parse_suggestion(&s), None);
        let s = screen("❯\u{a0}\x1b[2mrun the\x1b[0m tests");
        assert_eq!(parse_suggestion(&s), None);
    }

    #[test]
    fn the_first_launch_placeholder_is_not_a_suggestion() {
        let s = screen("❯\u{a0}\x1b[2mTry \"fix lint errors\"\x1b[0m");
        assert_eq!(parse_suggestion(&s), None);
    }

    #[test]
    fn an_empty_prompt_is_not_a_suggestion() {
        assert_eq!(parse_suggestion(&screen("❯\u{a0}")), None);
        assert_eq!(parse_suggestion(&screen("❯\u{a0}\x1b[0m\x1b[2m\x1b[0m")), None);
        // A cursor block on an empty line is not text either.
        assert_eq!(parse_suggestion(&screen("❯\u{a0}\x1b[7m \x1b[0m")), None);
        assert_eq!(parse_suggestion("no prompt anywhere\n"), None);
    }

    #[test]
    fn a_long_suggestion_wrapped_onto_a_second_line_is_joined() {
        let s = screen(
            "❯\u{a0}\x1b[2mkick off the migration on staging first and then compare the row\x1b[0m\n  \x1b[2mcounts before touching prod\x1b[0m",
        );
        assert_eq!(
            parse_suggestion(&s).as_deref(),
            Some("kick off the migration on staging first and then compare the row counts before touching prod"),
        );
    }

    #[test]
    fn a_wrapped_line_that_turns_out_to_be_typed_text_is_refused() {
        let s = screen("❯\u{a0}\x1b[2mkick off the migration\x1b[0m\n  and then something typed");
        assert_eq!(parse_suggestion(&s), None);
    }

    #[test]
    fn only_the_last_prompt_line_counts() {
        let s = format!(
            "❯\u{a0}\x1b[2mold ghost scrolled up\x1b[0m\n\nanswer text\n{RULE}\n❯\u{a0}\n{RULE}\n"
        );
        assert_eq!(parse_suggestion(&s), None, "the empty live prompt wins over history");
        let s = format!("❯\u{a0}typed history line\n{RULE}\n❯\u{a0}\x1b[2mship it\x1b[0m\n{RULE}\n");
        assert_eq!(parse_suggestion(&s).as_deref(), Some("ship it"));
    }

    #[test]
    fn extended_colour_parameters_are_not_read_as_dim() {
        // 38;5;2 contains a "2" that is a colour index, not SGR 2: this text is NOT dim.
        let s = screen("❯\u{a0}\x1b[38;5;2mgreen typed text\x1b[0m");
        assert_eq!(parse_suggestion(&s), None);
        // …and a combined dim + truecolour run is still dim.
        let s = screen("❯\u{a0}\x1b[2;38;2;136;136;136mgrey ghost\x1b[0m");
        assert_eq!(parse_suggestion(&s).as_deref(), Some("grey ghost"));
    }

    #[test]
    fn statuses_that_wait_for_the_operator_read_the_screen() {
        assert!(status_shows_suggestion("idle"));
        assert!(status_shows_suggestion("done"));
        assert!(!status_shows_suggestion("working"));
        assert!(!status_shows_suggestion("blocked"));
        assert!(!status_shows_suggestion("none"));
    }
}
