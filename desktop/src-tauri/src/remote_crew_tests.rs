use super::*;

type Call = (String, Vec<String>, Option<PathBuf>, Duration);
struct FakeRunner {
    calls: Mutex<Vec<Call>>,
    replies: Mutex<VecDeque<Result<CommandOutput, String>>>,
    hosted: AtomicBool,
}
impl FakeRunner {
    fn new(replies: Vec<Result<CommandOutput, String>>) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            replies: Mutex::new(replies.into()),
            hosted: AtomicBool::new(true),
        }
    }
}
impl Runner for FakeRunner {
    fn hosts(&self, _: &local_sessions::HerdrSeat) -> bool {
        self.hosted.load(Ordering::SeqCst)
    }
    async fn run(
        &self,
        program: &str,
        args: &[String],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<CommandOutput, String> {
        self.calls.lock().unwrap().push((
            program.into(),
            args.to_vec(),
            cwd.map(Path::to_path_buf),
            timeout,
        ));
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected command")
    }
}

struct FakeHub {
    replies: Mutex<VecDeque<(u16, Value)>>,
    requests: Mutex<Vec<(String, Option<Value>)>>,
}
impl FakeHub {
    fn new(replies: Vec<(u16, Value)>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            requests: Mutex::new(Vec::new()),
        }
    }
}
impl Hub for FakeHub {
    async fn request(
        &self,
        _: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), String> {
        self.requests.lock().unwrap().push((path.into(), body));
        Ok(self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected hub request"))
    }
}

fn output(success: bool, stdout: &str, stderr: &str) -> Result<CommandOutput, String> {
    Ok(CommandOutput {
        success,
        stdout: stdout.into(),
        stderr: stderr.into(),
    })
}
fn agents() -> Result<CommandOutput, String> {
    output(
        true,
        r#"{"result":{"agents":[{"pane_id":"w2:p1","cwd":"/wrong"},{"pane_id":"w2:p8","cwd":"/hosted checkout"}]}}"#,
        "",
    )
}
fn seat() -> local_sessions::HerdrSeat {
    local_sessions::HerdrSeat {
        project: "trantor".into(),
        agent: "orch".into(),
        surface: "w2:p8".into(),
        kind: "orch".into(),
    }
}
fn prompt() -> Value {
    json!({"id":42,"project":"trantor","kind":"crew","action":"up","seats":["glm"],"cwd":"/phone-controlled"})
}

#[test]
fn builds_only_action_and_validated_arguments() {
    assert_eq!(argv(&prompt()).unwrap(), ["up", "glm"]);
    assert_eq!(
        argv(&json!({"action":"down","seats":[]})).unwrap(),
        ["down"]
    );
    assert_eq!(
        argv(&json!({"action":"down","seats":["glm","codex-4"]})).unwrap(),
        ["down", "glm", "codex-4"]
    );
    assert_eq!(
        argv(&json!({"action":"swap","from":"glm","to":"codex:gpt-5.4"})).unwrap(),
        ["swap", "glm", "codex:gpt-5.4"]
    );
    assert!(valid_spec("glm:org/model_v2.0-test"));
    assert!(valid_spec(&format!(
        "a{}:{}",
        "b".repeat(30),
        "m".repeat(80)
    )));
    assert!(!valid_spec(&format!("a{}", "b".repeat(31))));
    assert!(!valid_spec(&format!("glm:{}", "m".repeat(81))));
}

#[tokio::test]
async fn refuses_invalid_actions_specs_and_claude_before_any_command() {
    let mut invalid = vec![
        json!({"action":"delete","seats":["glm"]}),
        json!({"action":"up"}),
        json!({"action":"down","seats":"glm"}),
        json!({"action":"up","seats":vec!["glm"; 7]}),
        json!({"action":"swap","from":"glm"}),
    ];
    for spec in [
        "",
        "claude",
        "claude:opus",
        "claude-2",
        "--all",
        "-glm",
        "GLM",
        "1glm",
        "glm;id",
        "glm\n",
        "glm:x y",
        "glm:$(id)",
        "glm:",
        "glm:x:y",
        "églm",
    ] {
        invalid.push(json!({"action":"up","seats":[spec]}));
        invalid.push(json!({"action":"swap","from":spec,"to":"glm"}));
        invalid.push(json!({"action":"swap","from":"glm","to":spec}));
    }
    let runner = FakeRunner::new(vec![]);
    for p in invalid {
        assert_eq!(
            deliver(&p, &seat(), &AtomicBool::new(true), &runner).await["outcome"],
            "failed",
            "{p}"
        );
    }
    assert!(runner.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn uses_only_matching_herdr_pane_checkout_and_maps_exit_status() {
    for success in [true, false] {
        let runner = FakeRunner::new(vec![
            agents(),
            output(success, "\x1b[32mstarted\x1b[0m", "\nerr"),
        ]);
        let result = deliver(&prompt(), &seat(), &AtomicBool::new(true), &runner).await;
        assert_eq!(result["outcome"], if success { "done" } else { "failed" });
        assert_eq!(result["output"], "started\nerr");
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls[0].0, "herdr");
        assert_eq!(calls[0].1, ["agent", "list"]);
        assert_eq!(
            calls[1],
            (
                "trantor".into(),
                vec!["up".into(), "glm".into()],
                Some(PathBuf::from("/hosted checkout")),
                Duration::from_secs(240)
            )
        );
    }
}

#[tokio::test]
async fn missing_or_relative_checkout_never_runs_trantor() {
    for raw in [
        "invalid",
        r#"{"result":{"agents":[]}}"#,
        r#"{"result":{"agents":[{"pane_id":"other","cwd":"/wrong"}]}}"#,
        r#"{"result":{"agents":[{"pane_id":"w2:p8","cwd":"relative"}]}}"#,
        r#"{"result":{"agents":[{"pane_id":"w2:p8"}]}}"#,
    ] {
        let runner = FakeRunner::new(vec![output(true, raw, "")]);
        let result = deliver(&prompt(), &seat(), &AtomicBool::new(true), &runner).await;
        assert_eq!(result, failure(MISSING_CHECKOUT));
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn never_claims_unhosted_and_never_executes_unclaimed_commands() {
    let runner = FakeRunner::new(vec![]);
    let hub = FakeHub::new(vec![]);
    let on = AtomicBool::new(true);
    let runner = &runner;
    let on = &on;
    let result = hosted_claim(
        &hub,
        "mac",
        "elsewhere",
        json!(42),
        &on,
        &[seat()],
        |p, s| async move { deliver(&p, &s, on, runner).await },
    )
    .await
    .unwrap();
    assert!(result.is_none());
    assert!(hub.requests.lock().unwrap().is_empty());
    let hub = FakeHub::new(vec![(409, json!({}))]);
    let result = hosted_claim(
        &hub,
        "mac",
        "trantor",
        json!(42),
        &on,
        &[seat()],
        |p, s| async move { deliver(&p, &s, on, runner).await },
    )
    .await
    .unwrap();
    assert!(result.is_none());
    assert!(runner.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn claimed_crew_ack_carries_id_outcome_and_output() {
    for reply in [
        output(true, "ok", ""),
        output(false, "", "failure"),
        Err("Crew command timed out after 240 seconds".into()),
    ] {
        let runner = FakeRunner::new(vec![agents(), reply]);
        let hub = FakeHub::new(vec![
            (200, json!({"prompt":prompt()})),
            (200, json!({"ok":true})),
        ]);
        let on = AtomicBool::new(true);
        let runner = &runner;
        let on = &on;
        let result = hosted_claim(
            &hub,
            "mac",
            "trantor",
            json!(42),
            &on,
            &[seat()],
            |p, s| async move { deliver(&p, &s, on, runner).await },
        )
        .await
        .unwrap()
        .unwrap();
        let expected = if result["output"] == "ok" {
            "done"
        } else {
            "failed"
        };
        assert_eq!(result["outcome"], expected);
        assert_eq!(result["id"], 42);
        ack(&hub, result.clone()).await.unwrap();
        let requests = hub.requests.lock().unwrap();
        assert_eq!(requests[0].0, "/session/prompt/claim");
        assert_eq!(requests[1], ("/session/prompt/ack".into(), Some(result)));
    }
}

#[tokio::test]
async fn off_switch_or_lost_host_stops_execution_and_roster() {
    let runner = FakeRunner::new(vec![]);
    let off = AtomicBool::new(false);
    assert_eq!(
        deliver(&prompt(), &seat(), &off, &runner).await["outcome"],
        "failed"
    );
    assert!(sample_roster(&runner, &off).await.unwrap().is_none());
    let hub = FakeHub::new(vec![]);
    publish_roster(&hub, json!({}), &off).await.unwrap();
    runner.hosted.store(false, Ordering::SeqCst);
    assert_eq!(
        deliver(&prompt(), &seat(), &AtomicBool::new(true), &runner).await["outcome"],
        "failed"
    );
    assert!(runner.calls.lock().unwrap().is_empty());
    assert!(hub.requests.lock().unwrap().is_empty());
}

#[test]
fn output_tail_strips_ansi_and_counts_unicode_characters() {
    assert_eq!(
        output_tail("\x1b]0;title\x07a\x1b[31mb\x1b[0m\x1b]8;;url\x1b\\c\x1b]8;;\x1b\\"),
        "abc"
    );
    let raw = format!("prefix{}\x1b[0m", "界".repeat(2100));
    assert_eq!(output_tail(&raw), "界".repeat(2000));
}

#[tokio::test]
async fn roster_uses_provider_usage_and_hostname_and_posts_exact_payload() {
    let raw = json!([
        {"provider":"claude","label":"Claude","kind":"windows","state":"connected"},
        {"provider":"codex","label":"Codex","kind":"windows","usage":{"plan":"Pro"},"state":"connected"},
        {"provider":"custom","label":"Custom","kind":"api","state":"unknown"},
        {"provider":"glm","label":"GLM","kind":"quota","usage":{"plan":"API monthly"},"state":"over_quota"}
    ]).to_string();
    let runner = FakeRunner::new(vec![output(true, "test-mac\n", ""), output(true, &raw, "")]);
    let on = AtomicBool::new(true);
    let payload = sample_roster(&runner, &on).await.unwrap().unwrap();
    assert_eq!(
        payload,
        json!({"machine":"test-mac","seats":[
            {"agent":"codex","label":"Codex","plan":"Pro","metered":false,"available":true},
            {"agent":"custom","label":"Custom","plan":"api","metered":true,"available":false},
            {"agent":"glm","label":"GLM","plan":"API monthly","metered":true,"available":false}
        ]})
    );
    assert_eq!(
        runner.calls.lock().unwrap()[1].1,
        ["provider", "status", "--json"]
    );
    let hub = FakeHub::new(vec![(200, json!({"ok":true}))]);
    publish_roster(&hub, payload.clone(), &on).await.unwrap();
    assert_eq!(
        hub.requests.lock().unwrap()[0],
        ("/crew/roster".into(), Some(payload))
    );
    assert_eq!(ROSTER_INTERVAL, Duration::from_secs(600));
}

#[tokio::test]
async fn project_mutex_serializes_same_project_without_blocking_another() {
    let mut locks = HashMap::new();
    let first = project_lock(&mut locks, "trantor");
    let second = project_lock(&mut locks, "trantor");
    let other = project_lock(&mut locks, "other");
    let guard = first.lock().await;
    assert!(second.try_lock().is_err());
    assert!(other.try_lock().is_ok());
    drop(guard);
    assert!(second.try_lock().is_ok());
}

#[tokio::test]
async fn real_runner_captures_both_streams_and_kills_on_timeout() {
    let mut command = crate::identity_env::command("/usr/bin/python3");
    command.args([
        "-c",
        "import sys; print('out'); print('err', file=sys.stderr); sys.exit(7)",
    ]);
    let result = run_command(command, Duration::from_secs(10)).await.unwrap();
    assert!(!result.success);
    assert_eq!(result.stdout, "out\n");
    assert_eq!(result.stderr, "err\n");
    let dir = std::env::current_dir().unwrap().join(".agent-bus-out");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("crew-timeout-{}.pid", std::process::id()));
    let mut command = crate::identity_env::command("/usr/bin/python3");
    command
        .args([
            "-c",
            "import os,sys,time; open(sys.argv[1],'w').write(str(os.getpid())); time.sleep(30)",
        ])
        .arg(&path);
    let result = run_command(command, Duration::from_secs(2)).await;
    assert!(result.err().unwrap().contains("timed out"));
    let pid: i32 = std::fs::read_to_string(&path).unwrap().parse().unwrap();
    let mut exited = false;
    for _ in 0..50 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            exited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    std::fs::remove_file(path).unwrap();
    assert!(exited, "timed-out process still alive");
}

#[tokio::test]
async fn rechecks_host_and_switch_after_resolving_checkout() {
    struct GateRunner<'a> {
        fake: FakeRunner,
        on: &'a AtomicBool,
        disable: bool,
    }
    impl Runner for GateRunner<'_> {
        fn hosts(&self, _: &local_sessions::HerdrSeat) -> bool {
            self.disable || self.fake.calls.lock().unwrap().is_empty()
        }
        async fn run(
            &self,
            program: &str,
            args: &[String],
            cwd: Option<&Path>,
            timeout: Duration,
        ) -> Result<CommandOutput, String> {
            let result = self.fake.run(program, args, cwd, timeout).await;
            if self.disable {
                self.on.store(false, Ordering::SeqCst);
            }
            result
        }
    }
    for disable in [true, false] {
        let on = AtomicBool::new(true);
        let runner = GateRunner {
            fake: FakeRunner::new(vec![agents()]),
            on: &on,
            disable,
        };
        let result = deliver(&prompt(), &seat(), &on, &runner).await;
        assert_eq!(result["outcome"], "failed");
        assert_eq!(runner.fake.calls.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn crew_claim_rejects_wrong_identity_and_project_without_commands() {
    for (field, value) in [("id", json!(43)), ("project", json!("other"))] {
        let mut claimed = prompt();
        claimed[field] = value;
        let hub = FakeHub::new(vec![(200, json!({"prompt":claimed}))]);
        let result = claim_and_execute(
            &hub,
            "mac",
            "trantor",
            json!(42),
            &AtomicBool::new(true),
            |_| async {
                panic!("invalid claim executed");
            },
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result["outcome"], "failed");
        assert!(result["output"]
            .as_str()
            .unwrap()
            .contains("invalid prompt"));
    }
}
