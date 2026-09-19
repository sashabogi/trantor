#[allow(unused_imports)]
use super::*;

/// The session id of this project's orchestrator conversation. Resolution order is the
/// SYSTEM-CONTRACT §4 identity row: the pane's own herdr report, then `orch-sessions.txt`.
/// Never "the newest transcript": guessing between conversations is the adopt picker's job.
pub(crate) fn orch_session_id(project: &str) -> Option<String> {
    let rows =
        std::fs::read_to_string(desktop_bus_dir().join("crew-windows.txt")).unwrap_or_default();
    if let Some(pane) = orch_pane_from_rows(&rows, project) {
        // The herdr leg is cached (3s): the chat watcher calls this every 300ms and a per-tick
        // socket round-trip let a load-slowed herdr stall the transcript tail. Identity moves at
        // handoff speed, so 3s of staleness is invisible.
        static HERDR_SID: std::sync::Mutex<Option<(String, Instant, Option<String>)>> =
            std::sync::Mutex::new(None);
        let cached: Option<Option<String>> = {
            let g = HERDR_SID.lock().unwrap();
            g.as_ref()
                .filter(|(p, at, _)| p == &pane && at.elapsed() < Duration::from_secs(3))
                .map(|(_, _, sid)| sid.clone())
        };
        let reported = match cached {
            Some(sid) => sid,
            None => {
                let sid = herdr::reported_session(&pane);
                *HERDR_SID.lock().unwrap() = Some((pane.clone(), Instant::now(), sid.clone()));
                sid
            }
        };
        if let Some(sid) = reported {
            // A pane report can be poisoned by an ephemeral claude run in the same pane (a plugin
            // update registers a sid with no transcript), so it only wins when its transcript exists.
            let plausible = orchestrator_transcript_path(project, &sid)
                .map(|p| p.exists())
                .unwrap_or(false);
            if plausible {
                return Some(sid);
            }
        }
    }
    let p = desktop_bus_dir().join("orch-sessions.txt");
    let raw = std::fs::read_to_string(p).ok()?;
    for line in raw.lines() {
        let mut it = line.split('\t');
        if it.next()? == project {
            let sid = it.next()?.trim();
            if !sid.is_empty() {
                return Some(sid.to_string());
            }
        }
    }
    None
}

/// One renderable piece of a turn, decoded from what a Claude transcript actually contains:
/// assistant text/thinking/tool_use, user text/tool_result/image. A raw TUI y/n prompt never
/// reaches the transcript; AskUserQuestion does, as an ordinary tool_use, and `ask` keeps it (#6094).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatBlock {
    /// "text" | "thinking" | "tool" | "image"
    kind: String,
    text: String,
    /// tool blocks only
    tool: Option<String>,
    tool_id: Option<String>,
    /// Set only when `tool == "AskUserQuestion"` and `input.questions` parses — the structured
    /// data the question card renders. None (never an empty vec) on a shape mismatch, so a
    /// surprise input falls back to the plain tool row rather than a broken card.
    #[serde(skip_serializing_if = "Option::is_none")]
    ask: Option<Vec<AskQuestion>>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AskOption {
    label: String,
    description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskQuestion {
    header: String,
    question: String,
    multi_select: bool,
    options: Vec<AskOption>,
}

/// Parse an AskUserQuestion tool_use's `input.questions[]` into the question card's data. `?`
/// throughout: any missing/mistyped field means the shape does not match, and the caller falls
/// back to the plain tool row — a card built from a guess would show a person the wrong choices.
pub(crate) fn parse_ask_questions(input: &serde_json::Value) -> Option<Vec<AskQuestion>> {
    let arr = input.get("questions")?.as_array()?;
    let qs: Vec<AskQuestion> = arr
        .iter()
        .filter_map(|q| {
            let question = q.get("question")?.as_str()?.to_string();
            let header = q.get("header").and_then(|h| h.as_str()).unwrap_or("").to_string();
            let multi_select = q.get("multiSelect").and_then(|m| m.as_bool()).unwrap_or(false);
            let options = q
                .get("options")?
                .as_array()?
                .iter()
                .filter_map(|o| {
                    Some(AskOption {
                        label: o.get("label")?.as_str()?.to_string(),
                        description: o
                            .get("description")
                            .and_then(|d| d.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect();
            Some(AskQuestion { header, question, multi_select, options })
        })
        .collect();
    if qs.is_empty() { None } else { Some(qs) }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatTurn {
    role: String,
    blocks: Vec<ChatBlock>,
    /// A message the operator sent while the agent was mid-turn: recorded, not yet seen. Three
    /// states exist (sent, queued, seen) and the middle one must show; a dequeue marker clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    queued: Option<bool>,
}

/// What the agent IS, taken from the transcript rather than asserted: the session itself wrote it,
/// so it is evidence. An empty field renders as absent, never as a default that looks like knowledge.
#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct ChatMeta {
    model: String,
    version: String,
    branch: String,
    context: ChatContext,
    #[serde(skip)]
    guard: ContextGuard,
}

/// The context gauge's poison guard (#5572, SYSTEM-CONTRACT §4 "context %"): one usage row far
/// below the session's running max is an artifact, a sustained new level (five rows) re-baselines.
/// The same rule lives in hooks/lib/handoff.mjs so the baton and the gauge never disagree.
#[derive(Debug, Clone, Default)]
pub(crate) struct ContextGuard {
    max: u64,
    recent: Vec<u64>,
}

impl ContextGuard {
    const RING: usize = 5;
    const FLOOR_FRAC: f64 = 0.4;

    fn push(&mut self, tokens: u64) {
        if tokens == 0 {
            return;
        }
        self.recent.push(tokens);
        if self.recent.len() > Self::RING {
            self.recent.remove(0);
        }
        if tokens > self.max {
            self.max = tokens;
        }
    }

    fn absorb(&mut self, other: &ContextGuard) {
        for t in &other.recent {
            self.push(*t);
        }
        if other.max > self.max {
            self.max = other.max;
        }
    }

    fn report(&mut self) -> Option<u64> {
        let last = *self.recent.last()?;
        let floor = (self.max as f64 * Self::FLOOR_FRAC) as u64;
        if last >= floor {
            return Some(last);
        }
        if self.recent.len() == Self::RING && self.recent.iter().all(|r| *r < floor) {
            // Five in a row agree: reality changed. Re-baseline so the guard follows it.
            self.max = *self.recent.iter().max().unwrap();
            return Some(last);
        }
        // A transient artifact: report the best recent evidence, never the poisoned row.
        Some(*self.recent.iter().max().unwrap())
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct ChatContext {
    tokens: Option<u64>,
    window: u64,
    frac: Option<f64>,
}

/// Text the harness injected into the conversation wearing the user's role (hook output, notices,
/// reminders). A closed list of known prefixes, not a length heuristic: a long message from a person
/// is still a message from a person.
pub(crate) fn is_harness_injection(t: &str) -> bool {
    const MARKERS: &[&str] = &[
        "Stop hook feedback:",
        "[Request interrupted",
        "PostToolUse:",
        "PreToolUse:",
        "SessionStart:",
        "Caveat: The messages below",
        "<system-reminder",
        "<command-name>",
        "[SYSTEM NOTIFICATION",
        "This session is being continued from a previous conversation",
        // The crew boot prompt (bin/crew-runner.mjs kicks every seat off with it). Matched as a
        // SHORT PREFIX on purpose: transcript stores truncate it at various lengths, and the full
        // sentence marker let the truncated tail leak into Sessions titles (#5842).
        "You just joined (your arrival was",
        "NEW BUS MESSAGE for you:",
        "NEW BUS MESSAGES for you:",
    ];
    let t = t.trim_start();
    t.starts_with('<') || MARKERS.iter().any(|m| t.starts_with(m)) || t.contains("system-reminder")
}

pub(crate) fn chat_context(tokens: Option<u64>, window: u64) -> ChatContext {
    ChatContext {
        tokens,
        window,
        frac: tokens.and_then(|t| {
            if window > 0 {
                Some(t as f64 / window as f64)
            } else {
                None
            }
        }),
    }
}

pub(crate) fn read_context_window() -> u64 {
    let path = desktop_bus_dir().join("config.json");
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return 0,
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v.get("contextWindow").and_then(|w| w.as_u64()).unwrap_or(0),
        Err(_) => 0,
    }
}

pub(crate) fn assistant_usage_tokens(v: &serde_json::Value) -> Option<u64> {
    let usage = v.get("message")?.get("usage")?;
    let mut seen = false;
    let total = [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .filter_map(|k| {
        let n = usage.get(*k).and_then(|v| v.as_u64());
        if n.is_some() {
            seen = true;
        }
        n
    })
    .sum();
    if seen {
        Some(total)
    } else {
        None
    }
}

pub(crate) fn text_content(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|b| match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => b.get("text").and_then(|t| t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(crate) fn bookkeeping_divider_text(v: &serde_json::Value, content: &serde_json::Value) -> Option<String> {
    if v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
        let text = text_content(content);
        return if text.trim().is_empty() {
            None
        } else {
            Some(text)
        };
    }
    let serde_json::Value::String(s) = content else {
        return None;
    };
    if is_slash_command(s)
        || s.starts_with("<local-command-caveat>")
        || s.starts_with("<local-command-stdout>")
    {
        Some(s.clone())
    } else {
        None
    }
}

/// A slash-command record, not merely text starting with "/": a command's first token is one bare
/// name, an absolute path has more slashes in it. A bare starts_with('/') swallowed a file drop.
pub(crate) fn is_slash_command(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('/') else {
        return false;
    };
    let token = rest.split_whitespace().next().unwrap_or("");
    !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
}

pub(crate) fn merge_chat_meta(current: &mut ChatMeta, next: ChatMeta) {
    if !next.model.is_empty() {
        current.model = next.model;
    }
    if !next.version.is_empty() {
        current.version = next.version;
    }
    if !next.branch.is_empty() {
        current.branch = next.branch;
    }
    current.context.window = next.context.window;
    // Usage rows fold through the persistent guard (#5572): a batch is often ONE row, so the
    // poison filter must live across batches, in the meta the watcher carries — never in the
    // stateless per-batch decode alone.
    current.guard.absorb(&next.guard);
    let tokens = current.guard.report().or(current.context.tokens);
    current.context = chat_context(tokens, current.context.window);
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatToolResult {
    tool_id: String,
    ok: bool,
    preview: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatSnapshot {
    turns: Vec<ChatTurn>,
    results: Vec<ChatToolResult>,
    total: usize,
    meta: ChatMeta,
    /// RAW text of every user-role row, UNFILTERED (receipts read the record, not the display —
    /// five delivery false-alarms came from matching against harness-filtered turns; a
    /// bang-command's <bash-input> row, a /compact record, an isMeta row all vanish from
    /// display but all PROVE arrival).
    receipt_texts: Vec<String>,
    /// The batch contained a turn-boundary system row (`turn_duration` / `stop_hook_summary`).
    /// The status stream can freeze on `working` — a dead subscription never delivers the idle
    /// frame (#5993, 40 minutes stuck) — so the transcript itself carries the belt: the batch
    /// that SAYS the turn ended lets the frontend re-seed the status once, no polling.
    turn_ended: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatRowsPayload {
    project: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    after: usize,
    total: usize,
    turns: Vec<ChatTurn>,
    results: Vec<ChatToolResult>,
    meta: ChatMeta,
    #[serde(rename = "receiptTexts")]
    receipt_texts: Vec<String>,
    /// True when this batch carried the turn-boundary system row (#5993) — the frontend's one
    /// allowed moment to re-seed the pushed status without polling.
    turn_ended: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatSessionChangedPayload {
    project: String,
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Debug, Default)]
pub(crate) struct TranscriptTail {
    byte_offset: u64,
    line_offset: usize,
    pending: String,
}

impl TranscriptTail {
    fn reset(&mut self) {
        self.byte_offset = 0;
        self.line_offset = 0;
        self.pending.clear();
    }

    fn seed_from_raw(&mut self, raw: &str) {
        self.byte_offset = raw.len() as u64;
        let (complete, pending) = complete_line_count(raw);
        self.line_offset = complete;
        self.pending = pending;
    }

    fn push_chunk(&mut self, chunk: &str) -> (usize, Vec<String>, usize) {
        let after = self.line_offset;
        if chunk.is_empty() {
            return (after, Vec::new(), self.line_offset);
        }
        let mut text = String::new();
        if !self.pending.is_empty() {
            text.push_str(&self.pending);
            self.pending.clear();
        }
        text.push_str(chunk);

        let complete = text.ends_with('\n');
        let mut parts: Vec<&str> = text.split('\n').collect();
        if !complete {
            self.pending = parts
                .pop()
                .unwrap_or_default()
                .trim_end_matches('\r')
                .to_string();
        } else if parts.last() == Some(&"") {
            parts.pop();
        }
        let lines = parts
            .into_iter()
            .map(|s| s.trim_end_matches('\r').to_string())
            .collect::<Vec<_>>();
        self.line_offset += lines.len();
        (after, lines, self.line_offset)
    }

    fn read_new_lines(&mut self, path: &Path) -> std::io::Result<(usize, Vec<String>, usize)> {
        let mut f = std::fs::File::open(path)?;
        let len = f.metadata()?.len();
        if len < self.byte_offset {
            self.reset();
        }
        f.seek(SeekFrom::Start(self.byte_offset))?;
        let mut chunk = String::new();
        f.read_to_string(&mut chunk)?;
        self.byte_offset = f.stream_position()?;
        Ok(self.push_chunk(&chunk))
    }
}

pub(crate) fn complete_line_count(raw: &str) -> (usize, String) {
    if raw.is_empty() || raw.ends_with('\n') {
        return (raw.lines().count(), String::new());
    }
    let mut parts: Vec<&str> = raw.split('\n').collect();
    let pending = parts
        .pop()
        .unwrap_or_default()
        .trim_end_matches('\r')
        .to_string();
    (parts.len(), pending)
}

pub(crate) fn complete_lines(raw: &str) -> Vec<&str> {
    if raw.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<&str> = raw.split('\n').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    } else {
        parts.pop();
    }
    parts
        .into_iter()
        .map(|s| s.trim_end_matches('\r'))
        .collect()
}

pub(crate) fn orchestrator_transcript_path(project: &str, sid: &str) -> Result<PathBuf, String> {
    let dir = project_dir(project).ok_or_else(|| format!("no local checkout for {project}"))?;
    let slug: String = dir
        .to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    let home = std::env::var("HOME").unwrap_or_default();
    Ok(std::path::Path::new(&home)
        .join(".claude/projects")
        .join(&slug)
        .join(format!("{sid}.jsonl")))
}

/// Tool inputs are objects of wildly different shapes. The one-line summary is the field a person
/// would recognise, and everything else is noise in a chat.
pub(crate) fn tool_summary(name: &str, input: &serde_json::Value) -> String {
    let pick = |k: &str| {
        input
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let s = match name {
        "Bash" => pick("command"),
        "Read" | "Write" | "Edit" | "NotebookEdit" => pick("file_path"),
        "Glob" | "Grep" => {
            let p = pick("pattern");
            let path = pick("path");
            if path.is_empty() {
                p
            } else {
                format!("{p}  in {path}")
            }
        }
        "WebFetch" => pick("url"),
        "Task" | "Agent" => pick("description"),
        // `input`'s only field is a `questions` ARRAY, so the generic first-string-field
        // fallback below finds nothing and used to render this row with an empty summary —
        // the first symptom the operator saw of #6094.
        "AskUserQuestion" => input
            .get("questions")
            .and_then(|q| q.as_array())
            .and_then(|a| a.first())
            .and_then(|q| q.get("question"))
            .and_then(|q| q.as_str())
            .unwrap_or("")
            .to_string(),
        _ => {
            // An unknown tool gets its first string field rather than a guess at which key matters.
            input
                .as_object()
                .and_then(|o| o.values().find_map(|v| v.as_str()))
                .unwrap_or("")
                .to_string()
        }
    };
    let s = s.replace('\n', " ");
    if s.chars().count() > 160 {
        s.chars().take(160).collect::<String>() + "…"
    } else {
        s
    }
}

pub(crate) fn preview_of(v: &serde_json::Value) -> String {
    let raw = match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(a) => a
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    let raw = raw.trim();
    if raw.chars().count() > 2000 {
        raw.chars().take(2000).collect::<String>() + "\n…"
    } else {
        raw.to_string()
    }
}

pub(crate) fn decode_chat_lines<I, S>(lines: I, total: usize) -> ChatSnapshot
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    decode_chat_lines_with_context_window(lines, total, read_context_window())
}

pub(crate) fn decode_chat_lines_with_context_window<I, S>(
    lines: I,
    total: usize,
    context_window: u64,
) -> ChatSnapshot
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut turns: Vec<ChatTurn> = Vec::new();
    let mut results: Vec<ChatToolResult> = Vec::new();
    let mut receipt_texts: Vec<String> = Vec::new();
    let mut turn_ended = false;
    let mut meta = ChatMeta {
        context: chat_context(None, context_window),
        ..ChatMeta::default()
    };

    for line in lines {
        let v: serde_json::Value = match serde_json::from_str(line.as_ref()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // The receipt channel: RAW arrival truth, before display filtering. Plain user rows
        // and queue enqueues both prove a send arrived, whatever the display decides to show.
        match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => {
                if let Some(c) = v.get("message").and_then(|m| m.get("content")) {
                    let t = text_content(c);
                    if !t.trim().is_empty() {
                        receipt_texts.push(t);
                    }
                }
            }
            Some("queue-operation") => {
                if let Some(t) = v.get("content").and_then(|c| c.as_str()) {
                    if !t.trim().is_empty() {
                        receipt_texts.push(t.to_string());
                    }
                }
            }
            _ => {}
        }
        let role = match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            // A message sent mid-turn never becomes a `user` row: the CLI records an enqueue and
            // folds the words into the running turn. The enqueue IS the operator speaking; `remove`
            // is queue bookkeeping and stays invisible.
            Some("queue-operation") => {
                let op = v.get("operation").and_then(|o| o.as_str());
                // `remove` = the session consumed the queued message. Emitted as a marker the
                // front-end reducer uses to clear the matching turn's queued flag, then drops —
                // it never renders.
                if op == Some("remove") {
                    if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                        if !text.trim().is_empty() && !is_harness_injection(text) {
                            turns.push(ChatTurn {
                                role: "system".into(),
                                blocks: vec![ChatBlock {
                                    kind: "dequeue".into(),
                                    text: text.to_string(),
                                    tool: None,
                                    tool_id: None,
                                    ask: None,
                                }],
                                queued: None,
                            });
                        }
                    }
                    continue;
                }
                if op == Some("enqueue") {
                    if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                        // The queue carries the HARNESS too: task-notifications and system
                        // notices are enqueued exactly like operator messages. Same filter as
                        // every other user-shaped row.
                        if !text.trim().is_empty() && !is_harness_injection(text) {
                            turns.push(ChatTurn {
                                role: "user".into(),
                                blocks: vec![ChatBlock {
                                    kind: "text".into(),
                                    text: text.to_string(),
                                    tool: None,
                                    tool_id: None,
                                    ask: None,
                                }],
                                queued: Some(true),
                            });
                        }
                    }
                }
                continue;
            }
            // A turn's end is a fact the transcript states (#5993): a `system` row with subtype
            // `turn_duration`, or the stop hook's `stop_hook_summary`. The pushed status stream can
            // freeze on `working`, so the rows batch carries the truth. Bookkeeping, never a bubble.
            Some("system") => {
                if matches!(
                    v.get("subtype").and_then(|s| s.as_str()),
                    Some("turn_duration") | Some("stop_hook_summary")
                ) {
                    turn_ended = true;
                }
                continue;
            }
            // `system` entries are hook summaries and harness notices addressed to the machinery.
            _ => continue,
        };
        // Identity comes from the LAST assistant entry seen, so a model switch mid-session shows
        // the model that is actually answering rather than the one that started.
        if role == "assistant" {
            if let Some(m) = v
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
            {
                meta.model = m.to_string();
            }
            if let Some(tokens) = assistant_usage_tokens(&v) {
                meta.guard.push(tokens);
                meta.context = chat_context(meta.guard.report(), context_window);
            }
        }
        if let Some(x) = v.get("version").and_then(|x| x.as_str()) {
            meta.version = x.to_string();
        }
        if let Some(x) = v.get("gitBranch").and_then(|x| x.as_str()) {
            meta.branch = x.to_string();
        }

        let content = match v.get("message").and_then(|m| m.get("content")) {
            Some(c) => c,
            None => continue,
        };
        if role == "user" {
            if let Some(text) = bookkeeping_divider_text(&v, content) {
                turns.push(ChatTurn {
                    role: "system".into(),
                    blocks: vec![ChatBlock {
                        kind: "divider".into(),
                        text,
                        tool: None,
                        tool_id: None,
                        ask: None,
                    }],
                    queued: None,
                });
                continue;
            }
        }
        let mut blocks: Vec<ChatBlock> = Vec::new();
        match content {
            // A typed message is a plain string — and so is every hook injection, which is why
            // this branch has to filter exactly like the array branch does.
            serde_json::Value::String(s) if !s.trim().is_empty() && !is_harness_injection(s) => {
                blocks.push(ChatBlock {
                    kind: "text".into(),
                    text: s.trim().to_string(),
                    tool: None,
                    tool_id: None,
                    ask: None,
                })
            }
            serde_json::Value::Array(items) => {
                for b in items {
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            let t = b.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
                            // Injected context is addressed to the model, not the reader, and it
                            // dwarfs what the person actually typed.
                            if t.is_empty() || is_harness_injection(t) {
                                continue;
                            }
                            blocks.push(ChatBlock {
                                kind: "text".into(),
                                text: t.to_string(),
                                tool: None,
                                tool_id: None,
                                ask: None,
                            });
                        }
                        Some("thinking") => {
                            let t = b
                                .get("thinking")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .trim();
                            if t.is_empty() {
                                continue;
                            }
                            blocks.push(ChatBlock {
                                kind: "thinking".into(),
                                text: t.to_string(),
                                tool: None,
                                tool_id: None,
                                ask: None,
                            });
                        }
                        Some("tool_use") => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            let empty = serde_json::Value::Null;
                            let input = b.get("input").unwrap_or(&empty);
                            blocks.push(ChatBlock {
                                kind: "tool".into(),
                                text: tool_summary(name, input),
                                tool: Some(name.to_string()),
                                tool_id: b.get("id").and_then(|i| i.as_str()).map(String::from),
                                ask: if name == "AskUserQuestion" { parse_ask_questions(input) } else { None },
                            });
                        }
                        Some("tool_result") => {
                            if let Some(id) = b.get("tool_use_id").and_then(|i| i.as_str()) {
                                let empty = serde_json::Value::Null;
                                results.push(ChatToolResult {
                                    tool_id: id.to_string(),
                                    ok: !b
                                        .get("is_error")
                                        .and_then(|e| e.as_bool())
                                        .unwrap_or(false),
                                    preview: preview_of(b.get("content").unwrap_or(&empty)),
                                });
                            }
                        }
                        Some("image") => blocks.push(ChatBlock {
                            kind: "image".into(),
                            text: "image".into(),
                            tool: None,
                            tool_id: None,
                            ask: None,
                        }),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        if blocks.is_empty() {
            continue;
        }
        turns.push(ChatTurn {
            role: role.to_string(),
            blocks,
            queued: None,
        });
    }
    ChatSnapshot {
        turns,
        results,
        total,
        meta,
        receipt_texts,
        turn_ended,
    }
}

pub(crate) fn read_chat_snapshot(project: &str, after: usize, session_id: Option<&str>) -> Result<ChatSnapshot, String> {
    let path = match session_id {
        Some(id) => sessions::claude_transcript_path(project, id)?,
        None => {
            let sid = orch_session_id(project)
                .ok_or_else(|| "no orchestrator session for this project yet".to_string())?;
            orchestrator_transcript_path(project, &sid)?
        }
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => {
            return Ok(ChatSnapshot {
                turns: Vec::new(),
                results: Vec::new(),
                total: 0,
                meta: ChatMeta::default(),
                receipt_texts: Vec::new(),
                turn_ended: false,
            })
        }
    };
    let lines = complete_lines(&raw);
    let total = lines.len();
    let context_window = read_context_window();
    let full_meta =
        decode_chat_lines_with_context_window(lines.iter().copied(), total, context_window).meta;
    let mut snap =
        decode_chat_lines_with_context_window(lines.into_iter().skip(after), total, context_window);
    snap.meta = full_meta;
    Ok(snap)
}

#[tauri::command]
pub(crate) fn orchestrator_chat(project: String, after: usize, session_id: Option<String>) -> Result<String, String> {
    let snap = read_chat_snapshot(&project, after, session_id.as_deref())?;
    serde_json::to_string(&(
        snap.turns,
        snap.results,
        snap.total,
        snap.meta,
        snap.receipt_texts,
    ))
    .map_err(|e| e.to_string())
}


#[cfg(test)]
mod context_guard_tests {
    use super::*;

    /// The SHARED #5572 manifest — the mjs twin (hooks/lib/handoff.mjs guardContextTokens,
    /// drilled by test-handoff.mjs) runs the same file. One spec, two bindings, zero drift.
    const MANIFEST: &str = include_str!("../../../test/fixtures/context/manifest.json");

    #[test]
    fn the_guard_satisfies_every_manifest_case() {
        let m: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
        for case in m["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let mut g = ContextGuard::default();
            for t in case["rows"].as_array().unwrap() {
                g.push(t.as_u64().unwrap());
            }
            let got = g.report();
            let expect = case["expect"].as_u64();
            assert_eq!(
                got, expect,
                "case '{name}': got {got:?}, manifest says {expect:?}"
            );
        }
    }

    #[test]
    fn merge_carries_the_guard_across_single_row_batches() {
        // The incident shape: the watcher delivers ONE poisoned row as its own batch.
        let window = 1_000_000;
        let mut meta = ChatMeta {
            context: chat_context(None, window),
            ..ChatMeta::default()
        };
        for tokens in [400_000u64, 884_056, 889_929] {
            let mut batch = ChatMeta {
                context: chat_context(None, window),
                ..ChatMeta::default()
            };
            batch.guard.push(tokens);
            batch.context = chat_context(batch.guard.report(), window);
            merge_chat_meta(&mut meta, batch);
        }
        let mut poison = ChatMeta {
            context: chat_context(None, window),
            ..ChatMeta::default()
        };
        poison.guard.push(70_000);
        poison.context = chat_context(poison.guard.report(), window);
        merge_chat_meta(&mut meta, poison);
        assert_eq!(
            meta.context.tokens,
            Some(889_929),
            "the gauge must not read 7% at a real 88%"
        );
    }
}
