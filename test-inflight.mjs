#!/usr/bin/env node
// trantor in-flight sub-agent card tests — Bug 2 fix (2026-06-23: "everything's instantly DONE").
//
// Before this fix, every auto-created cc-subagent card was born status:"done" (SubagentStop posts the
// card already finished) so the board NEVER showed sub-agent work IN PROGRESS. The fix adds a PreToolUse
// hook (hooks/subagent-start.mjs) that posts a "doing" card (no cost) when a sub-agent is dispatched; the
// hub's title-fingerprint dedup pairs it with the SubagentStop "done" post and flips the SAME card.
//
// These tests spin up the REAL hub.mjs (matching test-balances.mjs's pattern: temp data dir, fixed port)
// and exercise the live POST /task dedup path. They assert:
//   1. a start post creates a "doing" card, count 1,
//   2. the matching stop post flips it to "done", count STILL 1 (no double-count), cost recorded,
//   3. legacy: a stop for a never-started title creates a "done" card count 1; a 2nd identical stop → 2,
//   4. parallel: two starts (same title) → count 2, doing; one stop → still doing; second stop → done.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 47821;
const base = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "trantor-inflight-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PROJ = "inflightproj";
const start = (title, agentType) => post("/task", { project: PROJ, title, status: "doing", agentType, source: "cc-subagent", costKind: "subagent-notional", phase: "sub-agents", by: "host:" + PROJ });
const stop = (title, costUsd, tokens) => post("/task", { project: PROJ, title, status: "done", source: "cc-subagent", costKind: "subagent-notional", costUsd, tokens, by: "host:" + PROJ });
// native SubagentStart enrich (attach agent_id + parent to the in-flight card) and SubagentStop keyed by agent_id
const enrich = (agentType, agentId, parent) => post("/task", { project: PROJ, enrich: true, agentType, agentId, parent, source: "cc-subagent", costKind: "subagent-notional", by: "host:" + PROJ });
const stopById = (title, agentId, agentType, costUsd, tokens) => post("/task", { project: PROJ, title, status: "done", agentId, agentType, source: "cc-subagent", costKind: "subagent-notional", costUsd, tokens, by: "host:" + PROJ });
const cardFor = async (title) => (await get("/tasks")).tasks.find(t => t.source === "cc-subagent" && t.title === title);
const cardById = async (agentId) => (await get("/tasks")).tasks.find(t => t.source === "cc-subagent" && t._aid === agentId);

console.log("# trantor in-flight sub-agent card tests");

// refuse to run against a squatter on the test port (would serve stale code)
try { await fetch(`${base}/health`, { signal: AbortSignal.timeout(700) }); console.error(`✗ something already listening on :${PORT} — kill it first`); process.exit(2); } catch {}

const hub = spawn("node", [join(ROOT, "hub.mjs")], { env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(PORT), PORT: String(PORT) }, stdio: ["ignore", "ignore", "pipe"] });
let herr = ""; hub.stderr.on("data", d => herr += d);
await sleep(800);

try {
  // 1. start → doing, count 1
  const T1 = "general-purpose: build the widget";
  await start(T1);
  let c = await cardFor(T1);
  ok("start post creates a card", !!c);
  ok("start card status is doing", c?.status === "doing", `(got "${c?.status}")`);
  ok("start card count is 1", c?.count === 1, `(got ${c?.count})`);
  ok("start card has no cost yet", c?.costUsd == null, `(got ${c?.costUsd})`);

  // 2. stop (same title, with cost) flips SAME card to done, count STILL 1, cost recorded
  await stop(T1, 0.42, { input: 1000, output: 500, cacheWrite: 0, cacheRead: 2000 });
  c = await cardFor(T1);
  ok("stop flips card to done", c?.status === "done", `(got "${c?.status}")`);
  ok("no double-count: count still 1", c?.count === 1, `(got ${c?.count})`);
  ok("cost recorded on completion", c?.costUsd === 0.42, `(got ${c?.costUsd})`);
  ok("tokens recorded on completion", c?.tokens?.input === 1000 && c?.tokens?.cacheRead === 2000);
  // exactly one card for this title (start + stop folded into one)
  const all1 = (await get("/tasks")).tasks.filter(t => t.source === "cc-subagent" && t.title === T1);
  ok("start + stop folded into ONE card", all1.length === 1, `(got ${all1.length})`);

  // 3. legacy: stop for a NEVER-started title → done, count 1; 2nd identical stop → count 2
  const T2 = "code-review-specialist: review the PR";
  await stop(T2, 1.00, { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 });
  c = await cardFor(T2);
  ok("legacy stop (no prior start) creates done card", c?.status === "done", `(got "${c?.status}")`);
  ok("legacy first stop count 1", c?.count === 1, `(got ${c?.count})`);
  await stop(T2, 1.00, { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 });
  c = await cardFor(T2);
  ok("legacy second stop bumps count to 2 (old behavior preserved)", c?.count === 2, `(got ${c?.count})`);
  ok("legacy stays done", c?.status === "done");

  // 4. parallel: two starts (same title) → count 2, doing; one stop → still doing; second stop → done
  const T3 = "general-purpose: parallel shard";
  await start(T3); await start(T3);
  c = await cardFor(T3);
  ok("two parallel starts → count 2", c?.count === 2, `(got ${c?.count})`);
  ok("two parallel starts → doing", c?.status === "doing", `(got "${c?.status}")`);
  await stop(T3, 0.10, { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 });
  c = await cardFor(T3);
  ok("one of two stops → still doing (1 in flight)", c?.status === "doing", `(got "${c?.status}")`);
  ok("count unchanged by stop (still 2)", c?.count === 2, `(got ${c?.count})`);
  await stop(T3, 0.10, { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 });
  c = await cardFor(T3);
  ok("second stop → done (no more in flight)", c?.status === "done", `(got "${c?.status}")`);
  ok("parallel cost accumulated across both stops", Math.abs((c?.costUsd || 0) - 0.20) < 1e-9, `(got ${c?.costUsd})`);

  // 5. native agent_id pairing (SubagentStart enrich → SubagentStop by id). The whole point: start & stop
  //    can carry DIFFERENT titles (SubagentStart has no prompt) yet still fold into ONE card via agent_id.
  const T5 = "general-purpose: fix the parser";
  await start(T5, "general-purpose");                         // PreToolUse create (good title)
  await enrich("general-purpose", "aid-100", "sess-parent");  // SubagentStart spawns → stamp agent_id + parent
  let d = await cardById("aid-100");
  ok("enrich stamps agent_id onto the existing create card (no new card)", !!d && d.title === T5, `(got "${d?.title}")`);
  ok("enrich stamps parent for nesting", d?.parent === "sess-parent", `(got "${d?.parent}")`);
  ok("enriched card still exactly one for this title", (await get("/tasks")).tasks.filter(t => t.source === "cc-subagent" && t.title === T5).length === 1);
  // stop keyed by agent_id with a DIFFERENT (bare) title → must pair the SAME card, not orphan a new one
  await stopById("general-purpose", "aid-100", "general-purpose", 0.33, { input: 5, output: 5, cacheWrite: 0, cacheRead: 0 });
  d = await cardById("aid-100");
  ok("stop pairs by agent_id despite title mismatch (no orphan)", d?.status === "done", `(got "${d?.status}")`);
  ok("agent_id pairing kept the good create title", d?.title === T5, `(got "${d?.title}")`);
  ok("cost recorded via agent_id pairing", d?.costUsd === 0.33, `(got ${d?.costUsd})`);
  ok("no orphan bare-title card created", !(await get("/tasks")).tasks.some(t => t.source === "cc-subagent" && t.title === "general-purpose"), "(a 'general-purpose' orphan appeared)");

  // 6. enrich with NO prior create card → creates one keyed by agent_id (spawn w/o matching PreToolUse)
  await enrich("code-reviewer", "aid-200", "sess-parent");
  d = await cardById("aid-200");
  ok("enrich-without-create makes a doing card keyed by agent_id", d?.status === "doing" && d?.title === "code-reviewer");
  ok("idempotent: repeat enrich for same agent_id makes no 2nd card", (await enrich("code-reviewer", "aid-200", "sess-parent"), (await get("/tasks")).tasks.filter(t => t._aid === "aid-200").length === 1));
  await stopById("code-reviewer: reviewed the PR", "aid-200", "code-reviewer", 0.05, { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 });
  d = await cardById("aid-200");
  ok("stop flips the id-created card to done", d?.status === "done", `(got "${d?.status}")`);
  ok("bare fallback title upgraded to the completion's real title", d?.title === "code-reviewer: reviewed the PR", `(got "${d?.title}")`);
} catch (e) {
  fail++; console.log("  ✗ threw:", e?.message || e, herr ? `\n  hub stderr: ${herr}` : "");
} finally {
  hub.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
