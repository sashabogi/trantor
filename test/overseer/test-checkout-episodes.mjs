#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startTestHub, freePort } from "../lib/test-hub.mjs";
import { drillEnv } from "../drill-env.mjs";
import { detectCollisions } from "../../lib/overseer.mjs";
import { gitCheckoutRoot } from "../../hooks/lib/git-checkout.mjs";
import { PgStore } from "../../lib/store-pg.mjs";

const root = resolve(import.meta.dirname, "../..");
mkdirSync(join(root, ".agent-bus-out"), { recursive: true });
const dir = mkdtempSync(join(root, ".agent-bus-out/checkouts-"));
const checkout = join(dir, "checkout"), nested = join(checkout, "src");
mkdirSync(nested, { recursive: true });
execFileSync("git", ["init", "-q", checkout]);
let passed = 0;
const check = (value, name) => { assert.ok(value, name); console.log(`ok ${++passed} - ${name}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(read, predicate) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error("timed out waiting for episode persistence");
}
function runHook(script, project, session, cwd, base, fixtureHome) {
  const bus = join(fixtureHome, ".agent-bus");
  mkdirSync(bus, { recursive: true });
  for (const stamp of ["summarize.stamp", "narrate.stamp"]) writeFileSync(join(bus, stamp), String(Date.now()));
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(root, "hooks", script)], {
      cwd: root, env: drillEnv({ HOME: fixtureHome, AGENT_BUS_DIR: bus, RELAY_URL: base,
        RELAY_PROJECT: project, RELAY_SESSION: session, RELAY_HEARTBEAT_MS: "0" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", c => { out += c; });
    child.stderr.on("data", c => { err += c; });
    child.on("error", reject);
    child.on("close", code => done({ code, out, err }));
    child.stdin.end(JSON.stringify({ cwd, tool_name: "Edit", tool_input: { file_path: join(checkout, "src/shared.ts") } }));
  });
}

async function exercise(backend, env, observer) {
  const data = join(dir, backend);
  let hub = await startTestHub({ dir: data, env: { RELAY_AUTH: "off", RELAY_OVERSEER_TICK_MS: "100", ...env } });
  const post = async (path, body) => {
    const response = await fetch(hub.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return response.json();
  };
  const get = path => fetch(hub.base + path).then(r => r.json());
  const snapshot = observer ? () => observer.loadSnapshot("local") : async () => {
    try { return JSON.parse(readFileSync(join(data, "bus.json"), "utf8")); } catch { return {}; }
  };
  try {
    await post("/policy", { autonomy: { alpha: 2, beta: 2 } });
    for (const [project, session, cwd] of [["alpha", "first:alpha", checkout], ["beta", "second:beta", nested]]) {
      const result = await runHook("heartbeat.mjs", project, session, cwd, hub.base, join(data, session));
      check(result.code === 0, `${backend}: real heartbeat succeeds for ${project}`);
    }
    const roots = await until(snapshot, s => s.overseerState?.roots?.["second:beta"]);
    check(roots.overseerState.roots["first:alpha"] === gitCheckoutRoot(checkout) && roots.overseerState.roots["second:beta"] === gitCheckoutRoot(checkout), `${backend}: heartbeats report the same git root from nested cwd`);
    await runHook("file-claim.mjs", "alpha", "first:alpha", checkout, hub.base, join(data, "first:alpha"));
    const second = await runHook("file-claim.mjs", "beta", "second:beta", nested, hub.base, join(data, "second:beta"));
    check(second.out.includes("first:alpha"), `${backend}: later writer receives conflict before its edit`);
    const messageRows = (await get("/events?type=message&limit=100")).events;
    const warnings = messageRows.filter(e => e.text?.includes("OVERSEER file-conflict"));
    check(warnings.length === 2 && warnings.some(e => e.toSession === "first:alpha") && warnings.some(e => e.toSession === "second:beta"), `${backend}: both writers warned synchronously at claim time`);
    const context = await get("/overseer/context?project=beta");
    const file = context.warnings.find(w => w.kind === "file-conflict");
    check(file?.files[0] === "src/shared.ts" && file.sessions.length === 2, `${backend}: different labels resolve to one checkout/file collision`);
    check(file.since > 0, `${backend}: collision reports its original start time`);
    await post("/claim", { project: "beta", session: "second:beta", gitRoot: gitCheckoutRoot(checkout), file: "src/shared.ts" });
    check((await get("/events?type=message&limit=100")).events.filter(e => e.text?.includes("OVERSEER file-conflict")).length === 2, `${backend}: reclaim does not repeat warnings`);
    await until(snapshot, s => s.overseerState?.active?.some(([, ep]) => ep.since === file.since && ep.sessions.includes("second:beta")) && s.overseerState?.claims?.length === 2);
    await hub.stop();
    hub = await startTestHub({ dir: data, env: { RELAY_AUTH: "off", RELAY_OVERSEER_TICK_MS: "100", ...env } });
    await until(() => get("/overseer/context?project=beta"), c => c.warnings?.some(w => w.kind === "file-conflict"));
    const restored = (await get("/overseer/context?project=beta")).warnings.find(w => w.kind === "file-conflict");
    check(restored.since === file.since && restored.detail.includes("standing for"), `${backend}: restart preserves original duration`);
    check((await get("/events?type=message&limit=100")).events.filter(e => e.text?.includes("OVERSEER file-conflict")).length === 2, `${backend}: hub restart does not re-warn standing collision`);
    const state = await snapshot();
    check(state.overseerState.sameProjectFired.length === 1, `${backend}: same-project verdict persisted with episode state`);
    await post("/policy", { autonomy: { beta: 3 } });
    const held = await post("/hold/check", { project: "beta", session: "second:beta", gitRoot: gitCheckoutRoot(checkout), file: "src/shared.ts" });
    check(held.hold?.other === "first:alpha", `${backend}: Gate holds later writer across project labels`);
    await until(snapshot, s => s.overseerState?.holds?.some(([, h]) => h.id === held.hold.id));
    await hub.stop();
    hub = await startTestHub({ dir: data, env: { RELAY_AUTH: "off", RELAY_OVERSEER_TICK_MS: "100", ...env } });
    const recoveredHold = await post("/hold/check", { project: "beta", session: "second:beta", gitRoot: gitCheckoutRoot(checkout), file: "src/shared.ts" });
    check(recoveredHold.hold?.id === held.hold.id, `${backend}: restart preserves the pending hold identity`);
    check((await get("/events?type=hold.opened&limit=100")).events.length === 1, `${backend}: restart does not repeat the human hold notification`);
    const elsewhere = await post("/hold/check", { project: "beta", session: "second:beta", gitRoot: join(dir, "another-checkout"), file: "src/shared.ts" });
    check(!elsewhere.hold, `${backend}: changing checkout does not inherit the old file hold`);
  } finally { await hub.stop(); }
}

let pgStarted = false, observer;
try {
  check(gitCheckoutRoot(nested) === gitCheckoutRoot(checkout), "git root helper canonicalizes nested directories");
  const now = Date.now();
  const claim = (project, session, gitRoot) => ({ project, session, gitRoot, file: "src/shared.ts", ts: now });
  const same = detectCollisions({ claims: [claim("alpha", "a", checkout), claim("beta", "b", checkout)], now });
  check(same.filter(c => c.kind === "file-conflict").length === 1, "detector groups different labels over one checkout");
  const separate = detectCollisions({ claims: [claim("alpha", "a", checkout), claim("alpha", "b", join(dir, "another-checkout"))], now });
  check(!separate.some(c => c.kind === "file-conflict"), "different checkouts sharing a label and relative path do not collide");
  await exercise("json", {});
  const pgData = join(dir, "pg-data");
  execFileSync("initdb", ["-D", pgData, "-U", "trantor", "-A", "trust", "--no-locale", "-E", "UTF8"], { stdio: "ignore" });
  const port = await freePort();
  execFileSync("pg_ctl", ["-D", pgData, "-o", `-h 127.0.0.1 -p ${port} -k ''`, "-l", join(dir, "pg.log"), "-w", "start"], { stdio: "ignore" });
  pgStarted = true;
  const url = `postgres://trantor@127.0.0.1:${port}/postgres`;
  observer = new PgStore({ url });
  await observer.init();
  await exercise("postgres", { RELAY_STORE: "pg", RELAY_DATABASE_URL: url, RELAY_ORG_ID: "local" }, observer);
} finally {
  if (observer) await observer.close();
  if (pgStarted) execFileSync("pg_ctl", ["-D", join(dir, "pg-data"), "-w", "-m", "fast", "stop"], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed`);
