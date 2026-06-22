// Regression for the hub-side handoff storm guard + stale-hook visibility (the crebral-cortex incident:
// an old-hook session re-fired a handoff every few minutes — 9 in 49 min — each spawning a window).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0; const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };

const dir = mkdtempSync(join(tmpdir(), "trantor-hg-"));
const PORT = 47757;
const hub = spawn("node", ["hub.mjs"], { env: { ...process.env, RELAY_DATA_DIR: dir, RELAY_PORT: String(PORT), PORT: String(PORT) }, stdio: ["ignore", "ignore", "pipe"] });
await new Promise(r => setTimeout(r, 800));
const base = `http://127.0.0.1:${PORT}`;
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());

// --- storm guard ---
let r = await post("/handoff", { project: "demo", session: "sessA", trigger: "context-warn" });
ok(r.ok && r.allow === true, "first handoff for (demo,sessA) allowed");
r = await post("/handoff", { project: "demo", session: "sessA", trigger: "context-warn" });
ok(r.allow === false && r.reason === "storm-guard", "second handoff <cooldown for same session → BLOCKED (storm guard)");
r = await post("/handoff", { project: "demo", session: "sessB", trigger: "context-warn" });
ok(r.allow === true, "different session (sessB) is allowed — guard is per (project,session)");
r = await post("/handoff", { project: "demo", session: "sessA", trigger: "manual-cli", force: true });
ok(r.allow === true, "force:true (manual / at-wall) bypasses the guard");
r = await post("/handoff", { project: "demo", session: "sessA", cooldownSec: 1 });
ok(r.allow === false, "still blocked at default cooldown");
const log = await get("/handoffs?project=demo");
ok(Array.isArray(log.handoffs) && log.handoffs.length >= 3, `GET /handoffs lists the recorded handoffs (${log.handoffs?.length})`);

// --- stale-hook visibility ---
const hv = await get("/peers");
const hub_v = hv.hubVersion;
ok(!!hub_v, `/peers reports hubVersion (${hub_v})`);
await post("/register", { session: "host:demo", project: "demo", hookVersion: "0.0.1" });   // ancient hooks
await post("/register", { session: "host2:demo", project: "demo", hookVersion: hub_v });      // current hooks
const peers = (await get("/peers")).peers;
const old = peers.find(p => p.session === "host:demo");
const cur = peers.find(p => p.session === "host2:demo");
ok(old && old.hookVersion === "0.0.1" && old.staleHooks === true, "peer on old hooks flagged staleHooks:true");
ok(cur && cur.staleHooks === false, "peer on current hooks → staleHooks:false");

hub.kill();
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
