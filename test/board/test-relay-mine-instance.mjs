#!/usr/bin/env node
// #13923 instance-fence drill, kickoff half — a seat that reuses an old seat name must not
// inherit that name's old assignments: relay_board's mine view (the kickoff's FIRST call) passes
// over assignments older than the seat instance (TRANTOR_SEAT_BOOT_TS) unless a post-start
// contract cited the card. REAL mcp.mjs over MCP stdio against a REAL hub, as test-relay-mine.mjs.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? ` — ${x}` : ""}`); } };

console.log("# trantor relay_board mine instance-fence drill (#13923)");

const W = mkdtempSync(join(tmpdir(), "trantor-mine-inst-"));
mkdirSync(join(W, ".agent-bus"), { recursive: true });
const PROJ = "minstdrv", SESSION = `reused:${PROJ}`;
const hub = await startTestHub({ dir: W });
const HUB = hub.base;
const post = async (path, body) => (await fetch(HUB + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const addCard = async ({ title, status = "todo", ts }) => {
  const body = { project: PROJ, title, status, assignee: SESSION, by: "orch@laptop" };
  if (ts) body.ts = ts;
  const { task } = await post("/task", body);
  return task.id;
};

// the REAL MCP server, as a stdio JSON-RPC peer — spawned per seat-instance stamp, since the
// fence reads the RUNNER's boot stamp out of the server's env (#13923).
function spawnMcp(session, bootTs) {
  const env = { ...drillEnv(), HOME: W, AGENT_BUS_DIR: join(W, ".agent-bus"), RELAY_URL: HUB,
    RELAY_SESSION: session, RELAY_PROJECT: PROJ, RELAY_HEARTBEAT_MS: "600000" };
  if (bootTs) env.TRANTOR_SEAT_BOOT_TS = String(bootTs);
  const m = spawn("node", [join(ROOT, "mcp.mjs")], { cwd: W, env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  let rpcId = 0;
  m.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const msg = JSON.parse(line); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch {}
    }
  });
  const rpc = (method, params, timeoutMs = 30000) => {
    const id = ++rpcId;
    const p = new Promise((res, rej) => {
      pending.set(id, res);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); } }, timeoutMs);
    });
    m.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  };
  return { proc: m, rpc };
}

async function ready(m) {
  await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drill", version: "0" } });
  m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}
const mineCall = (m) => m.rpc("tools/call", { name: "relay_board", arguments: { mine: true } });
const text = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r?.result ?? r?.error ?? {});
const idsOf = (out) => [...out.matchAll(/^#(\d+) /gm)].map(x => Number(x[1]));

// ---- 0. the board a reused name inherits ---------------------------------------------------------
// OLD and OLDER carry pre-instance ts (weeks old, the 11-20 shape: an iOS card in testing plus a
// stale todo); FRESH is created after the instance started — the only assignment this instance
// made or was contracted for so far.
const BOOT = Date.now();
const DAY = 864e5;
const older = await addCard({ title: "instance drill card OLDER (inherited todo)", ts: BOOT - 22 * DAY });
const old = await addCard({ title: "instance drill card OLD (inherited testing)", status: "testing", ts: BOOT - 30 * DAY });
const fresh = await addCard({ title: "instance drill card FRESH (post-start todo)" });
ok("the inherited pair predates the instance, the fresh card does not",
  (await (await (await fetch(`${HUB}/card?project=${PROJ}&id=${old}`)).json()).task?.ts || 0) < BOOT
  && (await (await (await fetch(`${HUB}/card?project=${PROJ}&id=${fresh}`)).json()).task?.ts || 0) >= BOOT);

// ---- 1. kickoff with the stamp: an old assignment is ignored --------------------------------------
const seat = spawnMcp(SESSION, BOOT);
await ready(seat);
{
  const out = text(await mineCall(seat));
  const ids = idsOf(out);
  ok("#13923: a pre-instance assignment is NOT offered as this seat's work (the #12138 shape)",
    !ids.includes(old) && !ids.includes(older) && !out.includes("inherited testing"), out.slice(0, 200));
  ok("#13923: a card created after the instance started still is", ids.includes(fresh) && ids.length === 1, `got ${JSON.stringify(ids)}`);
  ok("#13923: the empty-ish answer says how many old assignments were passed over, and that they stay on the board",
    /2 assignment\(s\) made before this seat instance started/.test(out) && /stay on the board/.test(out), out.slice(0, 300));
}

// ---- 2. a post-start contract is picked up; chatter is not ----------------------------------------
{
  // a broadcast @mention citing OLDER contracts nothing (direct messages only, #13923).
  await post("/send", { from: "orch@laptop", to: "all", project: PROJ, text: `board sweep note: @${SESSION} #${older} still looks stale to me` });
  // a direct wake:false FYI is context by the sender's own word — not a contract either.
  await post("/send", { from: "orch@laptop", to: SESSION, project: PROJ, text: `fyi (no turn needed): #${older} may get re-planned later`, wake: false });
  let out = text(await mineCall(seat));
  ok("#13923: a broadcast citation and a wake:false FYI do NOT adopt an old assignment",
    !idsOf(out).includes(older), out.slice(0, 200));
  // the real thing: a direct post-start contract citing OLD (with the board touch that rides a
  // re-contract — the orchestrator moves the card back to todo as it re-issues it).
  await post("/send", { from: "orch@laptop", to: SESSION, project: PROJ, text: `contract: work #${old} now — it is yours again` });
  await post("/task/update", { id: old, status: "todo", note: "re-contracted to the revived seat", by: "orch@laptop" });
  out = text(await mineCall(seat));
  const ids = idsOf(out);
  ok("#13923: a post-start direct contract picks the old card back up", ids.includes(old), `got ${JSON.stringify(ids)}`);
  ok("#13923: the uncited inherited card stays passed over (and the note still names it)",
    !ids.includes(older) && ids.length === 2 && /1 assignment\(s\) made before this seat instance started/.test(out), out.slice(-200));
  ok("#13923: newest first still orders the eligible cards — the re-contracted card is the work of record",
    ids[0] === old, `got ${JSON.stringify(ids)}`);
}

// ---- 3. no runner stamp: the fence fails open (solo sessions, old runners) ------------------------
{
  const solo = spawnMcp(SESSION, 0);
  await ready(solo);
  const out = text(await mineCall(solo));
  ok("#13923: without a seat-instance stamp the mine view is unchanged (fail open)",
    idsOf(out).length === 3, `got ${JSON.stringify(idsOf(out))}`);
  solo.proc.kill();
}

// ---- 4. old assignments are untouched on the board -------------------------------------------------
{
  const tasks = (await (await fetch(`${HUB}/tasks?project=${PROJ}`)).json()).tasks || [];
  const byId = new Map(tasks.map(t => [t.id, t]));
  ok("#13923: the passed-over assignment keeps its status and assignee — the board is not edited",
    byId.get(older)?.status === "todo" && byId.get(older)?.assignee === SESSION,
    JSON.stringify(byId.get(older) && [byId.get(older).status, byId.get(older).assignee]));
}

seat.proc.kill(); hub.proc.kill();
rmSync(W, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
