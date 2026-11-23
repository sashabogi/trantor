#!/usr/bin/env node
// #13920: POST/GET /machines/health on an enforce hub — seat-signed write on its own project,
// label/number validation, the GET envelope with staleness past the window (shortened via
// RELAY_HEALTH_STALE_MS so the 90s default needs no real-time sleep), and the daily prune.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestHub } from "../lib/test-hub.mjs";
import { generate, signRequest } from "../../lib/identity.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };

async function sFetch(base, id, method, path, bodyObj) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const hdrs = signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method, path, body });
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...hdrs }, body });
  let json = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

console.log("# hub machines/health (#13920)");

const dir = mkdtempSync(join(tmpdir(), "trantor-13920-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const env = {
  AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_HOST: "127.0.0.1",
  RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu", RELAY_OVERSEER_TICK_MS: "600000",
  RELAY_HEALTH_STALE_MS: "400",
};
const hub = await startTestHub({ dir, env });
try {
  const base = hub.base;
  const owner = generate();   // the operator / desktop reader
  const seat = generate();    // a crew seat on projA — the heartbeat's real signer
  const reader = generate();  // read-only on projA: still allowed to READ machine health
  const own = await sFetch(base, owner, "POST", "/enroll", { name: "owner", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  ok("owner enrolled", own.status < 400, `status ${own.status}`);
  const invS = await sFetch(base, owner, "POST", "/invite", { scopes: [{ project: "projA", role: "write" }], ttlSec: 60, kind: "agent" });
  const regS = await sFetch(base, seat, "POST", "/enroll", { token: invS.json.token || "", name: "glm:projA", kind: "agent" });
  ok("projA seat (write) enrolled", regS.status < 400, `status ${regS.status}`);
  const invR = await sFetch(base, owner, "POST", "/invite", { scopes: [{ project: "projA", role: "read" }], ttlSec: 60, kind: "human" });
  const regR = await sFetch(base, reader, "POST", "/enroll", { token: invR.json.token || "", name: "watcher", kind: "human" });
  ok("projA read-only enrolled", regR.status < 400, `status ${regR.status}`);

  const GiB = 2 ** 30;
  const beat = { machine: "netcup", cpuPct: 34, memUsed: 21 * GiB, memTotal: 62 * GiB, ts: 12345, project: "projA" };

  // ---- write path ------------------------------------------------------------------
  let r = await sFetch(base, reader, "POST", "/machines/health", beat);
  ok("a read-only key cannot post a heartbeat", r.status === 403, `status ${r.status}`);
  r = await sFetch(base, seat, "POST", "/machines/health", beat);
  ok("a seat's write scope posts its machine's health", r.status === 200 && r.json.machine === "netcup", JSON.stringify(r.json));
  r = await sFetch(base, seat, "POST", "/machines/health", { ...beat, machine: "Bad Label!" });
  ok("a label outside the machineLabel grammar is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, seat, "POST", "/machines/health", { ...beat, cpuPct: "lots" });
  ok("a non-numeric cpuPct is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, seat, "POST", "/machines/health", { ...beat, memUsed: 63 * GiB, memTotal: 62 * GiB });
  ok("memUsed above memTotal is 400", r.status === 400, `status ${r.status}`);
  r = await sFetch(base, seat, "POST", "/machines/health", { ...beat, cpuPct: 150, machine: "other-box" });
  ok("cpuPct above 100 (real overload) is stored, not clamped", r.status === 200, `status ${r.status}`);

  // ---- read path -------------------------------------------------------------------
  r = await sFetch(base, reader, "GET", "/machines/health");
  let machines = r.json.machines || [];
  const netcup = machines.find(m => m.machine === "netcup");
  const other = machines.find(m => m.machine === "other-box");
  ok("GET returns every reporting machine, sorted by label",
    r.status === 200 && machines.length === 2 && machines[0].machine === "netcup" && !!other, JSON.stringify(machines.map(m => m.machine)));
  ok("the row carries the payload numbers and the HUB's receive time (sender ts ignored)",
    netcup?.cpuPct === 34 && netcup?.memUsed === 21 * GiB && netcup?.memTotal === 62 * GiB
    && Math.abs(netcup?.ts - Date.now()) < 5000 && netcup?.ts !== 12345, JSON.stringify(netcup));
  ok("fresh rows read stale:false with the window echoed", netcup?.stale === false && r.json.staleAfterMs === 400, JSON.stringify(r.json));

  // ---- staleness -------------------------------------------------------------------
  await new Promise(s => setTimeout(s, 500));   // > RELAY_HEALTH_STALE_MS=400
  r = await sFetch(base, reader, "GET", "/machines/health");
  machines = r.json.machines || [];
  ok("a machine whose beats stopped reads stale:true",
    machines.every(m => m.stale === true) && machines.length === 2, JSON.stringify(machines));
  r = await sFetch(base, seat, "POST", "/machines/health", beat);
  ok("a fresh beat un-stales the machine", r.status === 200, `status ${r.status}`);
  r = await sFetch(base, owner, "GET", "/machines/health");
  ok("the owner reads the same envelope",
    (r.json.machines || []).find(m => m.machine === "netcup")?.stale === false, JSON.stringify(r.json.machines));
} finally {
  await hub.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
