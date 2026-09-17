#!/usr/bin/env node
// relay_board's my-cards view (#7763): `mine: true` lists the calling session's own open cards
// (doing/testing/todo, newest first, message-cards excluded) in the FULL card:<id> shape — so a
// seat woken without a card id starts from its own cards, never a whole-board read. Drives the
// REAL mcp.mjs over real MCP stdio against a REAL (throwaway) hub, as in test-relay-note.mjs.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor relay_board mine drill");

const W = mkdtempSync(join(tmpdir(), "trantor-mine-"));
mkdirSync(join(W, ".agent-bus"), { recursive: true });
const PORT = 47872, HUB = `http://127.0.0.1:${PORT}`;
const PROJ = "minedriv", SESSION = `miner:${PROJ}`;
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

// the REAL MCP server, as a stdio JSON-RPC peer — spawned per session id, since `mine` reads
// the calling session out of the server's env.
function spawnMcp(session) {
  const m = spawn("node", [join(ROOT, "mcp.mjs")], {
    cwd: W,
    env: { ...drillEnv(), HOME: W, AGENT_BUS_DIR: join(W, ".agent-bus"), RELAY_URL: HUB,
      RELAY_SESSION: session, RELAY_PROJECT: PROJ, RELAY_HEARTBEAT_MS: "600000" },
    stdio: ["pipe", "pipe", "pipe"],
  });
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

const mine = spawnMcp(SESSION);
await mine.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drill", version: "0" } });
mine.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const call = (name, args) => mine.rpc("tools/call", { name, arguments: args });
const text = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r?.result ?? r?.error ?? {});
const add = async (args) => Number(text(await call("relay_task_add", args)).match(/card #(\d+)/)?.[1] || 0);
const getTasks = async () => (await (await fetch(`${HUB}/tasks?project=${PROJ}`)).json()).tasks || [];

// ---- 0. the schema advertises the my-cards contract --------------------------------------------
{
  const r = await mine.rpc("tools/list", {});
  const board = (r?.result?.tools || []).find(t => t.name === "relay_board");
  ok("relay_board exposes an optional mine param", !!board?.inputSchema?.properties?.mine);
  ok("mine's description says whose cards and which statuses", /calling session/.test(board?.inputSchema?.properties?.mine?.description || "") && /doing/.test(board?.inputSchema?.properties?.mine?.description || ""));
}

// ---- 1. seed a board that separates every rule the view claims ----------------------------------
// Created in this order, so "newest first" is checkable: D, C, B, A are the caller's open cards.
const a = await add({ title: "mine drill card A (older doing)", status: "doing", note: "plan: mine drill A" });
const b = await add({ title: "mine drill card B (newer doing)", status: "doing", note: "plan: mine drill B" });
const c = await add({ title: "mine drill card C (testing)", status: "testing" });
const d = await add({ title: "mine drill card D (todo)", status: "todo" });
const e = await add({ title: "mine drill card E (done, not open work)", status: "done" });
const f = await add({ title: "mine drill card F (someone else's doing)", status: "doing", assignee: "other:minedriv" });
const m = await add({ title: "NEW BUS MESSAGE for you: hello seat", status: "todo" });
ok("all seven seed cards landed", [a, b, c, d, e, f, m].every(Number.isInteger) && (await getTasks()).length >= 7);

// ---- 2. the mine view: own open cards, newest first, nothing else -------------------------------
{
  const out = text(await call("relay_board", { mine: true }));
  const ids = [...out.matchAll(/^#(\d+) /gm)].map(x => Number(x[1]));
  ok("both doing cards come back — a seat with two cards in doing gets BOTH", ids.includes(a) && ids.includes(b), `got ${JSON.stringify(ids)}`);
  ok("testing and todo count as open work too", ids.includes(c) && ids.includes(d), `got ${JSON.stringify(ids)}`);
  ok("newest first: D, C, B, A", JSON.stringify(ids) === JSON.stringify([d, c, b, a]), `got ${JSON.stringify(ids)}`);
  ok("done cards of mine are NOT open work", !ids.includes(e), `got ${JSON.stringify(ids)}`);
  ok("another session's cards are NOT mine", !ids.includes(f) && !out.includes("card F"), out.slice(0, 120));
  ok("message-cards are never listed as work", !ids.includes(m) && !out.includes("NEW BUS MESSAGE"), out.slice(0, 120));
  ok("bounded, not a board dump: only the four open cards appear", ids.length === 4, `got ${ids.length} card(s)`);
}

// ---- 3. the same per-card shape as card:<id> ------------------------------------------------------
{
  const out = text(await call("relay_board", { mine: true }));
  const blockA = out.slice(out.indexOf(`#${a} `));
  ok("the full card shape: a status line with the assignee", new RegExp(`#${a} [^\\n]*\\nstatus: doing · @${SESSION}`).test(out), blockA.slice(0, 160));
  ok("the full card shape: the card's LOG is re-attached (not the slim projection)", blockA.includes("notes (1):") && blockA.includes("plan: mine drill A"), blockA.slice(0, 200));
  const one = text(await call("relay_board", { card: a }));
  ok("the shape matches card:<id> — same title line, same status line, same note",
    one.includes(`#${a} mine drill card A (older doing)`) && one.includes(`status: doing · @${SESSION}`) && one.includes("plan: mine drill A"),
    one.slice(0, 160));
}

// ---- 4. the hub carries the multi-id re-attach (one request, N full cards) -----------------------
{
  const j = await (await fetch(`${HUB}/tasks?project=${PROJ}&fields=slim&card=${a},${b}`)).json();
  const byId = new Map((j.tasks || []).map(t => [t.id, t]));
  ok("card=a,b returns BOTH cards full (log attached)", Array.isArray(byId.get(a)?.log) && Array.isArray(byId.get(b)?.log), JSON.stringify([byId.get(a)?.log?.length, byId.get(b)?.log?.length]));
  ok("the OTHER cards stay slim (logCount, no log) — bounded payload", !byId.get(c)?.log && Number(byId.get(c)?.logCount) === 0, JSON.stringify({ log: byId.get(c)?.log, logCount: byId.get(c)?.logCount }));
  ok("single-id and no-param behavior unchanged: fields echoed", j.fields === "slim");
}

// ---- 5. a session with no cards gets a bounded answer, not the board -----------------------------
{
  const nobody = spawnMcp(`nobody:${PROJ}`);
  await nobody.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drill", version: "0" } });
  nobody.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const out = text(await nobody.rpc("tools/call", { name: "relay_board", arguments: { mine: true } }));
  ok("no own cards -> one bounded line naming the session, never the board",
    out.includes(`no cards assigned to nobody:${PROJ}`) && !out.includes("#"), out.slice(0, 120));
  nobody.proc.kill();
}

mine.proc.kill(); hub.kill();
rmSync(W, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
