#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeOverseerLevel } from "../../hooks/lib/overseer-level-cache.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { startTestHub } from "../lib/test-hub.mjs";
import { drillEnv } from "../drill-env.mjs";
import { createOverseer } from "../../hub/overseer.mjs";
import { generate, signRequest } from "../../lib/identity.mjs";

const root = resolve(import.meta.dirname, "../..");
mkdirSync(join(root, ".agent-bus-out"), { recursive: true });
const dir = mkdtempSync(join(root, ".agent-bus-out/holds-test-"));
let passed = 0;
function check(value, message) { assert.ok(value, message); passed++; console.log(`ok ${passed} - ${message}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (script, args, env, input = "") => new Promise((done, reject) => {
  const child = spawn(process.execPath, [join(root, script), ...args], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { err += d; });
  child.on("error", reject);
  child.on("close", code => done({ code, out, err }));
  child.stdin.end(input);
});

const hub = await startTestHub({ dir: join(dir, "hub"), env: { RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu", RELAY_OVERSEER_TICK_MS: "60000" } });
try {
  const owner = generate(), agent = generate(), first = generate(), outsider = generate();
  const request = async (identity, method, path, data) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const response = await fetch(hub.base + path, { method, headers: {
      "content-type": "application/json", ...signRequest(identity, { method, path, body }),
    }, body });
    return { code: response.status, ...await response.json() };
  };
  for (const [identity, name, project, role] of [[owner, "operator", "*", "owner"], [agent, "later:alpha", "alpha", "write"], [first, "first:alpha", "alpha", "write"], [outsider, "elsewhere", "elsewhere", "owner"]]) {
    await request(identity, "POST", "/enroll", { name, kind: role === "owner" ? "human" : "agent", scopes: [{ project, role }] });
  }
  await request(owner, "POST", "/policy", { autonomy: { alpha: 3 } });
  const claim = (session, file = "same.ts") => request(session === "first:alpha" ? first : agent, "POST", "/claim", { project: "alpha", session, file });
  check((await request(agent, "POST", "/hold/check", { project: "alpha", session: "first:alpha", file: "same.ts" })).code === 403, "writer cannot impersonate the earlier claimant");
  check(!(await claim("first:alpha")).hold, "first claimant proceeds");
  const later = await claim("later:alpha");
  check(later.hold?.other === "first:alpha", "later claimant is held immediately");
  check((await claim("later:alpha")).hold.id === later.hold.id, "repeat claim retains one hold");
  check(!(await claim("first:alpha")).hold, "earlier writer stays unblocked");
  check(!(await claim("later:alpha", "other.ts")).hold, "unrelated file stays unblocked");
  const decide = (identity, id, status, project = "alpha") => request(identity, "POST", "/hold/decide", { id, status, project });
  check((await decide(agent, later.hold.id, "go")).code === 403, "agent cannot approve its hold");
  check((await decide(outsider, later.hold.id, "go", "elsewhere")).code === 403, "another project's owner cannot approve hold");
  check((await decide(owner, later.hold.id, "nogo")).ok, "owner can decide No-go");
  check((await claim("later:alpha")).hold.status === "nogo", "No-go continues blocking");
  check((await decide(owner, later.hold.id, "go")).code === 409, "decided hold cannot be silently overturned");

  await claim("first:alpha", "go.ts");
  const go = await claim("later:alpha", "go.ts");
  const busDir = join(dir, "bus");
  mkdirSync(busDir, { recursive: true });
  writeFileSync(join(busDir, "config.json"), JSON.stringify({ url: hub.base, ownerIdentity: "operator" }));
  mkdirSync(join(busDir, "keys"), { recursive: true });
  const env = drillEnv({ RELAY_URL: hub.base, RELAY_PROJECT: "alpha", RELAY_SESSION: "later:alpha", AGENT_BUS_DIR: busDir });
  // Hook identity uses the same enrolled writer, isolated from the operator's key directory.
  writeFileSync(join(busDir, "keys", "later_alpha.json"), JSON.stringify({ ...agent, name: "later:alpha", kind: "agent" }));
  const hook = (file, tool_name = "Edit") => run("hooks/file-hold.mjs", [], env,
    JSON.stringify({ cwd: root, tool_name, tool_input: { file_path: join(root, file) } }));
  let result = await hook("go.ts");
  check(JSON.parse(result.out).hookSpecificOutput?.permissionDecision === "deny", "real PreToolUse hook denies held Edit");
  check(JSON.parse(result.out).hookSpecificOutput?.permissionDecisionReason.includes("held: file conflict with first:alpha"), "hook reports exact conflicting session");
  writeFileSync(join(busDir, "keys", "operator.json"), JSON.stringify({ ...owner, name: "operator", kind: "human" }));
  const cli = await run("bin/cli.mjs", ["gate", "go", String(go.hold.id)], env);
  check(cli.code === 0 && cli.out.includes("go.ts"), "real trantor gate go command approves hold");
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    result = await hook("go.ts", tool);
    check(result.out === "{}", `Go permits ${tool}, including repeated checks`);
  }
  check((await hook("same.ts")).out.includes("operator decided no-go"), "real hook still blocks No-go");
  await claim("first:alpha", "fresh.ts");
  check((await hook("fresh.ts")).out.includes("held: file conflict"), "first Edit attempt registers and blocks atomically");
  const fresh = (await request(owner, "GET", "/holds?status=pending")).holds.find(h => h.file === "fresh.ts");
  const noCli = await run("bin/cli.mjs", ["gate", "nogo", String(fresh.id)], env);
  check(noCli.code === 0 && (await hook("fresh.ts")).out.includes("operator decided no-go"), "real trantor gate nogo keeps edit blocked");
  const pending = await request(owner, "GET", "/holds?status=pending");
  check(!pending.holds.some(h => h.id === later.hold.id || h.id === go.hold.id), "decided holds leave human decision queue");
  await request(owner, "POST", "/policy", { autonomy: { alpha: 1 } });
  check((await request(owner, "GET", "/holds")).holds.length === 0, "downgrading to Observe clears human decision queue");
  check(!(await claim("later:alpha")).hold && (await claim("later:alpha")).conflicts.length === 0, "Observe returns neither hold nor agent warning");
  result = await run("hooks/file-claim.mjs", [], env, JSON.stringify({ cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "same.ts") } }));
  check(result.out === "{}", "real claim hook stays silent at Observe");
} finally { await hub.stop(); }

const outageBus = join(dir, "outage-bus");
let requests = 0;
const unavailableHub = createServer((_req, res) => { requests++; res.writeHead(503); res.end("{}"); });
await new Promise(resolve => unavailableHub.listen(0, "127.0.0.1", resolve));
try {
  const url = `http://127.0.0.1:${unavailableHub.address().port}`;
  const cache = { project: "alpha", hub: url, busDir: outageBus };
  const env = drillEnv({ RELAY_URL: url, RELAY_PROJECT: "alpha", RELAY_SESSION: "later:alpha", AGENT_BUS_DIR: outageBus });
  const input = JSON.stringify({ cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "offline.ts") } });
  for (const level of [1, 2]) {
    writeOverseerLevel(cache, level);
    const result = await run("hooks/file-hold.mjs", [], env, input);
    check(result.out === "{}" && result.err === "" && requests === 0, `cached level ${level} allows without any network request during outage`);
  }
  writeOverseerLevel(cache, 3);
  const result = await run("hooks/file-hold.mjs", [], env, input);
  check(result.out === "{}" && result.err.includes("hold could not be checked") && requests > 0, "Gate fails open with a one-line notice during hub outage");
} finally { await new Promise(resolve => unavailableHub.close(resolve)); }

try {
  for (const level of [1, 2, 3]) {
    let time = 10000;
    const state = { orgPolicy: { autonomy: { alpha: level } }, tasks: [], verifyGateSeq: 0,
      peers: { a: { project: "alpha", lastSeen: time }, b: { project: "alpha", lastSeen: time } } };
    const claims = new Map([["a", { project: "alpha", file: "x", session: "a", ts: time }], ["b", { project: "alpha", file: "x", session: "b", ts: time }]]);
    const events = [], sends = [];
    const overseer = createOverseer({ state, fileClaims: claims, now: () => time,
      markDirty() {}, appendEvent: (...e) => events.push(e), duty: { session: "duty", hubSend: (...m) => sends.push(m) } });
    while (!overseer.engine || !overseer.sameProject) await sleep(10);
    overseer.overseerTick();
    check(events.some(e => e[0] === "overseer.warn"), `level ${level} records collisions`);
    check(level === 1 ? sends.length === 0 : sends.length > 0, `level ${level} obeys notification boundary`);
    const count = sends.length, eventCount = events.length;
    overseer.overseerTick();
    check(sends.length === count && events.length === eventCount, `level ${level} standing conflict stays quiet`);
    if (level === 3) {
      const hold = overseer.holdFor("alpha", "x", "b");
      check(Boolean(hold), "Gate creates hold during tick too");
      claims.delete("a");
      check(!overseer.holdFor("alpha", "x", "b"), "hold expires when opposing claim ends");
      claims.set("c", { project: "alpha", file: "x", session: "c", ts: time });
      check(Boolean(overseer.holdFor("alpha", "x", "c")), "new claim episode gets a fresh hold");
      time += 600001;
      check(overseer.listHolds().length === 0, "claim TTL expires holds without a claim request");
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`${passed} passed`);
