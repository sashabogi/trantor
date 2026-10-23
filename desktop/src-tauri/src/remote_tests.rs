use super::*;
use std::sync::Arc;

type Replies = VecDeque<Result<(u16, Value), String>>;
struct FakeHub {
    replies: Mutex<Replies>,
    requests: Mutex<Vec<(String, String, Option<Value>)>>,
    order: Arc<Mutex<Vec<String>>>,
}
impl FakeHub {
    fn new(replies: Vec<(u16, Value)>) -> Self {
        Self {
            replies: Mutex::new(replies.into_iter().map(Ok).collect()),
            requests: Mutex::new(Vec::new()),
            order: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
impl Hub for FakeHub {
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), String> {
        self.order.lock().unwrap().push(path.into());
        self.requests
            .lock()
            .unwrap()
            .push((method.into(), path.into(), body));
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected hub request")
    }
}

fn turn(idx: usize, text: &str) -> Value {
    json!({"idx": idx, "role": "assistant", "blocks": [{"kind": "text", "text": text, "tool": null}]})
}
fn mirror() -> Mirror {
    Mirror {
        session: "sid".into(),
        total: 2,
        turns: vec![turn(0, "first"), turn(1, "second")],
        dirty: true,
        ..Mirror::default()
    }
}
fn claim() -> Value {
    json!({"ok": true, "prompt": {"id": "prompt-1", "project": "trantor", "text": "full claimed text"}})
}

#[tokio::test]
async fn publishes_whole_then_delta_and_replaces_growing_turn() {
    let hub = FakeHub::new(vec![
        (200, json!({"have":2})),
        (200, json!({"have":3})),
        (200, json!({"have":3})),
    ]);
    let mut mirror = mirror();
    let on = AtomicBool::new(true);
    mirror.publish("trantor", &hub, &on).await.unwrap();
    mirror.turns.push(turn(2, "third"));
    mirror.total = 3;
    mirror.dirty = true;
    mirror.publish("trantor", &hub, &on).await.unwrap();
    mirror.turns[2] = turn(2, "third continued");
    mirror.dirty = true;
    mirror.publish("trantor", &hub, &on).await.unwrap();
    let requests = hub.requests.lock().unwrap();
    assert_eq!(
        requests[0].2.as_ref().unwrap()["turns"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        requests[1].2.as_ref().unwrap()["turns"],
        json!([turn(2, "third")])
    );
    assert_eq!(
        requests[2].2.as_ref().unwrap()["turns"],
        json!([turn(2, "third continued")])
    );
}

#[tokio::test]
async fn have_zero_resends_window_and_failed_publish_remains_dirty() {
    let hub = FakeHub::new(vec![(200, json!({"have":0})), (200, json!({"have":2}))]);
    let mut mirror = mirror();
    mirror.have = 1;
    mirror.published = vec![turn(0, "first")];
    mirror
        .publish("trantor", &hub, &AtomicBool::new(true))
        .await
        .unwrap();
    let requests = hub.requests.lock().unwrap();
    assert_eq!(
        requests[0].2.as_ref().unwrap()["turns"],
        json!([turn(1, "second")])
    );
    assert_eq!(
        requests[1].2.as_ref().unwrap()["turns"],
        json!(mirror.turns)
    );
    drop(requests);
    let failing = FakeHub::new(vec![(503, json!({"error":"offline"}))]);
    mirror.dirty = true;
    assert!(mirror
        .publish("trantor", &failing, &AtomicBool::new(true))
        .await
        .is_err());
    assert!(mirror.dirty);
}

#[tokio::test]
async fn claim_precedes_delivery_and_ack_uses_claim_text() {
    let hub = FakeHub::new(vec![(200, claim()), (200, json!({"ok":true}))]);
    let order = hub.order.clone();
    let body = claim_and_deliver(
        &hub,
        "host",
        "trantor",
        json!("prompt-1"),
        &AtomicBool::new(true),
        move |text| async move {
            assert_eq!(text["text"], "full claimed text");
            order.lock().unwrap().push("herdr".into());
            panes::prompt_delivery(Ok(herdr::PromptOutcome::Delivered))
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        body,
        json!({"id":"prompt-1", "outcome":"delivered", "error":null})
    );
    ack(&hub, body).await.unwrap();
    assert_eq!(
        *hub.order.lock().unwrap(),
        vec!["/session/prompt/claim", "herdr", "/session/prompt/ack"]
    );
}

#[tokio::test]
async fn competing_claim_is_skipped_without_delivery_or_ack() {
    let hub = FakeHub::new(vec![(409, json!({"error":"already claimed"}))]);
    let result = claim_and_deliver(
        &hub,
        "host",
        "trantor",
        json!("prompt-1"),
        &AtomicBool::new(true),
        |_| async { panic!("unclaimed prompt delivered") },
    )
    .await
    .unwrap();
    assert!(result.is_none());
    assert_eq!(hub.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn off_switch_prevents_publish_claim_and_delivery() {
    let hub = FakeHub::new(vec![]);
    let off = AtomicBool::new(false);
    let mut mirror = mirror();
    mirror.publish("trantor", &hub, &off).await.unwrap();
    assert!(mirror.dirty);
    assert!(claim_and_deliver(
        &hub,
        "host",
        "trantor",
        json!("prompt-1"),
        &off,
        |_| async { panic!("disabled relay delivered") }
    )
    .await
    .unwrap()
    .is_none());
    assert!(hub.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mismatched_claim_never_types_into_a_different_project() {
    let mut response = claim();
    response["prompt"]["project"] = json!("another-project");
    let hub = FakeHub::new(vec![(200, response)]);
    let body = claim_and_deliver(
        &hub,
        "host",
        "trantor",
        json!("prompt-1"),
        &AtomicBool::new(true),
        |_| async { panic!("mismatched claim delivered") },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(body["outcome"], "not_ready");
    assert!(body["error"].as_str().unwrap().contains("invalid prompt"));
}

#[tokio::test]
async fn every_herdr_outcome_maps_to_ack_and_preserves_composer_reason() {
    use herdr::PromptOutcome::*;
    for (outcome, expected) in [
        (Delivered, "delivered"),
        (Blocked, "blocked"),
        (NotReady, "not_ready"),
        (Stalled, "stalled"),
        (NoAgent, "no_agent"),
    ] {
        let hub = FakeHub::new(vec![(200, claim())]);
        let body = claim_and_deliver(
            &hub,
            "host",
            "trantor",
            json!("prompt-1"),
            &AtomicBool::new(true),
            |_| async move { panes::prompt_delivery(Ok(outcome)) },
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(body["outcome"], expected);
        assert_eq!(body["error"].is_null(), expected == "delivered");
    }
    let failed = panes::prompt_delivery(Err("socket disconnected".into()));
    assert_eq!(failed.outcome, "stalled");
    assert_eq!(failed.error.as_deref(), Some("socket disconnected"));
}

fn scratch(name: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.agent-bus-out")
        .join(format!("remote-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&path).unwrap();
    path
}
fn row(text: &str) -> String {
    format!("{}\n", json!({"type":"user", "message":{"content":text}}))
}

#[test]
fn tails_only_changed_bytes_and_resets_on_session_switch_or_truncation() {
    let dir = scratch("tail");
    let path = dir.join("transcript.jsonl");
    let raw = format!("{}{}{}", row("hello"), json!({"type":"progress"}), "\n");
    std::fs::write(&path, &raw).unwrap();
    let mut mirror = Mirror::default();
    assert!(mirror.read("s1", &path).unwrap());
    assert_eq!(mirror.total, 1, "idx counts decoded turns, not raw rows");
    assert!(!mirror.read("s1", &path).unwrap());
    std::fs::write(&path, format!("{}{}", raw, row("next"))).unwrap();
    mirror.read("s1", &path).unwrap();
    assert_eq!(mirror.total, 2);
    assert_eq!(mirror.turns[1]["idx"], 1);
    mirror.have = 2;
    mirror.read("s2", &path).unwrap();
    assert_eq!(mirror.have, 0);
    assert_eq!(mirror.total, 2);
    std::fs::write(&path, row("new")).unwrap();
    mirror.read("s2", &path).unwrap();
    assert_eq!(mirror.total, 1);
    assert_eq!(mirror.turns[0]["blocks"][0]["text"], "new");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn partial_rows_and_four_hundred_turn_window_keep_full_decoded_indices() {
    let dir = scratch("window");
    let path = dir.join("transcript.jsonl");
    let raw = (0..405)
        .map(|i| row(&format!("message {i}")))
        .collect::<String>();
    let partial = row("tail");
    std::fs::write(&path, format!("{}{}", raw, partial.trim_end())).unwrap();
    let mut mirror = Mirror::default();
    mirror.read("sid", &path).unwrap();
    assert_eq!(mirror.total, 405);
    assert_eq!(mirror.turns.len(), 400);
    assert_eq!(mirror.turns[0]["idx"], 5);
    std::fs::write(&path, format!("{raw}{partial}")).unwrap();
    mirror.read("sid", &path).unwrap();
    assert_eq!(mirror.total, 406);
    assert_eq!(mirror.turns.last().unwrap()["idx"], 405);
    assert_eq!(
        mirror.payload("trantor", true)["turns"]
            .as_array()
            .unwrap()
            .len(),
        400
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn preference_defaults_on_persists_and_preserves_hub_config() {
    let dir = scratch("preference");
    let path = dir.join("config.json");
    assert!(preference(&read_config(&path).unwrap()));
    std::fs::write(
        &path,
        r#"{"url":"http://hub","hubs":{"trantor":"http://pin"}}"#,
    )
    .unwrap();
    save_preference(&path, false).unwrap();
    let config = read_config(&path).unwrap();
    assert!(!preference(&config));
    assert_eq!(config["hubs"]["trantor"], "http://pin");
    save_preference(&path, true).unwrap();
    assert!(preference(&read_config(&path).unwrap()));
    assert_eq!(
        queued_path("a & b").unwrap(),
        "/session/prompts?project=a+%26+b&status=queued"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn reconnect_resends_unchanged_transcript_without_waiting_for_more_output() {
    let hub = FakeHub::new(vec![(200, json!({"have":2})), (200, json!({"have":2}))]);
    let on = AtomicBool::new(true);
    let mut mirror = mirror();
    mirror.reconnected(1);
    mirror.publish("trantor", &hub, &on).await.unwrap();
    mirror.reconnected(1);
    mirror.publish("trantor", &hub, &on).await.unwrap();
    assert_eq!(
        hub.requests.lock().unwrap().len(),
        1,
        "same connection does no extra work"
    );
    mirror.reconnected(2);
    mirror.publish("trantor", &hub, &on).await.unwrap();
    let requests = hub.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].2.as_ref().unwrap()["turns"],
        json!(mirror.turns)
    );
}

#[tokio::test]
async fn disabling_while_claim_is_in_flight_acks_without_delivering() {
    struct DisablingHub<'a> {
        hub: FakeHub,
        on: &'a AtomicBool,
    }
    impl Hub for DisablingHub<'_> {
        async fn request(
            &self,
            method: &str,
            path: &str,
            body: Option<Value>,
        ) -> Result<(u16, Value), String> {
            self.on.store(false, Ordering::SeqCst);
            self.hub.request(method, path, body).await
        }
    }
    let on = AtomicBool::new(true);
    let hub = DisablingHub {
        hub: FakeHub::new(vec![(200, claim())]),
        on: &on,
    };
    let body = claim_and_deliver(&hub, "host", "trantor", json!("prompt-1"), &on, |_| async {
        panic!("claim completion bypassed the kill switch")
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(body["outcome"], "not_ready");
    assert!(body["error"].as_str().unwrap().contains("turned off"));
}

#[tokio::test]
async fn retrying_failed_ack_does_not_reclaim_or_redeliver() {
    let hub = FakeHub::new(vec![
        (200, claim()),
        (503, json!({"error":"retry"})),
        (200, json!({"ok":true})),
    ]);
    let order = hub.order.clone();
    let body = claim_and_deliver(
        &hub,
        "host",
        "trantor",
        json!("prompt-1"),
        &AtomicBool::new(true),
        move |_| async move {
            order.lock().unwrap().push("herdr".into());
            panes::prompt_delivery(Ok(herdr::PromptOutcome::Delivered))
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert!(ack(&hub, body.clone()).await.is_err());
    ack(&hub, body).await.unwrap();
    assert_eq!(
        *hub.order.lock().unwrap(),
        vec![
            "/session/prompt/claim",
            "herdr",
            "/session/prompt/ack",
            "/session/prompt/ack"
        ]
    );
}

#[tokio::test]
async fn answer_claim_does_not_require_text() {
    let mut body = claim();
    body["prompt"].as_object_mut().unwrap().remove("text");
    body["prompt"]["kind"] = json!("answer");
    body["prompt"]["toolId"] = json!("ask-1");
    let hub = FakeHub::new(vec![(200, body)]);
    let result = claim_and_deliver(
        &hub,
        "host",
        "trantor",
        json!("prompt-1"),
        &AtomicBool::new(true),
        |prompt| async move {
            assert_eq!(prompt["toolId"], "ask-1");
            panes::PromptDelivery {
                outcome: "delivered",
                error: None,
            }
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result["outcome"], "delivered");
}

#[tokio::test]
async fn answer_requires_matching_single_live_question_and_stale_types_nothing() {    let dir = scratch("answer");
    let prompt = json!({"session":"sid", "toolId":"ask-1", "picks":[1]});
    let question = json!({"question":"Ship?", "options":[{"label":"Yes"},{"label":"No"}]});
    let path = dir.join("sid.json");
    for sidecar in [
        None,
        Some(
            json!({"session_id":"sid", "project":"trantor", "cwd":"/tmp",
        "tool_use_id":"old", "questions":[question.clone()], "ts":0}),
        ),
        Some(
            json!({"session_id":"sid", "project":"trantor", "cwd":"/tmp",
        "tool_use_id":"ask-1", "questions":[question.clone(), question.clone()], "ts":0}),
        ),
    ] {
        if let Some(sidecar) = sidecar {
            std::fs::write(&path, sidecar.to_string()).unwrap();
        }
        let result = deliver_answer(&prompt, &dir, |_, _| async {
            panic!("stale answer typed keys")
        })
        .await;
        assert_eq!(result.outcome, "stale");
        assert_eq!(
            result.error.as_deref(),
            Some("That question was already answered or replaced.")
        );
    }
    std::fs::write(
        &path,
        json!({"session_id":"sid", "project":"trantor", "cwd":"/tmp",
        "tool_use_id":"ask-1", "questions":[question], "ts":0})
        .to_string(),
    )
    .unwrap();
    let result = deliver_answer(&prompt, &dir, |session, keys| async move {
        assert_eq!(session, "sid");
        assert_eq!(keys, "\x1b[B\r");
        Ok(())
    })
    .await;
    assert_eq!(result.outcome, "delivered");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn published_ask_gains_answer_when_result_arrives_in_later_snapshot() {
    let dir = scratch("answer-publish");
    let path = dir.join("transcript.jsonl");
    let ask = format!(
        "{}\n",
        json!({"type":"assistant", "message":{"content":[{
        "type":"tool_use", "id":"ask-1", "name":"AskUserQuestion", "input":{"questions":[{
            "question":"Ship?", "options":[{"label":"Yes"},{"label":"No"}]}]}}]}})
    );
    std::fs::write(&path, &ask).unwrap();
    let mut mirror = Mirror::default();
    mirror.read("sid", &path).unwrap();
    assert_eq!(mirror.turns[0]["blocks"][0]["tool_id"], "ask-1");
    assert!(mirror.turns[0]["blocks"][0].get("answer").is_none());
    mirror.published = mirror.turns.clone();
    mirror.have = mirror.total;
    let result = format!(
        "{}\n",
        json!({"type":"user", "message":{"content":[{
        "type":"tool_result", "tool_use_id":"ask-1", "content":"No"}]}})
    );
    std::fs::write(&path, format!("{ask}{result}")).unwrap();
    mirror.read("sid", &path).unwrap();
    let payload = mirror.payload("trantor", false);
    assert_eq!(payload["turns"][0]["idx"], 0);
    assert_eq!(payload["turns"][0]["blocks"][0]["answer"], "No");
    std::fs::remove_dir_all(dir).unwrap();
}

// ---- photo attachments: download on claim, paths appended to the prompt (#12161) ----

struct FakeFetcher {
    replies: Mutex<VecDeque<Result<(u16, Vec<u8>), String>>>,
    requests: Mutex<Vec<String>>,
}
impl FakeFetcher {
    fn new(replies: Vec<Result<(u16, Vec<u8>), String>>) -> Self {
        Self {
            replies: Mutex::new(replies.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        }
    }
}
impl AttachmentFetcher for FakeFetcher {
    async fn fetch(&self, path: &str) -> Result<(u16, Vec<u8>), String> {
        self.requests.lock().unwrap().push(path.into());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected attachment fetch")
    }
}

fn jpeg(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[2] = 0xff;
    bytes
}

fn attach_seat() -> local_sessions::HerdrSeat {
    local_sessions::HerdrSeat {
        project: "trantor".into(),
        agent: "op".into(),
        surface: "pane-1".into(),
        kind: "orch".into(),
    }
}

#[tokio::test]
async fn claimed_attachments_download_and_the_prompt_names_existing_files() {
    let dir = scratch("attach");
    let fetcher = FakeFetcher::new(vec![Ok((200, jpeg(64))), Ok((200, jpeg(32)))]);
    let prompt = json!({"id": 42, "project": "trantor", "text": "look at this",
        "attachments": [{"name": "a.jpg", "size": 64}, {"name": "b.jpg", "size": 32}]});
    let delivered = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = delivered.clone();
    let body = deliver_prompt_claimed(&fetcher, prompt, attach_seat(), &dir, move |surface, text| async move {
        assert_eq!(surface, "pane-1");
        captured.lock().unwrap().push(text);
        panes::PromptDelivery { outcome: "delivered", error: None }
    })
    .await;
    assert_eq!(body["outcome"], "delivered");
    let text = delivered.lock().unwrap()[0].clone();
    assert!(
        text.starts_with("look at this\n\nAttached images:\n"),
        "prompt text was not preserved: {text}"
    );
    let paths: Vec<PathBuf> = text
        .lines()
        .filter(|line| line.starts_with('/'))
        .map(PathBuf::from)
        .collect();
    assert_eq!(paths.len(), 2, "one line per attachment: {text}");
    assert!(paths.iter().all(|p| p.is_absolute() && p.exists()), "{text}");
    assert_eq!(std::fs::read(&paths[0]).unwrap(), jpeg(64));
    assert_eq!(std::fs::read(&paths[1]).unwrap(), jpeg(32));
    assert_eq!(
        *fetcher.requests.lock().unwrap(),
        vec![
            "/session/attachment?id=42&n=0".to_string(),
            "/session/attachment?id=42&n=1".to_string()
        ]
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_failed_or_non_jpeg_attachment_stalls_delivery_and_types_nothing() {
    let dir = scratch("attach-bad");
    let fetcher = FakeFetcher::new(vec![Ok((404, Vec::new()))]);
    let prompt = json!({"id": 7, "project": "trantor", "text": "hello",
        "attachments": [{"name": "a.jpg", "size": 64}]});
    let body = deliver_prompt_claimed(&fetcher, prompt, attach_seat(), &dir, |_surface, _text| async {
        panic!("a failed download must not deliver")
    })
    .await;
    assert_eq!(body["outcome"], "stalled");
    assert!(body["error"].as_str().unwrap().contains("nothing was typed"));

    let fetcher = FakeFetcher::new(vec![Ok((200, b"\x89PNG-not-a-jpeg".to_vec()))]);
    let prompt = json!({"id": 8, "project": "trantor", "text": "hello",
        "attachments": [{"name": "a.jpg", "size": 15}]});
    let body = deliver_prompt_claimed(&fetcher, prompt, attach_seat(), &dir, |_surface, _text| async {
        panic!("non-JPEG bytes must not deliver")
    })
    .await;
    assert_eq!(body["outcome"], "stalled");
    assert!(body["error"].as_str().unwrap().contains("not a JPEG"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_prompt_without_attachments_types_its_plain_text() {
    let dir = scratch("attach-none");
    let fetcher = FakeFetcher::new(vec![]);
    let prompt = json!({"id": 9, "project": "trantor", "text": "plain prompt"});
    let delivered = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = delivered.clone();
    let body = deliver_prompt_claimed(&fetcher, prompt, attach_seat(), &dir, move |_surface, text| async move {
        captured.lock().unwrap().push(text);
        panes::PromptDelivery { outcome: "delivered", error: None }
    })
    .await;
    assert_eq!(body["outcome"], "delivered");
    assert_eq!(delivered.lock().unwrap()[0], "plain prompt");
    assert!(fetcher.requests.lock().unwrap().is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn attachment_file_stems_are_filesystem_safe() {
    assert_eq!(sanitize_file_stem("42"), "42");
    assert_eq!(sanitize_file_stem("prompt-1"), "prompt-1");
    assert_eq!(sanitize_file_stem("../etc/passwd"), "___etc_passwd");
    assert_eq!(sanitize_file_stem(""), "prompt");
}

// ---- #12161 review fixes: byte cap, path components, TTL cleanup + rollback ----

#[tokio::test]
async fn an_attachment_over_the_byte_cap_stalls_and_leaves_no_files() {
    let dir = scratch("attach-cap");
    let fetcher = FakeFetcher::new(vec![Ok((200, jpeg(ATTACHMENT_BYTES_MAX + 1)))]);
    let prompt = json!({"id": 60, "project": "trantor", "text": "huge",
        "attachments": [{"name": "a.jpg", "size": 99999999}]});
    let body = deliver_prompt_claimed(&fetcher, prompt, attach_seat(), &dir, |_surface, _text| async {
        panic!("an over-cap attachment must not deliver")
    })
    .await;
    assert_eq!(body["outcome"], "stalled");
    assert!(
        body["error"].as_str().unwrap().contains("byte cap"),
        "the error names the cap: {:?}",
        body["error"]
    );
    let left: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(left.is_empty(), "over-cap download left files behind: {left:?}");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_failed_second_download_removes_the_first_image() {
    let dir = scratch("attach-rollback");
    let fetcher = FakeFetcher::new(vec![Ok((200, jpeg(64))), Err("hub went away".into())]);
    let prompt = json!({"id": 61, "project": "trantor", "text": "two pics",
        "attachments": [{"name": "a.jpg", "size": 64}, {"name": "b.jpg", "size": 32}]});
    let body = deliver_prompt_claimed(&fetcher, prompt, attach_seat(), &dir, |_surface, _text| async {
        panic!("a partial download must not deliver")
    })
    .await;
    assert_eq!(body["outcome"], "stalled");
    let left: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(left.is_empty(), "orphaned first image left behind: {left:?}");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn attachment_project_names_cannot_escape_the_attachments_root() {
    // attachments_dir("") is the root plus one sanitized component; its parent IS the root.
    let root = attachments_dir("").parent().unwrap().to_path_buf();
    for project in ["../../escape", "/etc/passwd", "a/b", "..", ".", "trantor"] {
        let dir = attachments_dir(project);
        assert!(dir.starts_with(&root), "{project} escaped the root: {}", dir.display());
    }
    assert_eq!(attachments_dir("trantor"), root.join("trantor"));
}

#[test]
fn attachments_past_the_ttl_are_pruned_and_fresh_ones_kept() {
    let root = scratch("prune");
    let project = root.join("trantor");
    std::fs::create_dir_all(&project).unwrap();
    let old = project.join("1-0.jpg");
    std::fs::write(&old, b"old").unwrap();
    let stale = std::time::SystemTime::now() - ATTACHMENT_TTL - Duration::from_secs(60);
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(stale))
        .unwrap();
    let fresh = project.join("2-0.jpg");
    std::fs::write(&fresh, b"fresh").unwrap();
    let removed = prune_attachments(&root, ATTACHMENT_TTL, std::time::SystemTime::now());
    assert_eq!(removed, 1, "only the stale file goes");
    assert!(!old.exists(), "the stale file was removed");
    assert!(fresh.exists(), "the fresh file survives");
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn more_than_four_attachments_stalls_before_any_fetch_or_directory_creation() {
    let root = scratch("attach-count");
    let dir = root.join("not-created");
    let fetcher = FakeFetcher::new(vec![]);
    let prompt = json!({"id": 42, "project": "trantor", "text": "five photos",
        "attachments": vec![json!({"name": "a.jpg", "size": 64}); 5]});
    let result = deliver_prompt_claimed(&fetcher, prompt, attach_seat(), &dir, |_, _| async {
        panic!("an over-count claim must never be typed")
    }).await;
    assert_eq!(result["outcome"], "stalled");
    assert!(result["error"].as_str().unwrap().contains("at most 4"));
    assert!(fetcher.requests.lock().unwrap().is_empty());
    assert!(!dir.exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn four_attachments_are_delivered() {
    let dir = scratch("attach-four");
    let fetcher = FakeFetcher::new(vec![Ok((200, jpeg(64))); 4]);
    let prompt = json!({"id": 42, "attachments": vec![json!({"name": "a.jpg", "size": 64}); 4]});
    let paths = download_attachments(&fetcher, &prompt, &dir).await.unwrap();
    assert_eq!(paths.len(), 4);
    assert!(paths.iter().all(|p| p.exists()));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn claim_renewals_continue_during_lock_wait_and_execution() {
    struct RenewHub {
        requests: Mutex<Vec<Value>>,
        renewed: tokio::sync::Notify,
    }
    impl Hub for RenewHub {
        async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
            assert_eq!((method, path), ("POST", "/session/prompt/claim"));
            let body = body.unwrap();
            assert_eq!(body, json!({"id": 42, "host": "mac", "renew": true}));
            self.requests.lock().unwrap().push(body);
            self.renewed.notify_one();
            Ok((200, json!({"ok": true})))
        }
    }
    let hub = RenewHub { requests: Mutex::new(Vec::new()), renewed: tokio::sync::Notify::new() };
    let mut locks = HashMap::new();
    let lock = project_lock(&mut locks, "trantor");
    let guard = lock.lock().await;
    let operation = async {
        let _guard = lock.lock().await;
        hub.renewed.notified().await;
        json!({"outcome": "delivered"})
    };
    let unlock = async {
        hub.renewed.notified().await;
        drop(guard);
    };
    let id = json!(42);
    let run = execute_with_renewal(&hub, "mac", &id, operation, Duration::from_millis(5));
    let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(run, unlock)
    }).await.unwrap();
    assert_eq!(result["outcome"], "delivered");
    let count = hub.requests.lock().unwrap().len();
    assert!(count >= 2, "both lock wait and execution need renewal");
    tokio::time::sleep(Duration::from_millis(15)).await;
    assert_eq!(hub.requests.lock().unwrap().len(), count, "renewals end with delivery");
}
