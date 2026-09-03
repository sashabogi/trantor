#!/usr/bin/env node
// trantor cc-bg-agent card tests (#3624) — the CC Notification hook (hooks/agent-notify.mjs) surfaces the
// background/child-agent population (fork / `--agent` / subtask sessions) that never hits the Task-tool
// sub-agent path, so SubagentStart/Stop never see them. These fire notification_type "agent_needs_input"
// (paused, waiting on the user) and "agent_completed" (finished), carded as source:"cc-bg-agent" — DISTINCT
// from cc-subagent so they never double-count sub-agent notional cost.
//
// Spins up the REAL hub.mjs (temp data dir, fixed port) and exercises the live POST /task cc-bg-agent path:
//   1. agent_needs_input → a "blocked" card, count-of-one, distinct source,
//   2. agent_completed (same id) → flips the SAME card to "done", parent preserved,
//   3. agent_completed with no prior card → creates a "done" card,
//   4. overlap guard: an agent_id already tracked as cc-subagent → the Notification is dropped (no dupe),
//   5. parent is stamped for nesting under the spawning session's focus card.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 47822;
const base = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "trantor-notify-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PROJ = "notifyproj";
// mirror what hooks/agent-notify.mjs POSTs
const notify = (nt, agentId, title, parent, agentType = "agent") =>
  post("/task", { project: PROJ, source: "cc-bg-agent", notificationType: nt, title, agentId, agentType, parent, by: "host:" + PROJ, phase: "sub-agents" });
const bgCardById = async (agentId) => (await get("/tasks")).tasks.find(t => t.source === "cc-bg-agent" && t._aid === agentId);
// mirror a cc-subagent enrich (SubagentStart) so we can test the overlap guard
const enrich = (agentType, agentId) => post("/task", { project: PROJ, enrich: true, agentType, agentId, source: "cc-subagent", costKind: "subagent-notional", by: "host:" + PROJ });

console.log("# trantor cc-bg-agent (Notification) card tests");

try { await fetch(`${base}/health`, { signal: AbortSignal.timeout(700) }); console.error(`✗ something already listening on :${PORT} — kill it first`); process.exit(2); } catch {}

const hub = spawn("node", [join(ROOT, "hub.mjs")], { env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(PORT), PORT: String(PORT) }, stdio: ["ignore", "ignore", "pipe"] });
let herr = ""; hub.stderr.on("data", d => herr += d);
await sleep(800);

try {
  // 1. agent_needs_input → blocked card, distinct source
  await notify("agent_needs_input", "bg-1", "agent: awaiting confirmation", "sess-parent");
  let c = await bgCardById("bg-1");
  ok("needs_input creates a card", !!c);
  ok("needs_input card status is blocked", c?.status === "blocked", `(got "${c?.status}")`);
  ok("card source is cc-bg-agent (distinct population)", c?.source === "cc-bg-agent", `(got "${c?.source}")`);
  ok("parent stamped for nesting", c?.parent === "sess-parent", `(got "${c?.parent}")`);
  ok("cc-bg-agent card carries NO notional cost", c?.costUsd == null && c?.costKind === "", `(costUsd=${c?.costUsd} costKind="${c?.costKind}")`);

  // 2. agent_completed (same id) → flips SAME card to done
  await notify("agent_completed", "bg-1", "agent: finished the task", "sess-parent");
  c = await bgCardById("bg-1");
  ok("completed flips the SAME card to done", c?.status === "done", `(got "${c?.status}")`);
  ok("no dupe: exactly one card for bg-1", (await get("/tasks")).tasks.filter(t => t.source === "cc-bg-agent" && t._aid === "bg-1").length === 1);
  ok("parent preserved across the flip", c?.parent === "sess-parent");

  // 3. agent_completed with no prior needs_input → creates a done card
  await notify("agent_completed", "bg-2", "agent: one-shot done", "sess-parent");
  c = await bgCardById("bg-2");
  ok("bare agent_completed creates a done card", c?.status === "done", `(got "${c?.status}")`);

  // 4. overlap guard — an agent already carded as cc-subagent must NOT get a second cc-bg-agent card
  await enrich("general-purpose", "shared-99");         // cc-subagent card keyed by agent_id shared-99
  await notify("agent_completed", "shared-99", "agent: dup", "sess-parent");
  ok("Notification for an agent already tracked as cc-subagent is dropped", !(await bgCardById("shared-99")), "(a cc-bg-agent dupe appeared)");
  ok("the cc-subagent card for that id is untouched", (await get("/tasks")).tasks.some(t => t.source === "cc-subagent" && t._aid === "shared-99"));

  // 5. non-agent notification types are never sent by the hook, but assert the hub only acts on the two we map
  await notify("permission_prompt", "bg-3", "agent: perm", "sess-parent");
  c = await bgCardById("bg-3");
  ok("an unmapped type falls through to a plain 'doing' card (hook never sends these, hub is defensive)", c?.status === "doing", `(got "${c?.status}")`);
} catch (e) {
  fail++; console.log("  ✗ threw:", e?.message || e, herr ? `\n  hub stderr: ${herr}` : "");
} finally {
  hub.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
