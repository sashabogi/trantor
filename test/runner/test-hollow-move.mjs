#!/usr/bin/env node
// #7750 drill: the seat-side hollow-move check in mcp.mjs's relay_task_move — a testing/done move
// from a clean worktree with no ticks and no test command lands but is prefixed HOLLOW: and the
// assigner gets one bus line; a real diff, an untracked file, a tick + test command, or a declared
// no-code outcome is NOT flagged. #7754: a note without `verified at <sha>` is flagged on its own.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor hollow-move drill (#7750)");

const W = mkdtempSync(join(tmpdir(), "trantor-hollow-"));
mkdirSync(join(W, ".agent-bus"), { recursive: true });
const REPO = join(W, "repo");
mkdirSync(REPO);
const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
git(["init", "-q", "-b", "main"]);
// lib/a.mjs imported by two files, plus a config file graft never indexes
mkdirSync(join(REPO, "lib"));
writeFileSync(join(REPO, "lib", "a.mjs"), "export const a = 1;\n");
writeFileSync(join(REPO, "b.mjs"), 'import { a } from "./lib/a.mjs";\nexport const b = a + 1;\n');
writeFileSync(join(REPO, "c.mjs"), 'import { a } from "./lib/a.mjs";\nexport const c = a + 2;\n');
writeFileSync(join(REPO, "package.json"), '{"name":"hollow-fixture","type":"module"}\n');
git(["add", "-A"]);
const commit = (msg) => { git(["add", "-A"]); git(["-c", "user.name=drill", "-c", "user.email=drill@x", "commit", "-q", "-m", msg]); };
commit("init");
const SHA = git(["rev-parse", "HEAD"]);
const HAS_GRAFT = spawnSync("graft", ["build", REPO], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).status === 0;
if (HAS_GRAFT) commit("graft ignore files");   // graft build drops .gitignore/.ignore; keep them out of the drill diffs
else console.log("  (graft not on PATH: the blast count drills are skipped, only the fail-open path is checked)");

const PORT = 47877, HUB = `http://127.0.0.1:${PORT}`;
const SESSION = "seat:hollowproj", ORCH = "orch:hollowproj";
const hub = spawn("node", [join(ROOT, "hub.mjs")], {
  env: { ...drillEnv(), RELAY_DATA_DIR: W, HOME: W, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
hub._stderr = "";
hub.stderr.on("data", d => { hub._stderr += String(d); });
for (let i = 0; i < 50; i++) {
  if (hub.exitCode !== null) { console.error("hub exited early:", hub._stderr); process.exit(1); }
  try { const r = await fetch(`${HUB}/health`); if (r.ok) break; } catch {}
  await sleep(100);
}

// the REAL MCP server, cwd = the fake seat worktree; extra env lets a drill point GRAFT_BIN at an
// absent or slow binary without touching the seat under test
async function spawnMcp(session, extraEnv = {}) {
  const mcp = spawn("node", [join(ROOT, "mcp.mjs")], {
    cwd: REPO,
    env: { ...drillEnv(), HOME: W, AGENT_BUS_DIR: join(W, ".agent-bus"), RELAY_URL: HUB,
      RELAY_SESSION: session, RELAY_PROJECT: "hollowproj", RELAY_HEARTBEAT_MS: "600000", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  mcp.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  });
  let rpcId = 0;
  function rpc(method, params, timeoutMs = 30000) {
    const id = ++rpcId;
    const p = new Promise((res, rej) => {
      pending.set(id, res);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); } }, timeoutMs);
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drill", version: "0" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const call = (name, args, timeoutMs) => rpc("tools/call", { name, arguments: args }, timeoutMs);
  return { call, kill: () => mcp.kill() };
}
const mcp = await spawnMcp(SESSION);
const call = mcp.call;
const text = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r?.result ?? r?.error ?? {});
const getCard = async (id) => {
  const r = await fetch(`${HUB}/tasks?project=hollowproj`);
  return (await r.json()).tasks.find(t => t.id === id);
};
const lastNote = (card) => card?.log?.[card.log.length - 1]?.text || "";
const addCard = async (title, checklist) => {
  const args = { title };
  if (checklist) args.checklist = checklist;
  const m = text(await call("relay_task_add", args)).match(/card #(\d+)/);
  return Number(m?.[1] || 0);
};
const take = (id) => call("relay_task_move", { id, status: "doing" });

// ---- 1. clean worktree + weak note -> HOLLOW, assigner told on the bus -------------------------
{
  // created directly on the hub so the ASSIGNER is the orchestrator, not the seat itself
  const r = await fetch(`${HUB}/task`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "hollowproj", title: "hollow card", by: ORCH, checklist: ["code lands", "tests green"] }) });
  const id = (await r.json()).task.id;
  await take(id);
  await call("relay_task_move", { id, status: "testing", note: "finished it" });
  const card = await getCard(id);
  ok("the move still LANDS (testing)", card?.status === "testing", card?.status);
  ok("note is prefixed HOLLOW: naming all four missing pieces",
    /^HOLLOW: no diff, no new files, no ticked checklist items, no test command in the note, no verified-at sha in the note — finished it\nblast: /.test(lastNote(card)),
    lastNote(card).slice(0, 140));
  const inbox = await (await fetch(`${HUB}/inbox?session=${ORCH}&since=0&peek=1`)).json();
  const msg = (inbox.messages || []).find(m => m.from === SESSION && /HOLLOW move/.test(m.text || ""));
  ok("the card's assigner got one bus line", !!msg && new RegExp(`#${id} -> testing`).test(msg.text), JSON.stringify(inbox.messages || []).slice(0, 140));
  ok("the assigner alert is batched (wake:false — context, not a contract)", msg?.wake === false, JSON.stringify(msg || {}).slice(0, 120));
}

// ---- 2. a real diff since the taken-sha -> NOT flagged ------------------------------------------
{
  const id = await addCard("real-diff card", ["code lands", "tests green"]);
  await take(id);
  writeFileSync(join(REPO, "feature.mjs"), "export const x = 1;\n");
  git(["add", "feature.mjs"]);
  git(["-c", "user.name=drill", "-c", "user.email=drill@x", "commit", "-q", "-m", "feature"]);
  await call("relay_task_move", { id, status: "testing", note: `feature.mjs added; eyeball only; verified at ${SHA}` });
  const card = await getCard(id);
  ok("real diff: move lands", card?.status === "testing", card?.status);
  ok("real diff: no HOLLOW prefix despite no test command and unticked items", !lastNote(card).startsWith("HOLLOW:"), lastNote(card).slice(0, 90));
}

// ---- 3. an untracked new file counts as evidence -> NOT flagged ----------------------------------
{
  const id = await addCard("untracked card");
  await take(id);
  writeFileSync(join(REPO, "draft.mjs"), "// new module, not yet added\n");
  await call("relay_task_move", { id, status: "testing", note: `drafted the module, verified at ${SHA}` });
  ok("new untracked file: no HOLLOW prefix", !lastNote(await getCard(id)).startsWith("HOLLOW:"), lastNote(await getCard(id)).slice(0, 90));
  rmSync(join(REPO, "draft.mjs"));
}

// ---- 4. a declared no-code outcome is never flagged ----------------------------------------------
{
  const id = await addCard("investigation card");
  await take(id);
  await call("relay_task_move", { id, status: "done", note: "Investigation only, no code change: root cause is the runner's poll; answered on the bus." });
  const card = await getCard(id);
  ok("no-code declaration: move lands done", card?.status === "done", card?.status);
  ok("no-code declaration: no HOLLOW prefix from a clean worktree", !lastNote(card).startsWith("HOLLOW:"), lastNote(card).slice(0, 90));
}

// ---- 5. ticked checklist item + test command in the note -> NOT flagged ---------------------------
{
  const id = await addCard("honest card", ["check lands", "drill green"]);
  await take(id);
  await call("relay_task_check", { id, index: 0 });
  await call("relay_task_move", { id, status: "done", note: `tests: node test/runner/test-hollow-move.mjs — 4/4 green, verified at ${SHA}` });
  const card = await getCard(id);
  ok("ticked item + test command: move lands done", card?.status === "done", card?.status);
  ok("ticked item + test command: no HOLLOW prefix", !lastNote(card).startsWith("HOLLOW:"), lastNote(card).slice(0, 90));
}

// ---- 6. a card taken before the base recorder existed fails OPEN -----------------------------------
{
  const id = await addCard("legacy card");
  // never moved to doing through the MCP — no taken-sha recorded; the check must not flag blind
  await call("relay_task_move", { id, status: "testing", note: "finished it" });
  const card = await getCard(id);
  ok("no recorded base: move lands and stays UNflagged (fail-open)", card?.status === "testing" && !lastNote(card).startsWith("HOLLOW:"),
    `${card?.status} ${lastNote(card).slice(0, 60)}`);
}

// ---- 7. #7754: full evidence but no `verified at <sha>` -> flagged on that alone ----------------
{
  const id = await addCard("unanchored card", ["check lands", "drill green"]);
  await take(id);
  writeFileSync(join(REPO, "feature.mjs"), "export const x = 2;\n");
  await call("relay_task_check", { id, index: 0 });
  await call("relay_task_move", { id, status: "testing", note: "tests: node test/runner/test-hollow-move.mjs — 6/6 green on origin/main" });
  const card = await getCard(id);
  ok("#7754: the move still lands", card?.status === "testing", card?.status);
  ok("#7754: diff + tick + test command without a verified-at sha is flagged, naming only the sha",
    /^HOLLOW: no verified-at sha in the note — tests:/.test(lastNote(card)), lastNote(card).slice(0, 120));
  git(["checkout", "-q", "--", "feature.mjs"]);
}
{
  const id = await addCard("anchored card");
  await take(id);
  await call("relay_task_move", { id, status: "done", note: `node test/runner/test-hollow-move.mjs 8/8 verified at ${SHA.slice(0, 7)}` });
  ok("#7754: a short sha after `verified at` satisfies the check", !lastNote(await getCard(id)).startsWith("HOLLOW:"), lastNote(await getCard(id)).slice(0, 90));
}

// ---- 8. #7968: blast radius rides the note and the card event ------------------------------------
const blastOf = async (id) => {
  const r = await fetch(`${HUB}/card?id=${id}`);
  const moved = ((await r.json()).events || []).filter(e => e.type === "moved").pop();
  return moved?.blast;
};
const lastLine = (card) => lastNote(card).split("\n").pop();
const contract = (id, base) => fetch(`${HUB}/send`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ from: ORCH, to: SESSION, project: "hollowproj", text: `take #${id}\nbase: ${base}` }) });
if (HAS_GRAFT) {
  // 8a. the contract's base sha, one changed lib/a.mjs imported by two files
  const id = await addCard("blast card", ["code lands"]);
  const base = git(["rev-parse", "HEAD"]);
  await contract(id, base);
  await take(id);
  writeFileSync(join(REPO, "lib", "a.mjs"), "export const a = 2;\n");
  commit("a=2");
  await call("relay_task_move", { id, status: "testing", note: `node test/x.mjs 1/1, verified at ${SHA}` });
  const card = await getCard(id);
  ok("#7968: the note ends with the dependents count", lastLine(card) === "blast: 2 files depend on the 1 changed", lastLine(card));
  const b = await blastOf(id);
  ok("#7968: the moved event carries blast {base, changed, dependents}",
    b?.base === base && b?.dependents === 2 && b?.changed?.length === 1 && b.changed[0] === "lib/a.mjs" && b.unindexed?.length === 0, JSON.stringify(b));
  ok("#7968: blast never lands on the card itself", !("blast" in card));
}
if (HAS_GRAFT) {
  // 8b. only package.json changed: graft does not index it, and the note says so instead of a silent zero
  const id = await addCard("config card");
  const base = git(["rev-parse", "HEAD"]);
  await contract(id, base);
  await take(id);
  writeFileSync(join(REPO, "package.json"), '{"name":"hollow-fixture-2","type":"module"}\n');
  commit("rename");
  await call("relay_task_move", { id, status: "done", note: `bumped the name, verified at ${SHA}` });
  ok("#7968: an unindexed-only change reads `not in the graph`", lastLine(await getCard(id)) === "blast: not in the graph (package.json)", lastLine(await getCard(id)));
  const b = await blastOf(id);
  ok("#7968: the event names the unindexed path with zero dependents", b?.dependents === 0 && b?.unindexed?.[0] === "package.json", JSON.stringify(b));
}
if (HAS_GRAFT) {
  // 8c. no contract base: the merge base of main and HEAD, from a seat branch one commit ahead
  git(["checkout", "-q", "-b", "seat/drill"]);
  const id = await addCard("merge-base card");
  await take(id);
  writeFileSync(join(REPO, "lib", "a.mjs"), "export const a = 3;\n");
  commit("a=3");
  await call("relay_task_move", { id, status: "testing", note: `node test/x.mjs 1/1, verified at ${SHA}` });
  ok("#7968: without a base line the diff is taken from merge-base main HEAD", lastLine(await getCard(id)) === "blast: 2 files depend on the 1 changed", lastLine(await getCard(id)));
  ok("#7968: the event's base is main's tip", (await blastOf(id))?.base === git(["rev-parse", "main"]));
}
{
  // 8d. graft absent: the move lands, the note says unavailable, the event says unavailable
  const seat2 = await spawnMcp("seat2:hollowproj", { GRAFT_BIN: join(W, "no-such-graft") });
  const id = await addCard("no-graft card");
  await seat2.call("relay_task_move", { id, status: "doing" });
  await seat2.call("relay_task_move", { id, status: "testing", note: `eyeballed, verified at ${SHA}` });
  const card = await getCard(id);
  ok("#7968: graft absent — the move still lands", card?.status === "testing", card?.status);
  ok("#7968: graft absent — the note fails open to `blast: unavailable`", lastLine(card) === "blast: unavailable", lastLine(card));
  ok("#7968: graft absent — the event carries {unavailable:true}", JSON.stringify(await blastOf(id)) === '{"unavailable":true}', JSON.stringify(await blastOf(id)));
  seat2.kill();
}
{
  // 8e. graft slow: the 2.5s box fails open instead of holding the move
  const slow = join(W, "slow-graft");
  writeFileSync(slow, "#!/bin/sh\nsleep 6\n"); chmodSync(slow, 0o755);
  const seat3 = await spawnMcp("seat3:hollowproj", { GRAFT_BIN: slow });
  const id = await addCard("slow-graft card");
  await seat3.call("relay_task_move", { id, status: "doing" });
  const t0 = Date.now();
  await seat3.call("relay_task_move", { id, status: "testing", note: `eyeballed, verified at ${SHA}` });
  const took = Date.now() - t0;
  ok("#7968: graft slow — the move lands inside the box, not after graft", took < 5000 && (await getCard(id))?.status === "testing", `${took}ms`);
  ok("#7968: graft slow — the note says unavailable", lastLine(await getCard(id)) === "blast: unavailable", lastLine(await getCard(id)));
  seat3.kill();
}

mcp.kill(); hub.kill();
rmSync(W, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
