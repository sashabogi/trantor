#!/usr/bin/env node
// MCP resolves the startup project once, while hooks follow the current directory. A session that
// changes projects can therefore receive as laptop:trantor but send as laptop:operator; name that
// split immediately instead of hiding it.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log("# trantor identity-drift drill");

const hub = http.createServer((req, res) => {
  let b = ""; req.on("data", c => (b += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, messages: [], cursor: 0, peers: [] }));
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

const w = mkdtempSync(join(tmpdir(), "tt-drift-"));
const BUS = join(w, "bus"); mkdirSync(BUS, { recursive: true });
writeFileSync(join(BUS, "config.json"), JSON.stringify({ url: HUB, hubs: { started: HUB, wandered: HUB } }));
for (const n of ["started", "wandered"]) { const d = join(w, n); mkdirSync(d, { recursive: true }); spawnSync("git", ["init", "-q"], { cwd: d }); }

// The hook sees the CURRENT directory in input.cwd; CLAUDE_PROJECT_DIR is the directory the
// SESSION started in, which is exactly what the MCP server is stuck with. Both already exist.
function runHook(cwd, startProject, sessionId = "drift-1") {
  return new Promise((resolve) => {
    const env = { ...drillEnv(), AGENT_BUS_DIR: BUS, RELAY_HOST_ID: "host",
      RELAY_SESSION: "", RELAY_PROJECT: "", RELAY_URL: "" };
    if (startProject) env.CLAUDE_PROJECT_DIR = join(w, startProject);
    const kid = spawn(process.execPath, [join(ROOT, "hooks", "inbox-deliver.mjs")], {
      cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], env,
    });
    let so = ""; kid.stdout.on("data", d => (so += d));
    kid.on("close", () => { let o = {}; try { o = JSON.parse(so || "{}"); } catch {} resolve(o?.hookSpecificOutput?.additionalContext || ""); });
    kid.stdin.end(JSON.stringify({ session_id: sessionId, cwd }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 12000).unref?.();
  });
}

console.log("\nWorking where you started is silent:");
{
  const ctx = await runHook(join(w, "started"), "started", "same-1");
  ok("no drift warning when the directory has not moved", !/identity-drift|two bus identities/i.test(ctx), ctx.slice(0, 160));
}

console.log("\nWalking into another project is announced, once:");
{
  const first = await runHook(join(w, "wandered"), "started", "drift-2");
  ok("the session is told it now has two identities", /identity-drift/.test(first), first.slice(0, 200));
  ok("…naming the one that RECEIVES", /host:wandered/.test(first), first.slice(0, 240));
  ok("…and the one that SENDS", /host:started/.test(first), first.slice(0, 240));
  ok("…and why it matters (sends can fail while reads work)", /relay_send|401|not enrolled|cannot send/i.test(first), first.slice(0, 300));
  ok("…with the way out", /RELAY_PROJECT|start .*from the project/i.test(first), first.slice(0, 300));
  const second = await runHook(join(w, "wandered"), "started", "drift-2");
  ok("it does not nag on every tool call", !/identity-drift/.test(second), second.slice(0, 160));
}

hub.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} identity-drift: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
