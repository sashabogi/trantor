// The Code lens over ssh (#13938): a seat whose /peers machine label differs from this
// machine's has NO local worktree, so every local git/fs read shows nothing for it — worst
// case an empty "clean". This module asks the machine that owns the worktree, read-only.
#[allow(unused_imports)]
use super::*;

// ── config: machines.<label>.ssh ───────────────────────────────────────────────────────────────

/// The ssh destination for a machine label, or None when unset/non-string/blank. Pure — the
/// command and the tests share it.
pub(crate) fn machine_ssh_in(config: &serde_json::Value, machine: &str) -> Option<String> {
    let target = config
        .get("machines")?
        .get(machine)?
        .get("ssh")?
        .as_str()?
        .trim()
        .to_string();
    if target.is_empty() {
        None
    } else {
        Some(target)
    }
}

fn read_config() -> serde_json::Value {
    std::fs::read_to_string(desktop_bus_dir().join("config.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::Value::Object(Default::default()))
}

/// The frontend's probe: does this machine label have an ssh target configured at all?
#[tauri::command]
pub(crate) fn machine_ssh(machine: String) -> Option<String> {
    machine_ssh_in(&read_config(), &machine)
}

/// The validated destination every remote read goes through: present in config AND shaped like
/// one ssh argument. A miswritten target is named at rest, not discovered as a weird ssh error.
pub(crate) fn ssh_target_for(machine: &str, agent: &str) -> Result<String, String> {
    let target = machine_ssh_in(&read_config(), machine)
        .ok_or_else(|| format!("no machines.{machine}.ssh in config.json — cannot read seat/{agent} on {machine}"))?;
    if !ssh_target_ok(&target) {
        return Err(format!("machines.{machine}.ssh must be one ssh destination (e.g. \"netcup\") — port and key belong in ~/.ssh/config"));
    }
    Ok(target)
}

// ── validation: what may cross an ssh command line or a remote sh script ────────────────────────

/// A token (project, agent, machine label) safe to embed in the remote script: ascii
/// identifier-ish only. ssh joins args with spaces and hands them to a remote shell, and the
/// script body itself is sh — whitespace or metacharacters in a token are not odd names, they
/// are injection, so the character set is the allowlist, not a denylist.
pub(crate) fn is_remote_token(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('.')
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// A relative path safe inside `"$w/<path>"` in the remote script and as a git pathspec:
/// relative, no `..` component, and none of the bytes double quotes or sh give meaning to.
/// Spaces are refused too — they survive `cat "$f"` but the honest limit is one spelling for
/// every remote path use, and the error names it.
pub(crate) fn is_remote_path(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('/')
        && !s.split('/').any(|c| c == ".." || c.is_empty())
        && !s.chars().any(|c| {
            c.is_whitespace() || matches!(c, '"' | '$' | '`' | '\\' | '\'' | '\0' | '*' | '?' | '[' | '!' | ';' | '&' | '|' | '<' | '>' | '(' | ')' | '#' | '~' | '%')
        })
}

/// The ssh destination itself: non-empty, no whitespace (it is ONE argument to ssh), and it
/// must not start with '-' where an option would be read. It comes from the operator's own
/// config, so this is hygiene, not trust.
pub(crate) fn ssh_target_ok(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty() && !s.starts_with('-') && !s.chars().any(|c| c.is_whitespace())
}

// ── the ssh runner ─────────────────────────────────────────────────────────────────────────────

pub(crate) struct SshOutcome {
    pub(crate) status: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
}

/// `ssh <target> sh -s` with `script` on stdin. BatchMode so a missing key fails fast instead
/// of hanging on a prompt; ConnectTimeout so an offline machine costs six seconds, not a hang.
pub(crate) async fn ssh_script_io(target: &str, script: &str) -> Result<SshOutcome, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new("ssh")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=6")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg(target)
        .arg("sh")
        .arg("-s")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ssh could not start: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .await
            .map_err(|e| format!("ssh stdin failed: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("ssh failed: {e}"))?;
    Ok(SshOutcome {
        status: out.status.code(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

/// Transport-level failure → "unreachable", the state the drill demands never render as clean.
/// ssh exits 255 for connect/auth failures; a missing status means the process died by signal.
/// Everything else is a script-level answer and keeps its own message.
pub(crate) fn unreachable_reason(status: Option<i32>, stderr: &str) -> Option<String> {
    if status == Some(255) || status.is_none() {
        let line = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("no route");
        Some(format!("unreachable: {line}"))
    } else {
        None
    }
}

/// Run the script and normalize every failure into ONE Err string. Spawn/connect failures are
/// "unreachable: …"; script exits carry their message (exit 20 = no worktree, the script says so).
pub(crate) async fn ssh_run_script(target: &str, script: &str) -> Result<Vec<u8>, String> {
    let out = ssh_script_io(target, script).await?;
    if let Some(reason) = unreachable_reason(out.status, &out.stderr) {
        return Err(reason);
    }
    if out.status == Some(0) {
        return Ok(out.stdout);
    }
    let line = out
        .stderr
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("remote script failed");
    Err(line.to_string())
}

// ── the snapshot: one connection, every section ────────────────────────────────────────────────
// The chosen approach (#13938): everything LIVE over ssh, one connection per refresh, script
// on stdin. Local fetch was rejected: committed-only, writes into the shared checkout, blind
// to live edits. Read-only by construction — the only remote verbs are git reads and cat.

/// Section markers: `printf '\036RS<n>\n'` lines. \x1e (RS) cannot start a git porcelain,
/// numstat or log line, so a commit subject can never masquerade as a marker.
const M_BRANCH: &str = "\u{1e}RS1";
const M_UPSTREAM: &str = "\u{1e}RS2";
const M_LEFT_RIGHT: &str = "\u{1e}RS3";
const M_BASE: &str = "\u{1e}RS4";
const M_AHEAD: &str = "\u{1e}RS5";
const M_STATUS: &str = "\u{1e}RS6";
const M_NUMSTAT_HEAD: &str = "\u{1e}RS7";
const M_NUMSTAT_BASE: &str = "\u{1e}RS8";
const M_LOG: &str = "\u{1e}RS9";

/// The one script a snapshot costs. `$HOME/.agent-bus/worktrees` is the bus layout on every
/// machine — via $HOME, not /root, so it is as generic as the bus itself.
pub(crate) fn snapshot_script(project: &str, agent: &str) -> Result<String, String> {
    if !is_remote_token(project) || !is_remote_token(agent) {
        return Err("project or agent is invalid for remote read".into());
    }
    Ok(format!(
        r#"set -u
w="$HOME/.agent-bus/worktrees/{project}/{agent}"
[ -d "$w" ] || {{ echo "no worktree at $w on the remote machine" >&2; exit 20; }}
g() {{ git -C "$w" "$@"; }}
printf '{M_BRANCH}\n'; g branch --show-current || true
printf '{M_UPSTREAM}\n'; g rev-parse --abbrev-ref --symbolic-full-name '@{{u}}' || true
printf '{M_LEFT_RIGHT}\n'; g rev-list --left-right --count '@{{u}}...HEAD' || true
base=""
for b in main master origin/main origin/master; do
  x=$(g merge-base HEAD "$b" 2>/dev/null) && [ -n "$x" ] && base="$x" && break
done
printf '{M_BASE}\n'; [ -n "$base" ] && printf '%s\n' "$base" || true
printf '{M_AHEAD}\n'; [ -n "$base" ] && g rev-list --count "$base..HEAD" || true
printf '{M_STATUS}\n'; g status --porcelain=v1 || true
printf '{M_NUMSTAT_HEAD}\n'; g diff --numstat HEAD || true
printf '{M_NUMSTAT_BASE}\n'; [ -n "$base" ] && g diff --numstat "$base" || true
printf '{M_LOG}\n'; g log --max-count=15 --pretty=format:%h%x1f%an%x1f%ar%x1f%s || true
"#
    ))
}

/// Split marker-framed output into (marker, body) pairs. Lines before the first marker (a
/// login banner, remote noise) are dropped; markers we do not know are kept — the builder
/// below ignores what it does not read, and a future section costs nothing.
pub(crate) fn split_sections(raw: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in raw.lines() {
        if let Some(marker) = line.strip_prefix('\u{1e}') {
            out.push((marker.trim().to_string(), String::new()));
        } else if let Some(last) = out.last_mut() {
            if !last.1.is_empty() {
                last.1.push('\n');
            }
            last.1.push_str(line);
        }
    }
    out
}

fn section<'a>(sections: &'a [(String, String)], marker: &str) -> &'a str {
    sections
        .iter()
        .find(|(m, _)| m == marker)
        .map(|(_, b)| b.as_str())
        .unwrap_or("")
}

fn first_line(body: &str) -> String {
    body.lines().next().unwrap_or("").trim().to_string()
}

/// `git status --porcelain=v1` LINE flavour (no -z): "XY PATH", renames "XY ORIG -> PATH",
/// and paths git quotes open with '"'. The current path is what a review opens; git's quotes
/// are stripped, embedded escapes are left as git printed them — honest beats a half-unescape.
pub(crate) fn parse_porcelain_v1_lines(raw: &str) -> Vec<GitStatusEntry> {
    let mut entries = Vec::new();
    for line in raw.lines() {
        if line.len() < 4 {
            continue;
        }
        let x = line[..1].to_string();
        let y = line[1..2].to_string();
        let mut path = line[3..].to_string();
        if let Some(arrow) = path.rfind(" -> ") {
            path = path[arrow + 4..].to_string();
        }
        if path.len() >= 2 && path.starts_with('"') && path.ends_with('"') {
            path = path[1..path.len() - 1].to_string();
        }
        if path.is_empty() {
            continue;
        }
        entries.push(GitStatusEntry { path, x, y });
    }
    entries
}

/// The live answer for a seat on another machine: the local GitPanel's fields plus the
/// committed-vs-base numstat (`committed`) the changed list renders from. `counts` measures
/// uncommitted edits vs HEAD, same as the local panel; `committed` measures vs base, which
/// INCLUDES uncommitted edits — the "what did this seat do since branching" truth.
#[derive(Debug, Serialize)]
pub(crate) struct RemoteSeatSnapshot {
    pub(crate) machine: String,
    pub(crate) branch: String,
    pub(crate) upstream: Option<String>,
    pub(crate) ahead: Option<u64>,
    pub(crate) behind: Option<u64>,
    pub(crate) base: Option<String>,
    pub(crate) status: Vec<GitStatusEntry>,
    pub(crate) counts: Vec<SeatDiffFile>,
    pub(crate) committed: Vec<SeatDiffFile>,
    pub(crate) log: Vec<GitLogEntry>,
}

/// Pure: sections → snapshot. Tested against canned script output AND the output of really
/// running the script with sh against a temp repo, so the parse and the script share one truth.
pub(crate) fn snapshot_from_sections(machine: &str, sections: &[(String, String)]) -> RemoteSeatSnapshot {
    let upstream_raw = first_line(section(sections, &M_UPSTREAM[1..]));
    let upstream = if upstream_raw.is_empty() { None } else { Some(upstream_raw) };
    let (behind, ahead_upstream) = parse_left_right(section(sections, &M_LEFT_RIGHT[1..]));
    // With an upstream, ahead/behind mean the upstream. Without one, ahead counts unlanded
    // work against the merge base — the same claim the local panel makes, same words.
    let (ahead, behind) = match (&upstream, ahead_upstream) {
        (Some(_), a) => (a, behind),
        (None, _) => {
            let ahead = first_line(section(sections, &M_AHEAD[1..])).parse().ok();
            (ahead, None)
        }
    };
    let base_raw = first_line(section(sections, &M_BASE[1..]));
    RemoteSeatSnapshot {
        machine: machine.to_string(),
        branch: first_line(section(sections, &M_BRANCH[1..])),
        upstream,
        ahead,
        behind,
        base: if base_raw.is_empty() { None } else { Some(base_raw) },
        status: parse_porcelain_v1_lines(section(sections, &M_STATUS[1..])),
        counts: parse_numstat(section(sections, &M_NUMSTAT_HEAD[1..])),
        committed: parse_numstat(section(sections, &M_NUMSTAT_BASE[1..])),
        log: parse_log_pretty(section(sections, &M_LOG[1..])),
    }
}

#[tauri::command]
pub(crate) async fn remote_seat_snapshot(
    project: String,
    agent: String,
    machine: String,
) -> Result<String, String> {
    if !is_remote_token(&machine) {
        return Err("machine label is invalid".into());
    }
    let target = ssh_target_for(&machine, &agent)?;
    let script = snapshot_script(&project, &agent)?;
    let raw = ssh_run_script(&target, &script).await?;
    let text = String::from_utf8_lossy(&raw);
    let snap = snapshot_from_sections(&machine, &split_sections(&text));
    serde_json::to_string(&snap).map_err(|e| e.to_string())
}

// ── per-file reads: one file's diff vs base, and its live body ─────────────────────────────────

/// The diff for ONE changed path vs the seat's merge base — committed and uncommitted edits
/// together, the same base seat_diff diffs against locally.
pub(crate) fn patch_script(project: &str, agent: &str, path: &str) -> Result<String, String> {
    if !is_remote_token(project) || !is_remote_token(agent) {
        return Err("project or agent is invalid for remote read".into());
    }
    if !is_remote_path(path) {
        return Err(format!("path is not readable remotely: {path}"));
    }
    Ok(format!(
        r#"set -u
w="$HOME/.agent-bus/worktrees/{project}/{agent}"
[ -d "$w" ] || {{ echo "no worktree at $w on the remote machine" >&2; exit 20; }}
base=""
for b in main master origin/main origin/master; do
  x=$(git -C "$w" merge-base HEAD "$b" 2>/dev/null) && [ -n "$x" ] && base="$x" && break
done
[ -n "$base" ] || {{ echo "no merge base with main or master on the remote machine" >&2; exit 22; }}
git -C "$w" diff "$base" -- "{path}"
"#
    ))
}

#[derive(Debug, Serialize)]
pub(crate) struct RemotePatch {
    pub(crate) patch: String,
    pub(crate) truncated: bool,
}

#[tauri::command]
pub(crate) async fn remote_file_patch(
    project: String,
    agent: String,
    machine: String,
    path: String,
) -> Result<String, String> {
    if !is_remote_token(&machine) {
        return Err("machine label is invalid".into());
    }
    let target = ssh_target_for(&machine, &agent)?;
    let script = patch_script(&project, &agent, &path)?;
    let raw = ssh_run_script(&target, &script).await?;
    let (patch, truncated) = cap_patch(&raw);
    serde_json::to_string(&RemotePatch { patch, truncated }).map_err(|e| e.to_string())
}

/// The file's LIVE body from the remote worktree — read-only viewing, the card's explicit
/// scope. Exit 21 with "deleted" wording when the row's file no longer exists.
pub(crate) fn body_script(project: &str, agent: &str, path: &str) -> Result<String, String> {
    if !is_remote_token(project) || !is_remote_token(agent) {
        return Err("project or agent is invalid for remote read".into());
    }
    if !is_remote_path(path) {
        return Err(format!("path is not readable remotely: {path}"));
    }
    Ok(format!(
        r#"set -u
w="$HOME/.agent-bus/worktrees/{project}/{agent}"
f="$w/{path}"
[ -f "$f" ] || {{ echo "no such file on the remote machine: {path}" >&2; exit 21; }}
cat "$f"
"#
    ))
}

#[derive(Debug, Serialize)]
pub(crate) struct RemoteBody {
    pub(crate) text: String,
    pub(crate) truncated: bool,
    pub(crate) bytes: u64,
}

#[tauri::command]
pub(crate) async fn remote_file_body(
    project: String,
    agent: String,
    machine: String,
    path: String,
) -> Result<String, String> {
    if !is_remote_token(&machine) {
        return Err("machine label is invalid".into());
    }
    let target = ssh_target_for(&machine, &agent)?;
    let script = body_script(&project, &agent, &path)?;
    let raw = ssh_run_script(&target, &script).await?;
    // The same cap the local read_file applies (FILE_VIEW_CAP): a remote file larger than the
    // local viewer's limit is cut at the same place, and says so, rather than shipping unbounded
    // bytes over ssh into a viewer that caps anyway.
    let bytes = raw.len() as u64;
    let truncated = bytes > FILE_VIEW_CAP;
    let slice = if truncated {
        String::from_utf8_lossy(&raw[..FILE_VIEW_CAP as usize]).to_string()
    } else {
        String::from_utf8_lossy(&raw).to_string()
    };
    serde_json::to_string(&RemoteBody { text: slice, truncated, bytes }).map_err(|e| e.to_string())
}

#[cfg(test)]
mod remote_seat_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn machine_ssh_reads_the_shared_key_and_blanks_are_absent() {
        let config = json!({ "machines": { "netcup": { "ssh": " netcup " }, "bare": {} , "weird": { "ssh": "" } } });
        assert_eq!(machine_ssh_in(&config, "netcup").as_deref(), Some("netcup"));
        assert_eq!(machine_ssh_in(&config, "bare"), None);
        assert_eq!(machine_ssh_in(&config, "weird"), None);
        assert_eq!(machine_ssh_in(&config, "elsewhere"), None);
        assert_eq!(machine_ssh_in(&json!({}), "netcup"), None);
    }

    #[test]
    fn remote_tokens_allow_identifier_shapes_only() {
        assert!(is_remote_token("netcup"));
        assert!(is_remote_token("glm-5"));
        assert!(is_remote_token("MacBook-Pro-M1"));
        assert!(is_remote_token("a_b.c"));
        for bad in ["", "a b", "a;rm", "a/b", "../x", ".ssh", "-flag", "café", "a`b"] {
            assert!(!is_remote_token(bad), "{bad:?} must not pass as a remote token");
        }
    }

    #[test]
    fn remote_paths_are_relative_quoting_safe_and_traversal_free() {
        assert!(is_remote_path("src/a.ts"));
        assert!(is_remote_path("deep/dir/x_y.rs"));
        for bad in [
            "", "/abs", "a/../b", "a//b", "a b", "a\"b", "a$b", "a`b", "a\\b", "a'b", "a;b", "../x",
        ] {
            assert!(!is_remote_path(bad), "{bad:?} must not pass as a remote path");
        }
    }

    #[test]
    fn ssh_targets_are_one_argument() {
        assert!(ssh_target_ok("netcup"));
        assert!(ssh_target_ok(" root@10.0.0.4 "));
        for bad in ["", "  ", "-oProxyCommand=x", "host -p 22"] {
            assert!(!ssh_target_ok(bad), "{bad:?} must not pass as an ssh target");
        }
    }

    #[test]
    fn unreachable_is_transport_failure_only() {
        assert_eq!(
            unreachable_reason(Some(255), "ssh: connect to host netcup port 22: Operation timed out"),
            Some("unreachable: ssh: connect to host netcup port 22: Operation timed out".into())
        );
        assert_eq!(unreachable_reason(None, "killed"), Some("unreachable: killed".into()));
        assert_eq!(unreachable_reason(Some(255), "\n \nonly later"), Some("unreachable: only later".into()));
        assert_eq!(unreachable_reason(Some(20), "no worktree at x"), None, "script exits are answers, not transport");
        assert_eq!(unreachable_reason(Some(0), ""), None);
    }

    #[test]
    fn snapshot_script_refuses_bad_tokens_and_names_the_worktree() {
        assert!(snapshot_script("../x", "glm").is_err());
        assert!(snapshot_script("trantor", "a b").is_err());
        let script = snapshot_script("trantor", "glm-5").unwrap();
        assert!(script.contains("$HOME/.agent-bus/worktrees/trantor/glm-5"));
        assert!(script.contains(M_BRANCH));
        assert!(script.contains(M_LOG));
        // every git query runs against "$w" — a validated, quoted worktree
        assert!(script.contains("git -C \"$w\""));
    }

    #[test]
    fn sections_split_on_markers_and_drop_banner_noise() {
        let raw = format!("Welcome to netcup\r\n{M_BRANCH}\nseat/glm-5\n{M_STATUS}\nM  a.ts\n D b.rs\n");
        let sections = split_sections(&raw);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].0, "RS1");
        assert_eq!(sections[0].1, "seat/glm-5");
        assert_eq!(sections[1].0, "RS6");
        assert_eq!(sections[1].1, "M  a.ts\n D b.rs");
    }

    #[test]
    fn porcelain_lines_take_the_current_path_through_renames_and_quotes() {
        let rows = parse_porcelain_v1_lines(
            "M  plain.ts\n D gone.rs\nR  old/name.ts -> new/name.ts\nA  \"quoted path.ts\"\nR  \"o ld.ts\" -> \"n ew.ts\"\n?? brand-new.ts\n",
        );
        let paths: Vec<&str> = rows.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["plain.ts", "gone.rs", "new/name.ts", "quoted path.ts", "n ew.ts", "brand-new.ts"]);
        assert_eq!(rows[5].x, "?");
    }

    #[test]
    fn porcelain_lines_skip_rows_too_short_to_carry_a_path() {
        assert!(parse_porcelain_v1_lines("\nab\nabc\n").is_empty());
    }

    #[test]
    fn snapshot_parses_a_canned_full_answer() {
        let raw = format!(
            "{M_BRANCH}\nseat/kimi-9\n\
             {M_UPSTREAM}\n\n\
             {M_LEFT_RIGHT}\n\n\
             {M_BASE}\n4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
             {M_AHEAD}\n3\n\
             {M_STATUS}\nM  src/a.ts\n?? new.ts\n\
             {M_NUMSTAT_HEAD}\n2\t1\tsrc/a.ts\n\
             {M_NUMSTAT_BASE}\n7\t3\tsrc/a.ts\n1\t0\tsrc/b.ts\n\
             {M_LOG}\nabc1234\x1fAda\x1f2 hours ago\x1ffix: the thing\n"
        );
        let snap = snapshot_from_sections("netcup", &split_sections(&raw));
        assert_eq!(snap.branch, "seat/kimi-9");
        assert_eq!(snap.upstream, None);
        assert_eq!(snap.ahead, Some(3), "no upstream: ahead counts against the merge base");
        assert_eq!(snap.behind, None);
        assert_eq!(snap.base.as_deref(), Some("4b825dc642cb6eb9a060e54bf8d69288fbee4904"));
        assert_eq!(snap.status.len(), 2);
        assert_eq!(snap.status[1].path, "new.ts");
        assert_eq!(snap.counts.len(), 1);
        assert_eq!(snap.committed.len(), 2);
        assert_eq!(snap.committed[0].plus, Some(7));
        assert_eq!(snap.log.len(), 1);
        assert_eq!(snap.log[0].subject, "fix: the thing");
    }

    #[test]
    fn snapshot_with_an_upstream_reads_the_arrows_from_it() {
        let raw = format!(
            "{M_BRANCH}\nseat/glm-5\n\
             {M_UPSTREAM}\norigin/seat/glm-5\n\
             {M_LEFT_RIGHT}\n2\t5\n\
             {M_BASE}\ndeadbee\n\
             {M_AHEAD}\n99\n\
             {M_STATUS}\n\n\
             {M_NUMSTAT_HEAD}\n\n\
             {M_NUMSTAT_BASE}\n\n\
             {M_LOG}\n"
        );
        let snap = snapshot_from_sections("netcup", &split_sections(&raw));
        assert_eq!(snap.upstream.as_deref(), Some("origin/seat/glm-5"));
        assert_eq!(snap.ahead, Some(5), "rev-list left-right answers behind<TAB>ahead");
        assert_eq!(snap.behind, Some(2));
    }

    /// The script's own semantics, proven by really running it: `sh -s` against a temp HOME
    /// holding a real git worktree at the bus layout. This is the ssh leg minus the network —
    /// everything the script promises, split_sections and snapshot_from_sections must keep.
    #[test]
    fn the_real_script_answers_for_a_real_worktree() {
        let home = std::env::temp_dir().join(format!("trantor-remote-seat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let seat = home.join(".agent-bus").join("worktrees").join("trantor").join("glm-5");
        std::fs::create_dir_all(&seat).unwrap();

        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&seat)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .expect("git runs");
            assert!(
                out.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
        // the seat's work happens on its OWN branch, the way a real seat workstree does
        git(&["checkout", "-q", "-b", "seat/glm-5"]);
        std::fs::write(seat.join("a.ts"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(seat.join("brand-new.ts"), "new\n").unwrap();
        git(&["add", "."]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "land a"]);
        std::fs::write(seat.join("a.ts"), "one\nTWO!\nthree\nfour\n").unwrap();
        std::fs::write(seat.join("uncommitted.ts"), "draft\n").unwrap();

        let script = snapshot_script("trantor", "glm-5").unwrap();
        let out = std::process::Command::new("sh")
            .arg("-s")
            .env("HOME", &home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
                child.wait_with_output()
            })
            .expect("sh -s runs the snapshot script");
        assert!(
            out.status.success(),
            "snapshot script failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        let snap = snapshot_from_sections("netcup", &split_sections(&String::from_utf8_lossy(&out.stdout)));
        assert_eq!(snap.branch, "seat/glm-5");
        assert!(snap.base.is_some(), "the seat branched from main, so a base exists");
        assert_eq!(snap.ahead, Some(1), "'land a' is the one commit main has not landed");
        let uncommitted: Vec<&str> = snap.status.iter().map(|e| e.path.as_str()).collect();
        assert!(uncommitted.contains(&"a.ts") && uncommitted.contains(&"uncommitted.ts"));
        // vs base, a.ts is 4 new lines (never existed on main); brand-new.ts is committed too
        assert_eq!(snap.committed.iter().find(|f| f.path == "a.ts").unwrap().plus, Some(4));
        assert!(snap.committed.iter().any(|f| f.path == "brand-new.ts"));
        assert_eq!(snap.log[0].subject, "land a");

        let _ = std::fs::remove_dir_all(&home);
    }

    /// The no-worktree leg: same real sh, HOME pointed at an empty dir — the script must exit
    /// 20 with the path in its message, the state ssh_run_script surfaces verbatim.
    #[test]
    fn the_real_script_names_a_missing_worktree() {
        let home = std::env::temp_dir().join(format!("trantor-remote-seat-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let script = snapshot_script("trantor", "nope").unwrap();
        let out = std::process::Command::new("sh")
            .arg("-s")
            .env("HOME", &home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
                child.wait_with_output()
            })
            .expect("sh -s runs");
        assert_eq!(out.status.code(), Some(20));
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("no worktree at"), "the error names what is missing: {err}");
        assert!(err.contains("trantor/nope"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn patch_and_body_scripts_refuse_unsafe_paths_and_quote_the_rest() {
        assert!(patch_script("trantor", "glm-5", "../x").is_err());
        assert!(patch_script("trantor", "glm-5", "a b").is_err());
        assert!(body_script("trantor", "glm-5", "$HOME").is_err());
        let patch = patch_script("trantor", "glm-5", "src/a.ts").unwrap();
        assert!(patch.contains("diff \"$base\" -- \"src/a.ts\""));
        let body = body_script("trantor", "glm-5", "src/a.ts").unwrap();
        assert!(body.contains("cat \"$f\""));
        assert!(body.contains("f=\"$w/src/a.ts\""));
    }
}
