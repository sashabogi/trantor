import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { claimHandoff, recapHandoff, hasAssistantReply, loadPendingHandoff, completeHandoffRecap, recapStampPath } from "../../hooks/lib/handoff-claims.mjs";
import { drillEnv } from "../drill-env.mjs";

const out = resolve(".agent-bus-out");
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(out, "claims-"));
const transcript = join(dir, "session.jsonl");
const session = { session_id: "successor", transcript_path: transcript };
const seed = { id: "project-100", consumed: false, summary: "## READ FIRST\n- context.md", states: [{ state: "written" }] };
const file = join(dir, "project-100.json");
const row = text => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
const reset = () => { writeFileSync(file, JSON.stringify(seed)); writeFileSync(transcript, ""); };
const read = () => JSON.parse(readFileSync(file, "utf8"));
let count = 0;
function test(name, run) { run(); count++; console.log(`PASS ${name}`); }
try {
  test("claim remains unconsumed; a dead claimant is re-presented at TTL", () => {
    reset();
    const first = loadPendingHandoff("project", { dir, freshSession: session, now: 100 });
    assert.equal(first.consumed, false);
    assert.equal(loadPendingHandoff("project", { dir, freshSession: { ...session, session_id: "other" }, now: 699 }), null);
    const next = loadPendingHandoff("project", { dir, freshSession: { ...session, session_id: "other" }, now: 700 });
    assert.equal(next.claim.session_id, "other");
    assert.equal(completeHandoffRecap({ dir, sessionId: session.session_id, transcriptPath: transcript, now: 701 }).recapped, false);
  });
  test("a reply without reads keeps the claim and stamp", () => {
    reset(); loadPendingHandoff("project", { dir, freshSession: session, now: 100 });
    appendFileSync(transcript, row("Taking over"));
    assert.deepEqual(completeHandoffRecap({ dir, sessionId: session.session_id, transcriptPath: transcript }), { recapped: false, missed: ["context.md"] });
    assert.equal(read().consumed, false);
    assert.ok(existsSync(recapStampPath(dir, session.session_id)));
  });
  test("reads plus a non-empty reply consume the claimed record", () => {
    appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "context.md" } }] } }) + "\n");
    assert.equal(completeHandoffRecap({ dir, sessionId: session.session_id, transcriptPath: transcript }).recapped, true);
    assert.equal(read().consumed, true);
    assert.equal(read().states.at(-1).state, "recapped");
    assert.equal(existsSync(recapStampPath(dir, session.session_id)), false);
    assert.equal(loadPendingHandoff("project", { dir, freshSession: session, now: 1000 }), null);
  });
  test("pre-claim replies, tools, whitespace and thinking are not replies", () => {
    reset(); writeFileSync(transcript, row("old reply"));
    loadPendingHandoff("project", { dir, freshSession: session, now: 100 });
    assert.equal(completeHandoffRecap({ dir, sessionId: session.session_id, transcriptPath: transcript }).recapped, false);
    for (const content of [[], [{ type: "text", text: "  " }], [{ type: "thinking", thinking: "reasoning" }], [{ type: "tool_use", name: "Read" }]]) {
      assert.equal(hasAssistantReply(JSON.stringify({ type: "assistant", message: { content } }), 100), false);
    }
    assert.equal(hasAssistantReply(JSON.stringify({ type: "assistant", timestamp: "1970-01-01T00:00:01Z", message: { content: "old" } }), 100), false);
  });
  test("pure transitions reject wrong claim tokens and session ids", () => {
    const claim = claimHandoff(seed, session, 100, 0, "token");
    const evidence = { sessionId: session.session_id, token: "token", replied: true, missed: [] };
    assert.equal(recapHandoff(claim, { ...evidence, token: "old-token" }, 101), null);
    assert.equal(recapHandoff(claim, { ...evidence, sessionId: "stranger" }, 101), null);
    assert.equal(recapHandoff(claim, evidence, 101).consumed, true);
    assert.equal(seed.claim, undefined);
  });
  reset();
  const moduleUrl = new URL("../../hooks/lib/handoff-claims.mjs", import.meta.url).href;
  const race = () => Array.from({ length: 8 }, (_, i) => new Promise((resolveChild, reject) => {
    const code = `import { claimHandoffFile } from ${JSON.stringify(moduleUrl)}; const rec = claimHandoffFile(${JSON.stringify(file)}, { session_id: 'race-${i}', transcript_path: ${JSON.stringify(transcript)} }, 100); process.stdout.write(rec ? 'won' : 'lost');`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: drillEnv() });
    let output = ""; child.stdout.on("data", d => { output += d; });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolveChild(output) : reject(new Error(`child exited ${code}`)));
  }));
  const results = await Promise.all(race());
  test("double-claim race has exactly one winner", () => assert.equal(results.filter(r => r === "won").length, 1));
  writeFileSync(file, JSON.stringify(claimHandoff(seed, session, -1000, 0, "expired")));
  const expiredResults = await Promise.all(race());
  test("expired-claim race also has exactly one winner", () => assert.equal(expiredResults.filter(r => r === "won").length, 1));
  reset();
  await new Promise((resolveChild, reject) => {
    const code = `import { claimHandoffFile } from ${JSON.stringify(moduleUrl)}; claimHandoffFile(${JSON.stringify(file)}, { session_id: 'dies-at-boot', transcript_path: ${JSON.stringify(transcript)} }, 100); process.stdout.write('claimed'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: drillEnv() });
    child.stdout.once("data", () => child.kill("SIGKILL"));
    child.on("error", reject); child.on("exit", () => resolveChild());
  });
  test("a killed successor leaves an unconsumed handoff for the next session", () => {
    assert.equal(read().consumed, false);
    assert.equal(loadPendingHandoff("project", { dir, freshSession: session, now: 700 }).claim.session_id, session.session_id);
  });
  test("Stop hook consumes only after reads and reply", () => {
    const bus = join(dir, "bus"); mkdirSync(join(bus, "handoffs"), { recursive: true });
    const records = join(bus, "handoffs");
    writeFileSync(join(records, "project-100.json"), JSON.stringify(seed)); writeFileSync(transcript, "");
    loadPendingHandoff("project", { dir: records, freshSession: session, now: 100 });
    const stop = (active = false) => spawnSync(process.execPath, ["hooks/stop-inbox.mjs"], { encoding: "utf8", timeout: 10000,
      env: { ...drillEnv(), AGENT_BUS_DIR: bus, RELAY_URL: "http://127.0.0.1:1", RELAY_STOP_TIMEOUT_MS: "50" },
      input: JSON.stringify({ session_id: session.session_id, transcript_path: transcript, cwd: dir, stop_hook_active: active }) });
    appendFileSync(transcript, row("Taking over"));
    assert.equal(JSON.parse(stop().stdout).decision, "block");
    appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "context.md" } }] } }) + "\n");
    assert.equal(stop(true).status, 0);
    assert.equal(JSON.parse(readFileSync(join(records, "project-100.json"), "utf8")).consumed, true);
  });
  console.log(`${count} handoff claim tests passed`);
} finally { rmSync(dir, { recursive: true, force: true }); }
