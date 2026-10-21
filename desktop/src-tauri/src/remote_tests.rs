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
            assert_eq!(text, "full claimed text");
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
