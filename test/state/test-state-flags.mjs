#!/usr/bin/env node
// #7159 drill — the runner's Trantor State flags resolve through ONE place: process env first,
// ~/.agent-bus/.env second. A flag set ONLY in the file must reach the runner (the file the turn
// wrapper sources sits one level below the runner), and a process-env value must win over the file.
// The doctor must print each flag with the layer that answered.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";
import { resolveStateFlags } from "../../lib/state/flags.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor state-flag resolution drill");

// ---- unit: the resolver ------------------------------------------------------------------------
console.log("\n## the resolver");
{
  const file = join(mkdtempSync(join(tmpdir(), "tt-flags-")), ".env");
  writeFileSync(file, "# crew layer\nTRANTOR_STATE_ASSEMBLE=1\nTRANTOR_STATE_GATE=node test/run.mjs\n");
  const r = resolveStateFlags({}, file);
  ok("a flag set ONLY in the file is seen, named by its layer",
    r.TRANTOR_STATE_ASSEMBLE.value === "1" && r.TRANTOR_STATE_ASSEMBLE.layer === "~/.agent-bus/.env (crew)",
    JSON.stringify(r.TRANTOR_STATE_ASSEMBLE));
  ok("a second file flag resolves too",
    r.TRANTOR_STATE_GATE.value === "node test/run.mjs" && r.TRANTOR_STATE_GATE.layer === "~/.agent-bus/.env (crew)",
    JSON.stringify(r.TRANTOR_STATE_GATE));
  ok("a flag in neither layer is unset",
    r.TRANTOR_STATE_HANDOFF.value === "" && r.TRANTOR_STATE_HANDOFF.layer === "unset",
    JSON.stringify(r.TRANTOR_STATE_HANDOFF));
  const both = resolveStateFlags({ TRANTOR_STATE_ASSEMBLE: "0" }, file);
  ok("a process-env value wins over the file, even when it turns the flag OFF",
    both.TRANTOR_STATE_ASSEMBLE.value === "0" && both.TRANTOR_STATE_ASSEMBLE.layer === "process env",
    JSON.stringify(both.TRANTOR_STATE_ASSEMBLE));
  const missing = resolveStateFlags({}, join(file, "nope"));
  ok("a missing file is not an error — every flag reads unset",
    missing.TRANTOR_STATE_ASSEMBLE.layer === "unset" && missing.TRANTOR_STATE_GATE.layer === "unset");
}

// ---- the real runner, against a mock hub -------------------------------------------------------
// The armed boot line is the observable: it prints only when the runner itself saw the flag
// through the resolver, and it now names the layer that answered.
let queued = [];
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (P === "/poll") return setTimeout(() => reply({ messages: [], cursor: 1 }), 250);
    if (P === "/inbox") return reply({ messages: queued.splice(0), cursor: 0 });
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

async function runnerDrill({ fileLine, envFlag } = {}) {
  const work = mkdtempSync(join(tmpdir(), "tt-flags-run-"));
  const HOME = join(work, "home");
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  if (fileLine) writeFileSync(join(HOME, ".agent-bus", ".env"), `${fileLine}\n`);
  const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
  const PROJ = "tt-flags";
  // --help has to carry --json-schema or hasJsonSchemaFlag() refuses and state mode never arms,
  // which would make these drills pass for the wrong reason.
  writeFileSync(join(fakebin, "claude"), `#!/bin/sh
case "$1" in --help) echo "  --json-schema <file>  hold the run to a grammar"; exit 0;; esac
echo "claude-drill: turn done"
exit 0
`);
  chmodSync(join(fakebin, "claude"), 0o755);
  const env = drillEnv({
    HOME, PATH: `${fakebin}:${process.env.PATH}`,
    RELAY_URL: HUB, RELAY_AGENT: "claude", RELAY_PROJECT: PROJ,
    CREW_KICKOFF: "say hi and end your turn",
  });
  if (envFlag !== undefined) env.TRANTOR_STATE_ASSEMBLE = envFlag;
  const runner = spawn("node", ["bin/crew-runner.mjs", "claude", work], {
    cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], env,
  });
  let out = "";
  runner.stdout.on("data", c => (out += c));
  await sleep(6000);
  runner.kill("SIGKILL"); await sleep(150);
  return { out, schema: join(HOME, ".agent-bus", `state-schema-claude-${PROJ}.json`) };
}

console.log("\n## the real runner");
{
  const r = await runnerDrill({ fileLine: "TRANTOR_STATE_ASSEMBLE=1" });
  ok("#7159: a flag set ONLY in ~/.agent-bus/.env arms the runner",
    /Trantor State: ASSEMBLE armed/.test(r.out), r.out.slice(0, 600));
  ok("#7159: the boot line names the layer that answered",
    /via ~\/\.agent-bus\/\.env \(crew\)/.test(r.out), r.out.slice(0, 600));
  ok("#7159: the schema file is written — the cheap test that state mode is really on",
    existsSync(r.schema), r.schema);
}
{
  const r = await runnerDrill({ fileLine: "TRANTOR_STATE_ASSEMBLE=1", envFlag: "0" });
  ok("#7159: a process-env value wins over the file — =0 in the env keeps state mode OFF",
    !/ASSEMBLE armed/.test(r.out), r.out.slice(0, 600));
  ok("#7159: the runner still booted and turned, so the OFF is precedence, not a crash",
    /turn starting/.test(r.out), r.out.slice(0, 600));
}
{
  const r = await runnerDrill({ fileLine: "TRANTOR_STATE_ASSEMBLE=0", envFlag: "1" });
  ok("#7159: the process layer arms what the file turned off, and says so",
    /Trantor State: ASSEMBLE armed/.test(r.out) && /via process env/.test(r.out), r.out.slice(0, 600));
}

// ---- the doctor --------------------------------------------------------------------------------
const doctorJson = (env) => {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "doctor.mjs"), "--json"], { encoding: "utf8", env, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  const last = String(r.stdout || "").trim().split("\n").pop();
  try { return JSON.parse(last); } catch { return { ok: [], raw: String(r.stdout || "") + String(r.stderr || "") }; }
};
const docHome = (envLine) => {
  const HOME = mkdtempSync(join(tmpdir(), "tt-flags-doc-"));
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  writeFileSync(join(HOME, ".agent-bus", ".env"), `${envLine}\n`);
  writeFileSync(join(HOME, ".agent-bus", "config.json"), JSON.stringify({ url: HUB }));
  return HOME;
};

console.log("\n## the doctor");
{
  const report = doctorJson(drillEnv({ HOME: docHome("TRANTOR_STATE_ASSEMBLE=1"), RELAY_URL: HUB }));
  const lines = (report.ok || []).map(m => m.message || m).filter(m => /TRANTOR_STATE/.test(m));
  ok("#7159: the doctor prints the flag and names the file layer that answered",
    lines.includes("TRANTOR_STATE_ASSEMBLE=1 via ~/.agent-bus/.env (crew)"), JSON.stringify(lines));
  ok("#7159: the doctor never counts an unset flag as an issue — dark is the default",
    !/Trantor State/.test(JSON.stringify(report.issues || [])), JSON.stringify((report.issues || []).filter(i => /state flag/i.test(i.message || ""))));
}
{
  const report = doctorJson(drillEnv({ HOME: docHome("TRANTOR_STATE_ASSEMBLE=0"), RELAY_URL: HUB, TRANTOR_STATE_ASSEMBLE: "1" }));
  const lines = (report.ok || []).map(m => m.message || m).filter(m => /TRANTOR_STATE/.test(m));
  ok("#7159: the doctor prints the process layer as the one that answered",
    lines.includes("TRANTOR_STATE_ASSEMBLE=1 via process env"), JSON.stringify(lines));
}

hub.close();
console.log(`\n${fail ? "FAIL" : "PASS"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
