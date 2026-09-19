#[allow(unused_imports)]
use super::*;

/// Parse `lsof -Fn` field output (p<pid> / fcwd / n<path>) into cwd paths.
pub(crate) fn lsof_cwds(out: &str) -> Vec<String> {
    out.lines()
        .filter(|l| l.starts_with('n'))
        .map(|l| l[1..].to_string())
        .collect()
}

/// A cwd is a project when it sits DIRECTLY under the dev root (or IS a project dir): the project
/// is the first path component after the root, so a session deep in a monorepo still maps to it.
pub(crate) fn project_of_cwd(cwd: &str, root: &str) -> Option<String> {
    let rel = cwd.strip_prefix(root)?.trim_start_matches('/');
    let first = rel.split('/').next()?.trim();
    if first.is_empty() || first.starts_with('.') {
        return None;
    }
    // The directory name is a label once the checkout records its id (#6724): a session whose
    // directory was renamed still lights the project the list shows.
    Some(identity::project_id_of(&Path::new(root).join(first)).unwrap_or_else(|| first.to_string()))
}

/// A project a session is open for, plus herdr's lifecycle status when one was resolved from the
/// orch pane ("working" | "idle" | "blocked" | "done" | "unknown"). `None` means this project's
/// presence is process-truth only (no herdr pane answered) — the UI shows a plain open dot rather
/// than a status word.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct LocalSessionRow {
    project: String,
    status: Option<String>,
}

/// Every project with an orch row in `crew-windows.txt`, mapped to its pane id. Last row wins per
/// project (same rule as `orch_pane_from_rows`, which reads the SAME file for the one-project
/// case) — a project can only ever have one live orch pane at a time.
pub(crate) fn orch_projects_from_rows(raw: &str) -> Vec<(String, String)> {
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for l in raw.lines() {
        let f: Vec<&str> = l.split('\t').collect();
        if f.len() >= 4 && f[1] == "orch" && !f[3].trim().is_empty() {
            map.insert(f[0].to_string(), f[3].trim().to_string());
        }
    }
    map.into_iter().collect()
}

/// Pure merge, unit-tested: PROCESS-truth projects (no status) plus herdr-confirmed projects
/// (status is whatever herdr's `agent.get` answered). herdr's status wins when a project has
/// both, since it actually knows idle from mid-turn; a project process truth never saw at all
/// still counts as open on herdr's word alone — that's the #6163 fix.
pub(crate) fn merge_local_sessions(
    process_projects: Vec<String>,
    herdr_open: Vec<(String, String)>,
) -> Vec<LocalSessionRow> {
    let mut map: BTreeMap<String, Option<String>> = BTreeMap::new();
    for p in process_projects {
        map.entry(p).or_insert(None);
    }
    for (p, status) in herdr_open {
        map.insert(p, Some(status));
    }
    map.into_iter()
        .map(|(project, status)| LocalSessionRow { project, status })
        .collect()
}

/// Projects with a live session: interactive `claude` windows and crew-runner seats on THIS
/// machine (process truth) plus any project whose orch pane herdr can still name an agent for.
#[tauri::command]
pub(crate) fn local_sessions() -> Vec<LocalSessionRow> {
    let root = std::env::var("TRANTOR_DEV_ROOT")
        .unwrap_or_else(|_| format!("{}/development", std::env::var("HOME").unwrap_or_default()));
    let sh = |bin: &str, args: &[&str]| -> String {
        std::process::Command::new(bin)
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    };
    let mut out: Vec<String> = Vec::new();

    // interactive claude windows
    let pids: Vec<String> = sh("/usr/bin/pgrep", &["-x", "claude"])
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if !pids.is_empty() {
        let list = pids.join(",");
        for cwd in lsof_cwds(&sh(
            "/usr/sbin/lsof",
            &["-a", "-d", "cwd", "-p", &list, "-Fn"],
        )) {
            if let Some(p) = project_of_cwd(&cwd, &root) {
                out.push(p);
            }
        }
    }

    // crew seats: `node …/crew-runner.mjs <agent> <projectDir>`
    for line in sh("/usr/bin/pgrep", &["-fl", "crew-runner.mjs"]).lines() {
        if let Some(dir) = line.split_whitespace().last() {
            if let Some(name) = std::path::Path::new(dir)
                .file_name()
                .and_then(|n| n.to_str())
            {
                if !name.is_empty() && !name.starts_with('.') {
                    out.push(name.to_string());
                }
            }
        }
    }

    out.sort();
    out.dedup();

    // herdr truth: every orch pane herdr can still resolve an agent for, regardless of where the
    // pane's process actually lives.
    let rows = std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let mut herdr_open: Vec<(String, String)> = Vec::new();
    for (project, pane) in orch_projects_from_rows(&rows) {
        if let Some(status) = herdr::agent_status(&pane) {
            herdr_open.push((project, status));
        }
    }

    merge_local_sessions(out, herdr_open)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TranscriptCandidate {
    session_id: String,
    active_ago_sec: u64,
    transcript: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ProjectSessionRow {
    kind: String,
    pid: Option<u32>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    state: Option<String>,
    #[serde(rename = "activeAgoSec")]
    active_ago_sec: Option<u64>,
    transcript: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ProjectSessionsPayload {
    sessions: Vec<ProjectSessionRow>,
}

pub(crate) fn orch_session_id_from_rows(raw: &str, project: &str) -> Option<String> {
    raw.lines()
        .filter_map(|line| {
            let mut it = line.split('\t');
            if it.next()?.trim() != project {
                return None;
            }
            let sid = it.next()?.trim();
            if sid.is_empty() {
                None
            } else {
                Some(sid.to_string())
            }
        })
        .next_back()
}

pub(crate) fn pane_state_from_agent_list(raw: &str, pane: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    for a in v
        .get("result")
        .and_then(|r| r.get("agents"))
        .and_then(|a| a.as_array())?
    {
        if a.get("pane_id").and_then(|p| p.as_str()) == Some(pane) {
            return Some(
                a.get("agent_status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
            );
        }
    }
    None
}

pub(crate) fn parse_lsof_pid_cwds(raw: &str) -> Vec<(u32, String)> {
    let mut pid: Option<u32> = None;
    let mut out = Vec::new();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.trim().parse::<u32>().ok();
        } else if let (Some(rest), Some(current_pid)) = (line.strip_prefix('n'), pid) {
            out.push((current_pid, rest.to_string()));
        }
    }
    out
}

pub(crate) fn parse_crew_runner_pids(raw: &str, project: &str) -> Vec<u32> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next().and_then(|p| p.parse::<u32>().ok()) else {
            continue;
        };
        let Some(dir) = line.split_whitespace().last() else {
            continue;
        };
        if std::path::Path::new(dir)
            .file_name()
            .and_then(|n| n.to_str())
            == Some(project)
        {
            out.push(pid);
        }
    }
    out.sort();
    out.dedup();
    out
}

pub(crate) fn transcript_dir_for_project_dir(dir: &Path) -> PathBuf {
    let slug: String = dir
        .to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join(".claude/projects").join(slug)
}

pub(crate) fn recent_transcript_candidates(dir: &Path) -> Vec<TranscriptCandidate> {
    const RECENT: Duration = Duration::from_secs(60 * 60);
    let tdir = transcript_dir_for_project_dir(dir);
    let now = SystemTime::now();
    let Ok(entries) = std::fs::read_dir(&tdir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        let Ok(age) = now.duration_since(mtime) else {
            continue;
        };
        if age > RECENT {
            continue;
        }
        let Some(session_id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
        else {
            continue;
        };
        out.push(TranscriptCandidate {
            session_id,
            active_ago_sec: age.as_secs(),
            transcript: path.to_string_lossy().to_string(),
        });
    }
    out.sort_by(|a, b| a.active_ago_sec.cmp(&b.active_ago_sec));
    out
}

pub(crate) fn project_sessions_json(
    project: &str,
    crew_rows: &str,
    orch_rows: &str,
    agent_list: &str,
    pane_process_info: Option<&str>,
    terminal_pids: Vec<u32>,
    transcripts: Vec<TranscriptCandidate>,
    seat_pids: Vec<u32>,
) -> String {
    let pane = orch_pane_from_rows(crew_rows, project);
    let pane_pid = pane_process_info.and_then(foreground_pid_from_process_info);
    let mut sessions = Vec::new();

    if let Some(pane_id) = pane {
        sessions.push(ProjectSessionRow {
            kind: "pane".into(),
            pid: pane_pid,
            session_id: orch_session_id_from_rows(orch_rows, project),
            state: pane_state_from_agent_list(agent_list, &pane_id)
                .or_else(|| Some("unknown".into())),
            active_ago_sec: None,
            transcript: None,
        });
    }

    let mut terminal_pids: Vec<u32> = terminal_pids
        .into_iter()
        .filter(|pid| Some(*pid) != pane_pid)
        .collect();
    terminal_pids.sort();
    terminal_pids.dedup();
    if terminal_pids.is_empty() {
        // A recent JSONL proves a conversation exists on disk, not that a Terminal session is
        // running now. Visibility/takeover V1 is process truth first, so disk-only transcripts do
        // not become terminal rows.
    } else if transcripts.is_empty() {
        for pid in terminal_pids {
            sessions.push(ProjectSessionRow {
                kind: "terminal".into(),
                pid: Some(pid),
                session_id: None,
                state: None,
                active_ago_sec: None,
                transcript: None,
            });
        }
    } else {
        for (idx, c) in transcripts.into_iter().enumerate() {
            sessions.push(ProjectSessionRow {
                kind: "terminal".into(),
                pid: terminal_pids
                    .get(idx)
                    .copied()
                    .or_else(|| terminal_pids.first().copied()),
                session_id: Some(c.session_id),
                state: None,
                active_ago_sec: Some(c.active_ago_sec),
                transcript: Some(c.transcript),
            });
        }
    }

    for pid in seat_pids {
        sessions.push(ProjectSessionRow {
            kind: "seat".into(),
            pid: Some(pid),
            session_id: None,
            state: None,
            active_ago_sec: None,
            transcript: None,
        });
    }

    serde_json::to_string(&ProjectSessionsPayload { sessions })
        .unwrap_or_else(|_| "{\"sessions\":[]}".into())
}

pub(crate) fn shell_stdout(bin: &str, args: &[&str]) -> String {
    identity_env::command(bin)
        .args(args)
        .env("PATH", terminal_path())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn project_sessions(project: String) -> String {
    let project = project.trim().to_string();
    if project.is_empty() || project.contains('/') || project.contains("..") {
        return "{\"sessions\":[]}".into();
    }

    let crew_rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let orch_rows =
        std::fs::read_to_string(desktop_bus_dir().join("orch-sessions.txt")).unwrap_or_default();
    let pane = orch_pane_from_rows(&crew_rows, &project);
    let agent_list = pane
        .as_ref()
        .map(|_| shell_stdout("herdr", &["agent", "list"]))
        .unwrap_or_default();
    let pane_process_info = pane.as_ref().and_then(|pane_id| {
        let raw = shell_stdout("herdr", &["pane", "process-info", "--pane", pane_id]);
        if raw.trim().is_empty() {
            None
        } else {
            Some(raw)
        }
    });

    let dir = project_dir(&project);
    let (terminal_pids, transcripts) = if let Some(dir) = dir.as_ref() {
        let wanted = dir.to_string_lossy().to_string();
        let pids: Vec<String> = shell_stdout("/usr/bin/pgrep", &["-x", "claude"])
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        let terminal_pids = if pids.is_empty() {
            Vec::new()
        } else {
            let list = pids.join(",");
            parse_lsof_pid_cwds(&shell_stdout(
                "/usr/sbin/lsof",
                &["-a", "-d", "cwd", "-p", &list, "-Fn"],
            ))
            .into_iter()
            .filter_map(|(pid, cwd)| if cwd == wanted { Some(pid) } else { None })
            .collect()
        };
        (terminal_pids, recent_transcript_candidates(dir))
    } else {
        (Vec::new(), Vec::new())
    };
    let seat_pids = parse_crew_runner_pids(
        &shell_stdout("/usr/bin/pgrep", &["-fl", "crew-runner.mjs"]),
        &project,
    );

    project_sessions_json(
        &project,
        &crew_rows,
        &orch_rows,
        &agent_list,
        pane_process_info.as_deref(),
        terminal_pids,
        transcripts,
        seat_pids,
    )
}

// ── herdr bridge ───────────────────────────────────────────────────────────────────────────────

pub(crate) fn desktop_bus_dir() -> PathBuf {
    std::env::var("AGENT_BUS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_default();
            PathBuf::from(home).join(".agent-bus")
        })
}

/// Serializes every test that repoints the process-wide `AGENT_BUS_DIR` env var: set_var/remove_var
/// mutate one environ block non-atomically. Hold it for the whole test body and restore the PRIOR
/// value, never a bare remove_var.
#[cfg(test)]
pub(crate) static BUS_DIR_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn find_herdr_binary() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let local = PathBuf::from(&home).join(".local/bin/herdr");
    if local.is_file() {
        return Some(local);
    }
    for dir in terminal_path().split(':') {
        if dir.is_empty() {
            continue;
        }
        let p = Path::new(dir).join("herdr");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[tauri::command]
pub(crate) async fn herdr_pane_read(pane_id: String) -> Result<String, String> {
    let id = pane_id.trim();
    if id.is_empty() || id.contains('\0') {
        return Err("herdr pane id is empty or invalid".into());
    }
    let Some(bin) = find_herdr_binary() else {
        return Err("herdr is not installed".into());
    };
    let out = identity_env::async_command(bin)
        .args(["pane", "read", id, "--source", "recent-unwrapped"])
        .env("PATH", terminal_path())
        .output()
        .await
        .map_err(|e| format!("herdr pane read could not start: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let err = String::from_utf8_lossy(if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    })
    .trim()
    .to_string();
    Err(if err.is_empty() {
        "herdr pane read failed".into()
    } else {
        format!("herdr pane read failed: {err}")
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct HerdrSeat {
    project: String,
    agent: String,
    surface: String,
    /// "herdr" for a crew seat, "orch" for the operator's own orchestrator pane. The pane strip
    /// needs the difference: an orchestrator is the person's session, not a worker to supervise.
    kind: String,
}

pub(crate) fn parse_herdr_seats(raw: &str) -> Vec<HerdrSeat> {
    let mut by_seat: BTreeMap<(String, String), HerdrSeat> = BTreeMap::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 4 {
            continue;
        }
        let project = fields[0].trim();
        let kind = fields[1].trim();
        let agent = fields[2].trim();
        let surface = fields[3].trim();
        // `orch` rides the same file as the crew seats (crew.sh records both). Dropping it here is
        // what made `trantor open` land a live pane the app could never show.
        if (kind != "herdr" && kind != "orch")
            || project.is_empty()
            || agent.is_empty()
            || surface.is_empty()
        {
            continue;
        }
        // crew.sh writes the orchestrator's agent column as the literal `__orch__` placeholder;
        // nobody should have to read that in a tab.
        let agent = if kind == "orch" {
            "orchestrator"
        } else {
            agent
        };
        by_seat.insert(
            (project.to_string(), agent.to_string()),
            HerdrSeat {
                project: project.to_string(),
                agent: agent.to_string(),
                surface: surface.to_string(),
                kind: kind.to_string(),
            },
        );
    }
    by_seat.into_values().collect()
}

#[tauri::command]
pub(crate) fn herdr_seats() -> Result<String, String> {
    // One state file, one recorder: crew.sh records herdr seats into the SAME crew-windows.txt as
    // every other mux (kind column = "herdr"); a separate file was drift waiting to happen.
    let path = desktop_bus_dir().join("crew-windows.txt");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("could not read herdr seat map: {e}")),
    };
    serde_json::to_string(&parse_herdr_seats(&raw)).map_err(|e| e.to_string())
}


/// Projects whose orchestrator PANE survived while the conversation inside did not (#5401): herdr
/// restores panes, not the claude processes in them. Queried at app LAUNCH only, never polled.
/// The pane handle doubles as the session id a dismissal is keyed on (#6476).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestorableSession {
    project: String,
    session_id: String,
}

#[tauri::command]
pub(crate) fn orch_restorables() -> Result<Vec<RestorableSession>, String> {
    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    let out = identity_env::command("herdr")
        .args(["agent", "list"])
        .env("PATH", terminal_path())
        .output()
        .map_err(|e| format!("herdr: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim())
        .unwrap_or(serde_json::Value::Null);
    let live: std::collections::HashSet<String> = v
        .get("result")
        .and_then(|r| r.get("agents"))
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    x.get("pane_id")
                        .and_then(|p| p.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(restorables_from(&rows, &live))
}

/// The pure half of orch_restorables: orch rows whose pane hosts no live agent. A ghost row
/// (pane gone entirely) is still restorable — `trantor open` heals it and resumes from the
/// transcript. Deduped per project (first row wins); row order preserved.
pub(crate) fn restorables_from(rows: &str, live_panes: &std::collections::HashSet<String>) -> Vec<RestorableSession> {
    let mut out: Vec<RestorableSession> = Vec::new();
    for line in rows.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() == 4
            && f[1] == "orch"
            && !f[0].is_empty()
            && !live_panes.contains(f[3])
            && !out.iter().any(|r| r.project == f[0])
        {
            out.push(RestorableSession { project: f[0].to_string(), session_id: f[3].to_string() });
        }
    }
    out
}


#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn lsof_field_output_yields_only_paths() {
        let out = "p31023\nfcwd\nn/Users/s/development/crebral-scribe\np33890\nfcwd\nn/Users/s/development/crebral-health\n";
        assert_eq!(
            lsof_cwds(out),
            vec![
                "/Users/s/development/crebral-scribe",
                "/Users/s/development/crebral-health"
            ]
        );
        assert!(lsof_cwds("").is_empty());
    }

    // a session deep inside a monorepo still belongs to its project, and a shell sitting AT the
    // dev root belongs to nothing
    #[test]
    fn cwd_maps_to_the_first_component_under_the_root() {
        let r = "/Users/s/development";
        assert_eq!(
            project_of_cwd("/Users/s/development/crebral-health", r),
            Some("crebral-health".into())
        );
        assert_eq!(
            project_of_cwd("/Users/s/development/crm-platform/apps/web", r),
            Some("crm-platform".into())
        );
        assert_eq!(project_of_cwd("/Users/s/development", r), None);
        assert_eq!(project_of_cwd("/Users/s/development/.hidden", r), None);
        assert_eq!(project_of_cwd("/Users/s/elsewhere/thing", r), None);
    }
}
