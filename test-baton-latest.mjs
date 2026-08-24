#!/usr/bin/env node
// trantor — passing the baton on a handoff you ALREADY wrote.
//
// Observed 2026-08-24 on a live crebral-scribe session. The handoff was on disk and unconsumed
// (5,245 chars, trigger "manual-skill"). The operator said "run the trantor handoff command and
// that will do it automatically". The seat tried to baton the existing file, the auto-mode
// classifier blocked the raw invocation, and the sanctioned fallback — the /trantor:handoff skill —
// opens by telling the model to COMPOSE a six-section handoff. So it regenerated 5KB of prose it
// had just written: 2m28s of the 3-4 minutes the whole thing took.
//
// write-handoff.mjs had exactly one flag, --baton, and content had to arrive on stdin. "I already
// wrote it, now pass the baton" was not expressible.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log("# trantor baton-on-an-existing-handoff drill");

function run(args, { seed = null, stdin = "" } = {}) {
  const w = mkdtempSync(join(tmpdir(), "tt-baton-"));
  const BUS = join(w, ".agent-bus"); mkdirSync(join(BUS, "handoffs"), { recursive: true });
  const proj = join(w, "crebral-scribe"); mkdirSync(proj, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  if (seed) writeFileSync(join(BUS, "handoffs", `${seed.id}.json`), JSON.stringify(seed, null, 2));
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "write-handoff.mjs"), ...args], {
    input: stdin, encoding: "utf8", timeout: 20000, cwd: proj,
    // TRANTOR_NO_SPAWN keeps the drill from opening real Terminal windows
    env: { ...process.env, HOME: w, AGENT_BUS_DIR: BUS, RELAY_DATA_DIR: BUS,
           CLAUDE_PROJECT_DIR: proj, TRANTOR_NO_SPAWN: "1" },
  });
  const files = readdirSync(join(BUS, "handoffs"));
  return { out: (r.stdout || "") + (r.stderr || ""), status: r.status, files, BUS };
}

const seeded = {
  id: "crebral-scribe-1787600490", project: "/x/crebral-scribe", projectName: "crebral-scribe",
  stamp: 1787600490, summary: "SEEDED HANDOFF — 5245 chars of work already composed", consumed: false,
};

console.log("\nA handoff already on disk can be batoned without rewriting it:");
{
  const r = run(["--baton", "--latest"], { seed: seeded });
  ok("the command is understood at all", r.status === 0, `exit ${r.status}: ${r.out.slice(0, 160)}`);
  ok("it picks up the EXISTING handoff", /crebral-scribe-1787600490/.test(r.out), r.out.slice(0, 200));
  ok("it does NOT write a second one", r.files.length === 1, `${r.files.length} files: ${r.files.join(", ")}`);
  ok("…and says it is passing the baton", /baton/i.test(r.out), r.out.slice(0, 200));
}

console.log("\nIt refuses rather than guessing when there is nothing to hand over:");
{
  const r = run(["--baton", "--latest"], { seed: null });
  ok("no handoff means a clear error, not a silent no-op", r.status !== 0 && /no .*handoff/i.test(r.out), `exit ${r.status}: ${r.out.slice(0, 160)}`);
}

console.log("\nAn already-consumed handoff is not re-handed:");
{
  const r = run(["--baton", "--latest"], { seed: { ...seeded, consumed: true } });
  ok("a consumed handoff is skipped", r.status !== 0 && /no .*handoff/i.test(r.out), `exit ${r.status}: ${r.out.slice(0, 160)}`);
}

console.log("\nThe original stdin path is untouched:");
{
  const r = run([], { stdin: "# fresh handoff\nwritten the old way\n" });
  ok("piping on stdin still writes a handoff", r.status === 0 && r.files.length === 1, `${r.out.slice(0, 140)}`);
  const rec = JSON.parse(readFileSync(join(r.BUS, "handoffs", r.files[0]), "utf8"));
  ok("…with the piped content", /written the old way/.test(rec.summary || ""), (rec.summary || "").slice(0, 80));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} baton-latest: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
