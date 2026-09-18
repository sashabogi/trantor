#!/usr/bin/env node
// trantor contract-threading drill (#6987) — the REAL hub, REAL /contracts ledger.
//
// contractsFor closes an assigner's contract strictly by a reply's `re` thread id; the oldest-open
// FIFO fallback exists only for replies that carry NO `re`. The 2026-09-09 incident: answering a
// peer's newest question silently closed their OLDEST contract and left the real one reading
// WAITING forever, so the stop hook chased rows that had been answered long before. This drill
// pins the ledger end to end over HTTP: a threaded reply answers exactly the contract it names, a
// threaded receipt closes exactly its own contract, and the FIFO fallback still exists but never
// touches a reply that carries `re`.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillEnv } from "../drill-env.mjs";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PORT = 47971;
const dir = mkdtempSync(join(tmpdir(), "trantor-thread-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const hub = spawn("node", [join(ROOT, "hub.mjs")], {
  env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
let err = ""; hub.stderr.on("data", d => err += d);

const base = `http://127.0.0.1:${PORT}`;
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());

console.log("# trantor contract threading (#6987)");

const ORCH = "orch:threadA", SEAT = "seat:threadA", PROJ = "threadA";

await sleep(800);
try {
  // the assignee is on the bus, so open rows read `waiting`, not `stalled`
  await post("/register", { session: SEAT, project: PROJ, status: "active", llm: "glm", model: "test" });

  // three live contracts from ONE assigner
  const sent = [];
  for (const text of ["first: ship the fix", "second: review the drill", "third: write the notes"]) {
    sent.push(await post("/send", { from: ORCH, to: SEAT, text, project: PROJ }));
  }
  const [a, b, c] = sent.map(s => s.id);
  ok("the hub returned distinct ids for the three contracts", a > 0 && b > a && c > b, JSON.stringify(sent.map(s => s.id)));

  const ledger = async () => (await get(`/contracts?session=${encodeURIComponent(ORCH)}`));
  let rows = (await ledger()).contracts;
  const row = (id) => rows.find(r => r.id === id);
  ok("all three read waiting while nothing was answered",
    rows.length === 3 && rows.every(r => r.disposition === "waiting" && !r.answered), JSON.stringify(rows.map(r => [r.id, r.disposition])));

  // the seat answers the SECOND by its thread id
  const reply = await post("/send", { from: SEAT, to: ORCH, text: "review done — the drill reads clean", project: PROJ, re: b });
  ok("the reply was accepted with an id", reply?.id > 0);

  rows = (await ledger()).contracts;
  ok("the named contract reads answered", row(b)?.answered === true && row(b)?.answer?.id === reply.id, JSON.stringify(row(b)));
  ok("the FIRST still reads WAITING — a threaded reply never leaks onto it", row(a)?.answered === false && row(a)?.disposition === "waiting", JSON.stringify(row(a)));
  ok("the THIRD still reads WAITING too", row(c)?.answered === false && row(c)?.disposition === "waiting");

  // a threaded RECEIPT closes exactly its own contract — no FIFO spillover
  await post("/send", { from: SEAT, to: ORCH, text: `✅ done on ${SEAT} (exit 0)`, project: PROJ, kind: "receipt", re: a });
  rows = (await ledger()).contracts;
  ok("the receipt closed its own contract", row(a)?.answered === true, JSON.stringify(row(a)));
  ok("…and nothing else: the third is STILL open", row(c)?.answered === false && row(c)?.disposition === "waiting", JSON.stringify(row(c)));

  // the oldest-open fallback is alive for replies WITHOUT `re` — and only those
  const loose = await post("/send", { from: SEAT, to: ORCH, text: "notes are up on the card", project: PROJ });
  rows = (await ledger()).contracts;
  ok("a reply without `re` falls through to the only open contract", row(c)?.answered === true && row(c)?.answer?.id === loose.id, JSON.stringify(row(c)));
  ok("the ledger is fully settled: no open rows", (await ledger()).open === 0);
} catch (e) { fail++; console.log("  ✗ drill threw:", e?.message || e, err ? `\n  stderr: ${err}` : ""); }
finally { hub.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch {} }

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
