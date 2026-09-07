#!/usr/bin/env node
// trantor test runner (#6447) — `npm test` is exactly this one command.
//
// What it does, in order:
//   1. Scrubs the RUNNER'S OWN identity env at the top (HERDR_PANE_ID, TRANTOR_ORCH, ... — the
//      vars lib/drill-env.mjs's resolvers read first). A suite must depend on the drill's env,
//      never on who ran the suite; drillEnv()/scrubIdentityEnv() still guard per-spawn, this is
//      the belt to that braces (#6228/#6074 bounces, test-crew.sh's unset).
//   2. Runs the paid-off slop-gate surface (desktop/src) as a hard preamble, as npm test always did.
//   3. Discovers every suite under test/<subsystem>/ (test-*.mjs, test-*.sh, test.mjs) plus the two
//      non-file members the old &&-chain carried (desktop vitest, engine/test-routing.py) and runs
//      them IN PARALLEL with a per-suite timeout. Suites inherit cwd = repo root, because each was
//      written to spawn bin/ and hooks/ by relative path from the package root.
//   4. test/quarantine/<subsystem>/ is the TIMING LANE: quarantined suites still run and their red
//      is REPORTED, but it does not fail the gate — IF the manifest entry (card + one-week expiry)
//      is current. An expired entry un-quarantines: its red gates again, so quarantine cannot
//      become a landfill (fix the drill or re-card it before the week is out).
//
// Seat-scoped runs: `node test/run.mjs --only crew` runs matching suites only; `--list` prints
// the discovered suites. The full gate is `npm test` (CI runs exactly that, no unset preamble
// needed any more — step 1 happens here).
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";import { fileURLToPath } from "node:url";
import { DRILL_IDENTITY_VARS } from "./drill-env.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);

// ---- 1. the runner must not lend its own identity to any suite ----
for (const k of DRILL_IDENTITY_VARS) delete process.env[k];

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at > -1 ? argv[at + 1] : null;
};
const LIST = argv.includes("--list");
const ONLY = flag("--only");
const TIMEOUT_MS = Number(flag("--timeout") || process.env.RUN_SUITE_TIMEOUT_MS || 150_000);
const CONCURRENCY = Number(flag("--concurrency") || process.env.RUN_SUITE_CONCURRENCY || 6);
const QUARANTINE_DIR = join(ROOT, "test", "quarantine");

// ---- 2. paid-off surface gate (was the first link of the old &&-chain) ----
if (!LIST) {
  const gate = spawnSync(process.execPath, [join("bin", "slop-gate.mjs"), "--surface", "desktop/src"], { stdio: "inherit" });
  if (gate.status !== 0) {
    console.error("\nslop-gate (desktop/src surface) FAILED — suite not started.");
    process.exit(gate.status ?? 1);
  }
}

// ---- discovery ----
function discover() {
  const suites = [];
  for (const sub of readdirSync(join(ROOT, "test"))) {
    const subPath = join(ROOT, "test", sub);
    if (sub === "quarantine" || !statSync(subPath).isDirectory()) continue;
    for (const f of readdirSync(subPath)) {
      if (f === "test.mjs" || /^test-[\w.-]+\.(mjs|sh)$/.test(f)) suites.push({ rel: `test/${sub}/${f}`, lane: "gate" });
    }
  }
  if (existsSync(QUARANTINE_DIR)) {
    for (const sub of readdirSync(QUARANTINE_DIR)) {
      const subPath = join(QUARANTINE_DIR, sub);
      if (sub === "MANIFEST.json" || !statSync(subPath).isDirectory()) continue;
      for (const f of readdirSync(subPath)) {
        if (/^test-[\w.-]+\.(mjs|sh)$/.test(f)) suites.push({ rel: `test/quarantine/${sub}/${f}`, lane: "quarantine" });
      }
    }
  }
  suites.push(
    { rel: "desktop-vitest", lane: "gate", cmd: ["npm", ["--prefix", "desktop", "run", "test", "--silent"]] },
    { rel: "routing-py", lane: "gate", cmd: ["python3", ["engine/test-routing.py"]] },
  );
  suites.sort((a, b) => a.rel.localeCompare(b.rel));
  return suites;
}

const suites = discover();

// quarantine manifest must be exact: every lane file has a current entry, every entry has a file
const manifestPath = join(QUARANTINE_DIR, "MANIFEST.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { entries: [] };
const laneFiles = suites.filter(s => s.lane === "quarantine").map(s => s.rel);
const stray = laneFiles.filter(f => !manifest.entries.some(e => e.suite.endsWith(f.split("/").pop())));
const ghosted = manifest.entries.filter(e => !existsSync(join(ROOT, "test", e.suite)));
if (stray.length || ghosted.length) {
  console.error("test/quarantine lane is inconsistent (fix before shipping):");
  for (const f of stray) console.error(`  - test/${f}: quarantined file has NO manifest entry (add card + expiry)`);
  for (const e of ghosted) console.error(`  - ${e.suite}: manifest entry has NO file (fix or remove)`);
  process.exit(1);
}
const today = new Date().toISOString().slice(0, 10);
const entryFor = (rel) => manifest.entries.find(e => e.suite.endsWith(rel.split("/").pop()));
const expired = (e) => !e || !e.expires || e.expires < today;

if (LIST) {
  for (const s of suites) {
    const e = entryFor(s.rel);
    console.log(`${s.lane === "quarantine" ? (expired(e) ? "quarantine-EXPIRED" : "quarantine") : "gate       "}  ${s.rel}${e ? `  (card #${e.card}, expires ${e.expires})` : ""}`);
  }
  process.exit(0);
}

const selected = ONLY ? suites.filter(s => s.rel.includes(ONLY)) : suites;
if (!selected.length) { console.error(`no suite matches --only ${ONLY}`); process.exit(1); }

// ---- 3. run in parallel, per-suite timeout, process-group kill ----
function runSuite(s) {
  const [cmd, args] = s.cmd || (s.rel.endsWith(".sh") ? ["bash", [s.rel]] : [process.execPath, [s.rel]]);
  return new Promise((resolveRun) => {
    const started = Date.now();
    const kid = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-kid.pid, "SIGKILL"); } catch { try { kid.kill("SIGKILL"); } catch {} }
    }, TIMEOUT_MS);
    kid.stdout.on("data", d => (out += d));
    kid.stderr.on("data", d => (out += d));
    kid.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ ...s, code, signal, timedOut, out, ms: Date.now() - started });
    });
  });
}

const queue = [...selected];
const results = [];
async function worker() {
  while (queue.length) {
    const s = queue.shift();
    process.stdout.write(`  … ${s.rel}\n`);
    results.push(await runSuite(s));
  }
}
console.log(`\n# trantor suite: ${selected.length} suites, concurrency ${CONCURRENCY}, timeout ${TIMEOUT_MS / 1000}s\n`);
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));

// ---- 4. report ----
const lane = (r) => {
  if (r.lane === "gate") return "gate";
  return expired(entryFor(r.rel)) ? "quarantine-EXPIRED" : "quarantine";
};
const failed = results.filter(r => r.code !== 0);
const gateRed = failed.filter(r => lane(r) !== "quarantine");
const quarRed = failed.filter(r => lane(r) === "quarantine");
const expiredGreen = results.filter(r => r.code === 0 && lane(r) === "quarantine-EXPIRED");

for (const r of failed) {
  console.log(`\n✗ ${r.rel} [${lane(r)}] exit=${r.code}${r.timedOut ? " TIMEOUT" : ""} (${(r.ms / 1000).toFixed(1)}s)`);
  console.log(r.out.split("\n").slice(-40).join("\n"));
}
for (const r of expiredGreen) console.log(`\n⚠ ${r.rel}: quarantine entry EXPIRED (card #${entryFor(r.rel).card}, was ${entryFor(r.rel).expires}) and the suite is GREEN — fix the drill back into the gate or drop the entry.`);
if (quarRed.length) console.log(`\nquarantine lane (reported, not gating): ${quarRed.map(r => r.rel).join(", ")}`);

const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(`\n${results.length} suites: ${results.length - failed.length} green, ${gateRed.length} red (gate), ${quarRed.length} red (quarantine) — slowest: ${slowest.map(r => `${r.rel.split("/").pop()} ${(r.ms / 1000).toFixed(1)}s`).join(", ")}`);
process.exit(gateRed.length ? 1 : 0);
