#!/usr/bin/env node
// Card-note contract drill for the MCP side (#4759): relay_task_add / relay_task_move accept an
// optional `note` (<=2000 chars) and pass it through to the hub's card log ({ts,by,text}, cap 40),
// relay_board shows the ·N note count, and an oversize note is refused client-side before it can
// be silently truncated. Drives the REAL mcp.mjs over the real MCP stdio protocol against a REAL
// (throwaway) hub — the hub half of the contract is pinned by test-cardlog.mjs.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor card-note MCP drill");

const W = mkdtempSync(join(tmpdir(), "trantor-note-"));
mkdirSync(join(W, ".agent-bus"), { recursive: true });
const PORT = 47862, HUB = `http://127.0.0.1:${PORT}`;
const SESSION = "noter:noteproj";
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

// the REAL MCP server, as a stdio JSON-RPC peer
const mcp = spawn("node", [join(ROOT, "mcp.mjs")], {
  cwd: W,
  env: { ...drillEnv(), HOME: W, AGENT_BUS_DIR: join(W, ".agent-bus"), RELAY_URL: HUB,
    RELAY_SESSION: SESSION, RELAY_PROJECT: "noteproj", RELAY_HEARTBEAT_MS: "600000" },
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
const text = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r?.result ?? r?.error ?? {});
const isErr = (r) => !!r?.error || !!r?.result?.isError;
const getCard = async (id) => {
  const r = await fetch(`${HUB}/tasks?project=noteproj`);
  return (await r.json()).tasks.find(t => t.id === id);
};

// ---- 0. tool schema advertises the note contract ---------------------------------------------
{
  const r = await rpc("tools/list", {});
  const tools = r?.result?.tools || [];
  const add = tools.find(t => t.name === "relay_task_add");
  const move = tools.find(t => t.name === "relay_task_move");
  const board = tools.find(t => t.name === "relay_board");
  ok("relay_task_add exposes an optional note param", !!add?.inputSchema?.properties?.note);
  ok("relay_task_move exposes an optional note param", !!move?.inputSchema?.properties?.note);
  ok("relay_task_move's description DEMANDS a note on testing/done", /note/.test(move?.description || "") && /testing|done/.test(move?.description || ""), (move?.description || "").slice(0, 90));
  ok("relay_board's description mentions the ·N note count", /·N|note/.test(board?.description || ""));
}

// ---- 1. task_add with a note lands on the card's log ------------------------------------------
let cardId;
{
  const r = await call("relay_task_add", { title: "note drill card", note: "plan: add note pass-through on the MCP tools" });
  const out = text(r);
  const m = out.match(/card #(\d+)/);
  ok("task_add succeeded", !!m, out.slice(0, 90));
  cardId = m ? Number(m[1]) : 0;
  const card = await getCard(cardId);
  ok("the note is on the card's log", Array.isArray(card?.log) && card.log.length === 1, JSON.stringify(card?.log || null).slice(0, 120));
  const e = card?.log?.[0] || {};
  ok("log entry is {ts,by,text} with the session as author", e.text === "plan: add note pass-through on the MCP tools" && e.by === SESSION && Number.isFinite(e.ts), JSON.stringify(e).slice(0, 120));
}

// ---- 2. task_add WITHOUT a note leaves no log ---------------------------------------------------
{
  const r = await call("relay_task_add", { title: "silent card" });
  const m = text(r).match(/card #(\d+)/);
  const card = await getCard(Number(m?.[1] || 0));
  ok("no note -> no log array on the card", !card?.log, JSON.stringify(card?.log || null).slice(0, 90));
}

// ---- 3. task_move with a note appends a second entry -------------------------------------------
{
  const r = await call("relay_task_move", { id: cardId, status: "testing", note: "tests: node test-relay-note.mjs — 9 passed" });
  ok("task_move succeeded", /-> testing/.test(text(r)), text(r).slice(0, 90));
  const card = await getCard(cardId);
  ok("the move note appended to the log", card?.log?.length === 2 && card.log[1].text === "tests: node test-relay-note.mjs — 9 passed", JSON.stringify(card?.log || null).slice(0, 160));
  ok("status actually moved", card?.status === "testing", card?.status);
}

// ---- 4. relay_board shows the ·N note count ------------------------------------------------------
{
  const r = await call("relay_board", {});
  const out = text(r);
  ok("board shows ·2 on the noted card", new RegExp(`#${cardId} [^\\n]*·2`).test(out), out.split("\n").find(l => l.includes(`#${cardId}`)) || out.slice(0, 120));
  const silent = await call("relay_task_add", { title: "board silent card" });
  const sid = Number(text(silent).match(/card #(\d+)/)?.[1] || 0);
  const out2 = text(await call("relay_board", {}));
  ok("a note-less card shows no · count", new RegExp(`#${sid} [^\\n]*`).test(out2) && !new RegExp(`#${sid} [^\\n]*·\\d`).test(out2), out2.split("\n").find(l => l.includes(`#${sid}`)) || "");
}

// ---- 5. an oversize note (>2000) is refused client-side ------------------------------------------
{
  const big = "x".repeat(2100);
  const r = await call("relay_task_move", { id: cardId, status: "done", note: big });
  ok("note >2000 chars is rejected by the schema", isErr(r), text(r).slice(0, 90));
  const card = await getCard(cardId);
  ok("...and never reached the card's log", card?.log?.length === 2 && card?.status === "testing", `log=${card?.log?.length} status=${card?.status}`);
  // a 2000-char note is the boundary that MUST still pass through (hub caps text at 2000)
  const exact = await call("relay_task_move", { id: cardId, status: "done", note: "y".repeat(2000) });
  ok("note ==2000 chars passes through", !isErr(exact) && /-> done/.test(text(exact)), text(exact).slice(0, 90));
  const card2 = await getCard(cardId);
  ok("...and lands full-length on the log", card2?.log?.length === 3 && card2.log[2].text.length === 2000, `len=${card2?.log?.[2]?.text?.length}`);
}

mcp.kill(); hub.kill();
rmSync(W, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
