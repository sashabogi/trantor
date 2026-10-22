//! Phone chat relay (#12130): the transcript decoder and herdr remain the owners of chat and delivery.
use crate::{asks, chat, herdr, hub, identity, local_sessions, panes};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::mpsc;

#[path = "remote_crew.rs"]
mod crew;

const WINDOW: usize = 400;
const TICK: Duration = Duration::from_millis(1500);
static ENABLED: OnceLock<AtomicBool> = OnceLock::new();
static EVENTS: OnceLock<mpsc::UnboundedSender<RelayEvent>> = OnceLock::new();
static CONNECTIONS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);
static SETTING_WRITE: Mutex<()> = Mutex::new(());

fn preference(config: &Value) -> bool {
    config
        .get("relayChatToPhone")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn enabled() -> &'static AtomicBool {
    ENABLED.get_or_init(|| AtomicBool::new(relay_chat_get().unwrap_or(false)))
}

#[tauri::command]
pub(crate) fn relay_chat_get() -> Result<bool, String> {
    let config = read_config(&crate::desktop_bus_dir().join("config.json"))?;
    Ok(preference(&config))
}

fn read_config(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

fn save_preference(path: &Path, on: bool) -> Result<(), String> {
    let mut config = read_config(path)?;
    config
        .as_object_mut()
        .ok_or("config.json is not an object")?
        .insert("relayChatToPhone".into(), json!(on));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("relay.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn relay_chat_set(on: bool) -> Result<bool, String> {
    let _guard = crate::lock_or_recover(&SETTING_WRITE);
    save_preference(&crate::desktop_bus_dir().join("config.json"), on)?;
    enabled().store(on, Ordering::SeqCst);
    Ok(on)
}

trait Hub {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> impl std::future::Future<Output = Result<(u16, Value), String>> + Send;
}

struct LiveHub {
    base: String,
}
impl Hub for LiveHub {
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), String> {
        // hub_request signs the exact body through identity::sign and recovers local enrollment.
        let response = hub::hub_request(
            self.base.clone(),
            method.into(),
            path.into(),
            body.map(|v| v.to_string()),
        )
        .await?;
        let value = serde_json::from_str(&response.body).map_err(|e| format!("{path}: {e}"))?;
        Ok((response.status, value))
    }
}

fn require_ok(status: u16, body: &Value) -> Result<(), String> {
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(format!(
            "hub HTTP {status}: {}",
            body.get("error").unwrap_or(body)
        ))
    }
}

fn hub_base(project: &str) -> String {
    identity::hub_for_project(project)
        .trim_end_matches('/')
        .to_string()
}

fn hosted() -> Result<Vec<local_sessions::HerdrSeat>, String> {
    let raw = match std::fs::read_to_string(crate::desktop_bus_dir().join("crew-windows.txt")) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.to_string()),
    };
    Ok(local_sessions::parse_herdr_seats(&raw)
        .into_iter()
        .filter(|seat| seat.kind == "orch")
        .collect())
}

#[derive(Default)]
struct Mirror {
    session: String,
    path: PathBuf,
    tail: chat::TranscriptTail,
    size: Option<u64>,
    total: usize,
    turns: Vec<Value>,
    meta: chat::ChatMeta,
    working: Option<bool>,
    have: usize,
    published: Vec<Value>,
    dirty: bool,
    connection: u64,
}

impl Mirror {
    fn reconnected(&mut self, connection: u64) {
        if self.connection != connection {
            self.connection = connection;
            self.have = 0;
            self.dirty = true;
        }
    }

    fn read(&mut self, session: &str, path: &Path) -> Result<bool, String> {
        let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
        if self.session != session || self.path != path || self.size.is_some_and(|old| size < old) {
            *self = Self {
                session: session.into(),
                path: path.into(),
                connection: self.connection,
                ..Self::default()
            };
        }
        if self.size == Some(size) {
            return Ok(false);
        }
        let (_, lines, raw_total) = self.tail.read_new_lines(path).map_err(|e| e.to_string())?;
        let snapshot = chat::decode_chat_lines_with_context_window(
            lines,
            raw_total,
            chat::read_context_window(),
        );
        chat::merge_chat_meta(&mut self.meta, snapshot.meta);
        for turn in snapshot.turns {
            let mut value = serde_json::to_value(turn).map_err(|e| e.to_string())?;
            value["idx"] = json!(self.total);
            self.total += 1;
            self.turns.push(value);
        }
        for turn in &mut self.turns {
            if let Some(blocks) = turn["blocks"].as_array_mut() {
                for block in blocks {
                    if block["tool"] == "AskUserQuestion" {
                        if let Some(result) = snapshot
                            .results
                            .iter()
                            .find(|r| block["tool_id"] == r.tool_id)
                        {
                            block["answer"] = json!(result.preview);
                        }
                    }
                }
            }
        }
        if self.turns.len() > WINDOW {
            self.turns.drain(..self.turns.len() - WINDOW);
        }
        self.size = Some(self.tail.byte_offset);
        self.dirty = true;
        Ok(true)
    }

    fn payload(&self, project: &str, whole: bool) -> Value {
        let changed = self
            .turns
            .iter()
            .find_map(|turn| {
                let idx = turn["idx"].as_u64()? as usize;
                let old = self.published.iter().find(|old| old["idx"] == turn["idx"]);
                (old != Some(turn)).then_some(idx)
            })
            .unwrap_or(self.total);
        let after = if whole { 0 } else { self.have.min(changed) };
        let turns: Vec<&Value> = self
            .turns
            .iter()
            .filter(|turn| {
                turn["idx"]
                    .as_u64()
                    .is_some_and(|idx| idx as usize >= after)
            })
            .collect();
        json!({"project": project, "session": self.session, "total": self.total, "turns": turns,
            "meta": {"working": self.working, "model": self.meta.model, "context": self.meta.context}})
    }

    async fn publish(
        &mut self,
        project: &str,
        hub: &impl Hub,
        on: &AtomicBool,
    ) -> Result<(), String> {
        if !self.dirty || !on.load(Ordering::SeqCst) {
            return Ok(());
        }
        for attempt in 0..2 {
            if !on.load(Ordering::SeqCst) {
                return Ok(());
            }
            let payload = self.payload(project, self.have == 0);
            let (status, body) = hub.request("POST", "/session/chat", Some(payload)).await?;
            require_ok(status, &body)?;
            self.have = body
                .get("have")
                .and_then(Value::as_u64)
                .ok_or("chat response missing have")? as usize;
            if self.have == 0 && self.total > 0 {
                if attempt == 1 {
                    return Err("hub requested another whole chat window".into());
                }
                continue;
            }
            self.published = self.turns.clone();
            self.dirty = false;
            return Ok(());
        }
        Ok(())
    }
}

#[derive(Debug)]
enum RelayEvent {
    Ack {
        base: String,
        body: Value,
    },
    Pickup {
        base: String,
        project: Option<String>,
    },
    Prompt {
        base: String,
        project: String,
        id: Value,
    },
}

fn queue(event: RelayEvent) {
    if let Some(sender) = EVENTS.get() {
        let _ = sender.send(event);
    }
}

pub(crate) fn stream_connected(base: &str) {
    let mut connections = crate::lock_or_recover(&CONNECTIONS);
    *connections
        .get_or_insert_with(HashMap::new)
        .entry(base.into())
        .or_default() += 1;
    drop(connections);
    queue(RelayEvent::Pickup {
        base: base.into(),
        project: None,
    });
}

pub(crate) fn stream_event(base: &str, raw: &str) {
    if !enabled().load(Ordering::SeqCst) {
        return;
    }
    let Ok(event) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    if event["type"] != "chat.prompt" {
        return;
    }
    if let (Some(project), Some(id)) = (event["project"].as_str(), event.get("id")) {
        queue(RelayEvent::Prompt {
            base: base.into(),
            project: project.into(),
            id: id.clone(),
        });
    }
}

async fn claim_and_execute<F, Fut>(
    hub: &impl Hub,
    host: &str,
    project: &str,
    id: Value,
    on: &AtomicBool,
    deliver: F,
) -> Result<Option<Value>, String>
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    if !on.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let (status, body) = hub
        .request(
            "POST",
            "/session/prompt/claim",
            Some(json!({"id": id, "host": host})),
        )
        .await?;
    if status == 409 {
        return Ok(None);
    }
    require_ok(status, &body)?;
    let prompt = &body["prompt"];
    let is_crew = prompt["kind"] == "crew";
    let error = if prompt["id"] != id
        || prompt["project"] != project
        || (!is_crew && prompt["kind"] != "answer" && !prompt["text"].is_string())
    {
        Some("Hub claim returned an invalid prompt; nothing was executed.")
    } else if !on.load(Ordering::SeqCst) {
        Some("Relay chat to my phone was turned off; nothing was executed.")
    } else {
        None
    };
    let mut result = match error {
        Some(error) if is_crew => crew::failure(error),
        Some(error) => json!({"outcome": "not_ready", "error": error}),
        None => deliver(prompt.clone()).await,
    };
    result["id"] = id;
    Ok(Some(result))
}

fn prompt_result(delivery: panes::PromptDelivery) -> Value {
    json!({"outcome": delivery.outcome, "error": delivery.error})
}

#[cfg(test)]
async fn claim_and_deliver<F, Fut>(
    hub: &impl Hub,
    host: &str,
    project: &str,
    id: Value,
    on: &AtomicBool,
    deliver: F,
) -> Result<Option<Value>, String>
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = panes::PromptDelivery>,
{
    claim_and_execute(hub, host, project, id, on, |prompt| async move {
        prompt_result(deliver(prompt).await)
    })
    .await
}

async fn deliver_answer<F, Fut>(prompt: &Value, dir: &Path, send: F) -> panes::PromptDelivery
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let session = prompt["session"].as_str().unwrap_or_default();
    let tool_id = prompt["toolId"].as_str().unwrap_or_default();
    let picks = serde_json::from_value::<Vec<i64>>(prompt["picks"].clone());
    let other = serde_json::from_value::<Option<String>>(prompt["other"].clone());
    let keys = match (picks, other) {
        (Ok(picks), Ok(other)) => asks::live_answer_keys(dir, session, tool_id, picks, other),
        _ => None,
    };
    let Some(keys) = keys else {
        return panes::PromptDelivery {
            outcome: "stale",
            error: Some("That question was already answered or replaced.".into()),
        };
    };
    if keys.is_empty() {
        return panes::PromptDelivery {
            outcome: "not_ready",
            error: Some("No answer was selected.".into()),
        };
    }
    match send(session.into(), keys).await {
        Ok(()) => panes::PromptDelivery {
            outcome: "delivered",
            error: None,
        },
        Err(error) => panes::PromptDelivery {
            outcome: "stalled",
            error: Some(error),
        },
    }
}

async fn ack(hub: &impl Hub, body: Value) -> Result<(), String> {
    let (status, response) = hub
        .request("POST", "/session/prompt/ack", Some(body))
        .await?;
    require_ok(status, &response)
}

fn queued_path(project: &str) -> Result<String, String> {
    let query = reqwest::Url::parse_with_params(
        "http://localhost/session/prompts",
        &[("project", project), ("status", "queued")],
    );
    let url = query.map_err(|error| error.to_string())?;
    Ok(format!(
        "{}?{}",
        url.path(),
        url.query().unwrap_or_default()
    ))
}

async fn deliver_claimed(prompt: Value, seat: local_sessions::HerdrSeat) -> Value {
    if prompt["kind"] == "crew" {
        return crew::deliver(&prompt, &seat, enabled(), &crew::LiveRunner).await;
    }
    if prompt["kind"] == "answer" {
        let current = tokio::task::spawn_blocking(move || still_hosted(&seat))
            .await
            .unwrap_or(false);
        if !current || !enabled().load(Ordering::SeqCst) {
            return prompt_result(panes::prompt_delivery(Ok(herdr::PromptOutcome::NoAgent)));
        }
        return prompt_result(
            deliver_answer(
                &prompt,
                &crate::desktop_bus_dir().join("asks"),
                asks::ask_answer_session,
            )
            .await,
        );
    }
    let text = prompt["text"].as_str().unwrap_or_default().to_string();
    prompt_result(
        tokio::task::spawn_blocking(move || {
            if !enabled().load(Ordering::SeqCst) {
                return panes::PromptDelivery {
                    outcome: "not_ready",
                    error: Some("Phone relay is off; nothing was typed.".into()),
                };
            }
            if still_hosted(&seat) {
                panes::deliver_prompt(&seat.surface, &text)
            } else {
                panes::prompt_delivery(Ok(herdr::PromptOutcome::NoAgent))
            }
        })
        .await
        .unwrap_or_else(|error| panes::PromptDelivery {
            outcome: "stalled",
            error: Some(error.to_string()),
        }),
    )
}

fn still_hosted(seat: &local_sessions::HerdrSeat) -> bool {
    hosted()
        .ok()
        .is_some_and(|seats| seats.iter().any(|s| s == seat))
}

fn project_lock(
    locks: &mut HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    project: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    locks.entry(project.into()).or_default().clone()
}

async fn hosted_claim<F, Fut>(
    hub: &impl Hub,
    host: &str,
    project: &str,
    id: Value,
    on: &AtomicBool,
    seats: &[local_sessions::HerdrSeat],
    deliver: F,
) -> Result<Option<Value>, String>
where
    F: FnOnce(Value, local_sessions::HerdrSeat) -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    let Some(seat) = seats
        .iter()
        .find(|s| s.kind == "orch" && s.project == project)
        .cloned()
    else {
        return Ok(None);
    };
    claim_and_execute(hub, host, project, id, on, |prompt| deliver(prompt, seat)).await
}

async fn prompt_worker(mut events: mpsc::UnboundedReceiver<RelayEvent>) {
    let mut pending_acks: VecDeque<(String, Value)> = VecDeque::new();
    let mut locks = HashMap::new();
    loop {
        // Retry only the acknowledgment: a lost reply must never cause a second delivery.
        for _ in 0..pending_acks.len() {
            if let Some((base, body)) = pending_acks.pop_front() {
                if let Err(error) = ack(&LiveHub { base: base.clone() }, body.clone()).await {
                    eprintln!("phone relay ack: {error}");
                    pending_acks.push_back((base, body));
                }
            }
        }
        let event = match tokio::time::timeout(TICK, events.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => return,
            Err(_) => continue,
        };
        let event = match event {
            RelayEvent::Ack { base, body } => {
                pending_acks.push_back((base, body));
                continue;
            }
            event => event,
        };
        if !enabled().load(Ordering::SeqCst) {
            continue;
        }
        let seats = match tokio::task::spawn_blocking(hosted).await {
            Ok(Ok(seats)) => seats,
            _ => continue,
        };
        match event {
            RelayEvent::Pickup { base, project } => {
                for seat in seats
                    .iter()
                    .filter(|seat| project.as_ref().is_none_or(|p| p == &seat.project))
                {
                    if !enabled().load(Ordering::SeqCst) {
                        break;
                    }
                    if hub_base(&seat.project) != base {
                        continue;
                    }
                    let hub = LiveHub { base: base.clone() };
                    let result = match queued_path(&seat.project) {
                        Ok(path) => hub.request("GET", &path, None).await,
                        Err(error) => Err(error),
                    };
                    match result {
                        Ok((status, body)) if (200..300).contains(&status) => {
                            if let Some(prompts) = body["prompts"].as_array() {
                                for prompt in prompts {
                                    if prompt["project"] == seat.project {
                                        if let Some(id) = prompt.get("id") {
                                            queue(RelayEvent::Prompt {
                                                base: base.clone(),
                                                project: seat.project.clone(),
                                                id: id.clone(),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        other => eprintln!("phone relay queued pickup: {other:?}"),
                    }
                }
            }
            RelayEvent::Prompt { base, project, id } => {
                if hub_base(&project) != base || !seats.iter().any(|s| s.project == project) {
                    continue;
                }
                let lock = project_lock(&mut locks, &project);
                tokio::spawn(async move {
                    let _guard = lock.lock().await;
                    // Resolve ownership after waiting, before claiming anything on this Mac.
                    let seats = tokio::task::spawn_blocking(hosted).await;
                    let Ok(Ok(seats)) = seats else {
                        return;
                    };
                    let result = hosted_claim(
                        &LiveHub { base: base.clone() },
                        &hub::owner_identity(),
                        &project,
                        id,
                        enabled(),
                        &seats,
                        deliver_claimed,
                    )
                    .await;
                    match result {
                        Ok(Some(body)) => queue(RelayEvent::Ack { base, body }),
                        Ok(None) => {}
                        Err(error) => eprintln!("phone relay claim: {error}"),
                    }
                });
            }
            RelayEvent::Ack { .. } => unreachable!(),
        }
    }
}

pub(crate) fn start(app: tauri::AppHandle) {
    let (sender, receiver) = mpsc::unbounded_channel();
    if EVENTS.set(sender).is_err() {
        return;
    }
    tauri::async_runtime::spawn(prompt_worker(receiver));
    tauri::async_runtime::spawn(crew::roster_worker());
    tauri::async_runtime::spawn(async move {
        let mut mirrors: HashMap<(String, String), Mirror> = HashMap::new();
        loop {
            if !enabled().load(Ordering::SeqCst) {
                mirrors.clear();
                tokio::time::sleep(TICK).await;
                continue;
            }
            let sampled = tokio::task::spawn_blocking(move || {
                let seats = hosted()?;
                let connections = crate::lock_or_recover(&CONNECTIONS)
                    .clone()
                    .unwrap_or_default();
                let mut hosts = Vec::new();
                for seat in seats {
                    let base = hub_base(&seat.project);
                    let key = (base.clone(), seat.project.clone());
                    hosts.push(key.clone());
                    if !mirrors.contains_key(&key) {
                        queue(RelayEvent::Pickup {
                            base: base.clone(),
                            project: Some(seat.project.clone()),
                        });
                    }
                    let mirror = mirrors.entry(key).or_default();
                    let connection = connections.get(&base).copied().unwrap_or(0);
                    mirror.reconnected(connection);
                    if let Some(session) = chat::orch_session_id(&seat.project) {
                        if let Ok(path) =
                            chat::orchestrator_transcript_path(&seat.project, &session)
                        {
                            match mirror.read(&session, &path) {
                                Ok(true) => {
                                    mirror.working = herdr::agent_status(&seat.surface)
                                        .map(|status| status == "working")
                                }
                                Ok(false) => {}
                                Err(error) => {
                                    eprintln!("phone relay transcript {}: {error}", seat.project)
                                }
                            }
                        }
                    }
                }
                mirrors.retain(|key, _| hosts.contains(key));
                Ok::<_, String>((mirrors, hosts))
            })
            .await;
            match sampled {
                Ok(Ok((next, hosts))) => {
                    mirrors = next;
                    for (base, project) in hosts {
                        hub::start_stream(app.clone(), base.clone()).await;
                        if let Some(mirror) = mirrors.get_mut(&(base.clone(), project.clone())) {
                            if !mirror.session.is_empty() {
                                if let Err(error) =
                                    mirror.publish(&project, &LiveHub { base }, enabled()).await
                                {
                                    eprintln!("phone relay publish {project}: {error}");
                                }
                            }
                        }
                    }
                }
                other => {
                    eprintln!(
                        "phone relay sampling: {}",
                        match other {
                            Ok(Err(error)) => error,
                            Err(error) => error.to_string(),
                            _ => String::new(),
                        }
                    );
                    mirrors = HashMap::new();
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
