import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, createConnection } from "node:net";
import { DrillReport } from "./drill-report.mjs";
import { CARD_STEPS, findHandoff } from "./drill-surface.mjs";
import { appVerdict, startDrillHub, stopChild, checkSocketHome } from "./drill-seams.mjs";
import { signedGet, signedPost } from "../hooks/lib/api.mjs";

test("S4 waits for the hook ledger when relay_handoff arrives first", () => {
  const world = mkdtempSync(join(import.meta.dirname, "..", ".agent-bus-out", "ledger-"));
  try {
    assert.equal(findHandoff(join(world, "missing"), "trantor"), null);
    writeFileSync(join(world, "trantor-100.json"), JSON.stringify({ summary: "tool handoff" }));
    writeFileSync(join(world, "trantor-101.json"), "{");
    writeFileSync(join(world, "trantor-102.json"), JSON.stringify({ states: [] }));
    writeFileSync(join(world, "other-100.json"), JSON.stringify({ states: [{ state: "written" }] }));
    assert.equal(findHandoff(world, "trantor"), null);
    const ledger = join(world, "trantor-103.json");
    writeFileSync(ledger, JSON.stringify({ states: [{ state: "written" }] }));
    assert.equal(findHandoff(world, "trantor"), ledger);
    writeFileSync(ledger, JSON.stringify({ states: [{ state: "written" }, { state: "claimed" }, { state: "recapped" }] }));
    assert.equal(findHandoff(world, "trantor"), ledger);
  } finally { rmSync(world, { recursive: true, force: true }); }
});

test("signed closer on an enforce hub: complete evidence closes, partial/failure/skip never does", async () => {
  const out = join(import.meta.dirname, "..", ".agent-bus-out");
  mkdirSync(out, { recursive: true });
  const world = mkdtempSync(join(out, "closer-test-"));
  const bus = join(world, "bus");
  const hub = await startDrillHub(world, bus);
  const saved = { ...process.env };
  Object.assign(process.env, { RELAY_URL: hub.url, AGENT_BUS_DIR: bus, RELAY_SESSION: "drill:trantor", RELAY_PROJECT: "trantor" });
  const project = "trantor", session = "drill:trantor";
  const path = join(world, "drill-result.json");
  try {
    const create = await signedPost("/task", { project, by: session, title: "closer test", status: "testing" });
    assert.equal(create.ok, true, JSON.stringify(create));
    const id = create.json.task.id;
    const report = new DrillReport({ [id]: { steps: ["one", "two"], autoClose: true } }, path, { project, session });
    report.record("one", "pass", "first assertion", "real evidence A");
    await report.closePassed();
    assert.equal(report.results()[id].status, "fail");
    assert.equal((await signedGet("/tasks?project=trantor")).json.tasks[0].status, "testing");
    report.complete("one");
    report.record("two", "pass", "second assertion", "real evidence B");
    report.complete("two");
    assert.equal(await report.closePassed(), true);
    const card = (await signedGet("/tasks?project=trantor")).json.tasks[0];
    assert.equal(card.status, "done");
    assert.equal(card.workedBy, session);
    assert.match(card.log.at(-1).text, /^Drill: trantor drill PASS/);   // #6452: the closer's note IS the drill line the hub gate requires
    assert.match(card.log.at(-1).text, /real evidence A/);
    assert.match(card.log.at(-1).text, /real evidence B/);
    assert.equal(JSON.parse(readFileSync(path, "utf8"))[id].closure, "done");
    const notes = card.log.length;
    await report.closePassed();
    assert.equal((await signedGet("/tasks?project=trantor")).json.tasks[0].log.length, notes);
    const unsigned = await fetch(`${hub.url}/task/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status: "testing", by: session }) });
    assert.equal(unsigned.status, 401);

    for (const status of ["fail", "skip"]) {
      const created = await signedPost("/task", { project, by: session, title: status, status: "testing" });
      const blockedId = created.json.task.id;
      const blocked = new DrillReport({ [blockedId]: { steps: ["step"], autoClose: true } }, path, { project, session });
      blocked.record("step", "pass", "partial success");
      blocked.record("step", status, "missing proof");
      blocked.complete("step");
      await blocked.closePassed();
      assert.equal(blocked.results()[blockedId].status, status);
      assert.equal((await signedGet("/tasks?project=trantor")).json.tasks.find(row => row.id === blockedId).status, "testing");
    }
    const missing = new DrillReport({ 999999: { steps: ["step"], autoClose: true } }, path, { project, session });
    missing.record("step", "pass", "proof");
    missing.complete("step");
    assert.equal(await missing.closePassed(), false);
    assert.match(missing.results()[999999].closure, /failed: hub 404/);
    assert.equal(missing.exitCode(), 1);
    const fresh = new DrillReport({ [id]: { steps: ["one"], autoClose: true } }, path, { project, session });
    assert.equal(fresh.results()[id].status, "fail", "a rerun cannot inherit old PASS evidence");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await stopChild(hub.child);
    rmSync(world, { recursive: true, force: true });
  }
});

test("app proof requires every leg and rejects skipped key targets", () => {
  assert.deepEqual(CARD_STEPS[6317].steps, ["S6-key-post", "S6-key-throw"]);
  assert.equal(appVerdict("ask", "ask-drill PASS:"), false);
  assert.equal(appVerdict("ask", "ask-drill open PASS\nask-drill cold PASS\nask-drill PASS:"), true);
  const key = [1, 2, 3].map(pass => `key-drill pass=${pass} posted keyDown+keyUp`).join("\n") + "\nkey-drill verdict exit=0";
  assert.equal(appVerdict("key-post", key), true);
  assert.equal(appVerdict("key-post", key + "\npass=2 skipped"), false);
  assert.equal(appVerdict("key-throw", key), false);
  assert.equal(appVerdict("key-throw", key, "TaoObjcExceptionDrill"), true);
  assert.equal(appVerdict("handoff", "handoff-drill PASS:\nhandoff-drill verdict exit=3"), false);
});

test("manual probes remain SKIP even when the runner stops before reaching them", () => {
  const world = mkdtempSync(join(import.meta.dirname, "..", ".agent-bus-out", "skip-"));
  try {
    const report = new DrillReport(CARD_STEPS, join(world, "result.json"), { project: "trantor", session: "drill:trantor" });
    assert.deepEqual(Object.keys(CARD_STEPS).filter(id => CARD_STEPS[id].autoClose), ["6481", "6667", "6668"]);
    for (const id of [6317, 6533, 6587, 6483]) {
      assert.equal(report.results()[id].status, "skip");
      assert.equal(report.results()[id].closure, "not attempted");
      assert.match(report.results()[id].evidence.join(" "), id === 6587 ? /live duty probe/ : /covered by in-app Drill Mode/);
    }
    assert.equal(report.exitCode(), 1, "unrun seams still fail");
    for (const { steps, recipe } of Object.values(CARD_STEPS)) {
      if (recipe) continue;
      for (const step of steps) {
        report.record(step, step === "S5" ? "skip" : "pass", step === "S5" ? "interactive Terminal takeover probe" : "seam proof");
        report.complete(step);
      }
    }
    assert.equal(report.exitCode(), 0, "passing seams plus manual SKIPs exit zero");
    report.record("S4", "fail", "ledger missing");
    assert.equal(report.exitCode(), 1, "a real seam failure remains fatal");
  } finally { rmSync(world, { recursive: true, force: true }); }
});

test("short drill HOME connects through the native socket symlink; old staging is rejected", async () => {
  const world = mkdtempSync(`${join(import.meta.dirname, "..", ".agent-bus-out")}/`);
  const server = createServer(socket => socket.end("connected"));
  try {
    const path = checkSocketHome(world);
    assert.throws(() => checkSocketHome(join(world, "x".repeat(108))), /too long/);
    mkdirSync(join(world, ".config", "herdr"), { recursive: true });
    const target = join(world, "s");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(target, resolve); });
    symlinkSync(target, path);
    const proof = await new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("error", reject);
      socket.once("data", data => resolve(data.toString()));
    });
    assert.equal(proof, "connected");
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(world, { recursive: true, force: true });
  }
});
