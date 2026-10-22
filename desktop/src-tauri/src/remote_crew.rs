use super::*;
use std::process::Stdio;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(240);
const ROSTER_INTERVAL: Duration = Duration::from_secs(600);
const MISSING_CHECKOUT: &str = "Can't find this project's checkout on the Mac";

pub(super) fn failure(error: impl AsRef<str>) -> Value {
    let error = output_tail(error.as_ref());
    json!({"outcome": "failed", "output": error, "error": error})
}

fn valid_spec(spec: &str) -> bool {
    let (agent, model) = spec
        .split_once(':')
        .map_or((spec, None), |(a, m)| (a, Some(m)));
    !agent.is_empty()
        && agent.len() <= 31
        && agent != "claude"
        && !agent
            .strip_prefix("claude-")
            .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|c| c.is_ascii_digit()))
        && agent.as_bytes()[0].is_ascii_lowercase()
        && agent
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && model.is_none_or(|m| {
            !m.is_empty()
                && m.len() <= 80
                && m.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._/-".contains(&c))
        })
}

fn argv(prompt: &Value) -> Result<Vec<String>, String> {
    let action = prompt["action"].as_str().ok_or("Missing crew action")?;
    if !matches!(action, "up" | "down" | "swap") {
        return Err("Invalid crew action".into());
    }
    let seats = match prompt.get("seats") {
        None => Vec::new(),
        Some(value) => serde_json::from_value::<Vec<String>>(value.clone())
            .map_err(|_| "Invalid crew seats")?,
    };
    if seats.len() > 6 || seats.iter().any(|s| !valid_spec(s)) {
        return Err("Invalid crew seat spec (claude and flags are forbidden)".into());
    }
    let mut args = vec![action.to_string()];
    if action == "swap" {
        for field in ["from", "to"] {
            let spec = prompt[field].as_str().ok_or("Swap requires from and to")?;
            if !valid_spec(spec) {
                return Err("Invalid swap seat spec (claude and flags are forbidden)".into());
            }
            args.push(spec.into());
        }
    } else {
        if action == "up" && seats.is_empty() {
            return Err("Up requires at least one seat".into());
        }
        args.extend(seats);
    }
    Ok(args)
}

fn checkout(raw: &str, surface: &str) -> Option<PathBuf> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let rows = value["result"]["agents"].as_array()?;
    let agent = rows.iter().find(|agent| agent["pane_id"] == surface)?;
    let cwd = agent["cwd"].as_str()?;
    (!cwd.is_empty() && Path::new(cwd).is_absolute()).then(|| PathBuf::from(cwd))
}

// Strip terminal control sequences before taking a Unicode-safe tail for the phone.
fn output_tail(raw: &str) -> String {
    let mut chars = raw.chars().peekable();
    let mut clean = VecDeque::new();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' || (c == '\x1b' && chars.next() == Some('\\')) {
                            break;
                        }
                    }
                }
                Some(c) if (' '..='/').contains(&c) => {
                    for c in chars.by_ref() {
                        if ('0'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\u{009b}' => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            c if !c.is_control() || matches!(c, '\n' | '\r' | '\t') => {
                clean.push_back(c);
                if clean.len() > 2000 {
                    clean.pop_front();
                }
            }
            _ => {}
        }
    }
    clean.into_iter().collect()
}

pub(super) struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

pub(super) trait Runner {
    fn hosts(&self, seat: &local_sessions::HerdrSeat) -> bool;
    fn run(
        &self,
        program: &str,
        args: &[String],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> impl std::future::Future<Output = Result<CommandOutput, String>> + Send;
}

pub(super) struct LiveRunner;
impl Runner for LiveRunner {
    fn hosts(&self, seat: &local_sessions::HerdrSeat) -> bool {
        still_hosted(seat)
    }

    async fn run(
        &self,
        program: &str,
        args: &[String],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<CommandOutput, String> {
        let mut command = crate::identity_env::command(program);
        command
            .args(args)
            .env("PATH", crate::terminal_path())
            .stdin(Stdio::null());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        run_command(command, timeout).await
    }
}

async fn run_command(
    command: std::process::Command,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| format!("Crew command timed out after {} seconds", timeout.as_secs()))?
        .map_err(|e| format!("Could not run command: {e}"))?;
    Ok(CommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

pub(super) async fn deliver(
    prompt: &Value,
    seat: &local_sessions::HerdrSeat,
    on: &AtomicBool,
    runner: &impl Runner,
) -> Value {
    let args = match argv(prompt) {
        Ok(args) => args,
        Err(error) => return failure(error),
    };
    if !on.load(Ordering::SeqCst) || !runner.hosts(seat) {
        return failure("Phone relay is off or this project is no longer hosted on this Mac");
    }
    let listing = runner
        .run(
            "herdr",
            &["agent".into(), "list".into()],
            None,
            Duration::from_secs(15),
        )
        .await;
    let cwd = listing
        .ok()
        .filter(|out| out.success)
        .and_then(|out| checkout(&out.stdout, &seat.surface));
    let Some(cwd) = cwd else {
        return failure(MISSING_CHECKOUT);
    };
    if !on.load(Ordering::SeqCst) || !runner.hosts(seat) {
        return failure("Phone relay is off or this project is no longer hosted on this Mac");
    }
    match runner
        .run("trantor", &args, Some(&cwd), COMMAND_TIMEOUT)
        .await
    {
        Ok(out) => {
            let output = output_tail(&format!("{}{}", out.stdout, out.stderr));
            let error = if out.success {
                None
            } else {
                Some(if output.is_empty() {
                    "Crew command failed".to_string()
                } else {
                    output.clone()
                })
            };
            json!({"outcome": if out.success { "done" } else { "failed" }, "output": output, "error": error})
        }
        Err(error) => failure(error),
    }
}

fn roster(raw: &str, machine: &str) -> Result<Value, String> {
    let rows: Vec<Value> =
        serde_json::from_str(raw).map_err(|e| format!("Provider roster: {e}"))?;
    let seats: Vec<Value> = rows
        .iter()
        .filter_map(|row| {
            let agent = row["provider"].as_str()?;
            if !valid_spec(agent) || agent.contains(':') {
                return None;
            }
            let kind = row["kind"].as_str().unwrap_or_default();
            let plan = row["usage"]["plan"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(kind);
            Some(
                json!({"agent": agent, "label": row["label"].as_str().unwrap_or(agent),
                "plan": plan, "metered": kind == "api" || plan.to_ascii_lowercase().contains("api"),
                "available": row["state"] == "connected",
                "reason": if row["state"] == "connected" { "" } else {
                    row["reason"].as_str().filter(|s| !s.is_empty())
                        .or_else(|| row["state"].as_str()).unwrap_or_default()
                }}),
            )
        })
        .collect();
    Ok(json!({"machine": machine, "seats": seats}))
}

async fn publish_roster(hub: &impl Hub, payload: Value, on: &AtomicBool) -> Result<(), String> {
    if !on.load(Ordering::SeqCst) {
        return Ok(());
    }
    let (status, body) = hub.request("POST", "/crew/roster", Some(payload)).await?;
    require_ok(status, &body)
}

async fn sample_roster(runner: &impl Runner, on: &AtomicBool) -> Result<Option<Value>, String> {
    if !on.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let status = runner
        .run(
            "trantor",
            &["provider".into(), "status".into(), "--json".into()],
            None,
            COMMAND_TIMEOUT,
        )
        .await?;
    if !status.success {
        return Err(output_tail(&status.stderr));
    }
    roster(&status.stdout, &hub::owner_identity()).map(Some)
}

pub(super) async fn roster_worker() {
    let mut next = tokio::time::Instant::now();
    loop {
        if !enabled().load(Ordering::SeqCst) {
            next = tokio::time::Instant::now();
        } else if tokio::time::Instant::now() >= next {
            next = tokio::time::Instant::now() + ROSTER_INTERVAL;
            match sample_roster(&LiveRunner, enabled()).await {
                Ok(Some(payload)) => {
                    let mut bases = vec![hub_base("")];
                    for seat in hosted().unwrap_or_default() {
                        let base = hub_base(&seat.project);
                        if !bases.contains(&base) {
                            bases.push(base);
                        }
                    }
                    for base in bases {
                        if let Err(error) =
                            publish_roster(&LiveHub { base }, payload.clone(), enabled()).await
                        {
                            eprintln!("phone relay roster: {error}");
                        }
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("phone relay roster: {error}"),
            }
        }
        tokio::time::sleep(TICK).await;
    }
}

#[cfg(test)]
#[path = "remote_crew_tests.rs"]
mod tests;
