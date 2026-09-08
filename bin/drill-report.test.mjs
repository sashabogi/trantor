import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DrillReport } from "./drill-report.mjs";
import { CARD_STEPS } from "./drill-surface.mjs";
import { appVerdict, startDrillHub, stopChild } from "./drill-seams.mjs";
import { signedGet, signedPost } from "../hooks/lib/api.mjs";

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
