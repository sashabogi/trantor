#!/usr/bin/env node
// #12094 — the PostModelSwitch hook tells the hub the session's new model at once (fixture payload
// in the shape Claude Code sends), prints nothing on stdout, and is registered in hooks.json.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  ${detail}` : ""}`); cond ? pass++ : fail++; };

const proj = "model-switch-test-" + process.pid;
const projDir = realpathSync(mkdirSync(join(tmpdir(), proj), { recursive: true }));
const hubDir = join(realpathSync(tmpdir()), `trantor-ms-hub-${process.pid}`);
mkdirSync(hubDir, { recursive: true });
const hub = await startTestHub({ dir: hubDir, env: { RELAY_HOST: "127.0.0.1" } });
const session = `probe:${proj}`;
const run = (payload) => spawnSync("node", ["hooks/model-switch.mjs"], {
  input: JSON.stringify(payload), encoding: "utf8", timeout: 20000, cwd: process.cwd(),
  env: drillEnv({ CLAUDE_PROJECT_DIR: projDir, RELAY_SESSION: session, RELAY_URL: hub.base }),
});
const peerModel = async () => (await (await fetch(`${hub.base}/peers`)).json()).peers?.find(p => p.session === session)?.model;

console.log("# PostModelSwitch hook (#12094)");
try {
  await fetch(`${hub.base}/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, project: proj, llm: "claude", model: "claude-sonnet-5" }) });
  ok("peer starts on the heartbeat's model", (await peerModel()) === "claude-sonnet-5");

  const fixture = { session_id: "abc123", cwd: projDir, hook_event_name: "PostModelSwitch", from_model: "claude-sonnet-5",
    to_model: "claude-opus-5", requested_model: "opus", source: "command", context_tokens: 182340,
    prompt_cache_warm: false, cache_ttl: "5m", estimated_cache_write_usd: 1.14, pricing: "catalog" };
  const r = run(fixture);
  ok("hook exits 0 and prints nothing to stdout", r.status === 0 && r.stdout === "", `${r.status} ${JSON.stringify(r.stdout)}`);
  ok("the peer row now carries the new model", (await peerModel()) === "claude-opus-5", String(await peerModel()));

  const noModel = run({ ...fixture, to_model: undefined });
  ok("a payload without to_model changes nothing", noModel.status === 0 && (await peerModel()) === "claude-opus-5");
  ok("garbage stdin still exits 0", run("not json").status === 0);

  const cfg = JSON.parse(readFileSync("hooks/hooks.json", "utf8")).hooks.PostModelSwitch;
  const h = cfg?.[0]?.hooks?.[0];
  ok("registered in hooks.json with a short timeout", /hooks\/model-switch\.mjs/.test(h?.command || "") && h.timeout > 0 && h.timeout <= 10);
} finally {
  await hub.stop();
  rmSync(hubDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
