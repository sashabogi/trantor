#!/usr/bin/env node
// trantor — idle orchestrator panes retire, working ones never do (#8017).
//
// The morning this card was written, one pane was mid-deploy while five siblings sat idle at the
// identical age. Age qualifies a pane; liveness decides. Every hold below is that rule.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

const bus = mkdtempSync(join(tmpdir(), "tt-retire-"));
process.env.AGENT_BUS_DIR = bus;

const L = await import(join(ROOT, "lib", "retire-panes.mjs"));
const P = await import(join(ROOT, "lib", "project.mjs"));

console.log("# trantor idle-pane retirement drill");

const HOUR = 3600_000;
const now = Date.now();
const pane = (over = {}) => ({
  project: "p", sid: "s1", transcript: "/tmp/t.jsonl", pane: "w1:p1",
  idleMs: 30 * HOUR, agentStatus: "idle", turnInFlight: false,
  openContracts: 0, transcriptMissing: false, ...over,
});

console.log("\nThe threshold is configurable and has an off switch:");
ok("default is 24h", L.retireHours({ env: {}, config: {} }) === L.DEFAULT_RETIRE_HOURS && L.DEFAULT_RETIRE_HOURS === 24);
ok("env overrides it", L.retireHours({ env: { TRANTOR_PANE_RETIRE_HOURS: "6" }, config: {} }) === 6);
ok("config overrides the default", L.retireHours({ env: {}, config: { paneRetireHours: 48 } }) === 48);
ok("0 disables retirement outright", !L.retireEnabled(L.retireHours({ env: { TRANTOR_PANE_RETIRE_HOURS: "0" }, config: {} })));

console.log("\nIdle age alone never retires a pane — liveness decides:");
ok("a mid-turn pane is held at 30h idle",
  L.retireDecision(pane({ turnInFlight: true }), { hours: 24 }).retire === false);
ok("…and the hold says why", /mid-turn/.test(L.retireDecision(pane({ turnInFlight: true }), { hours: 24 }).reason));
ok("a pane herdr reports WORKING is held at 30h idle",
  L.retireDecision(pane({ agentStatus: "working" }), { hours: 24 }).retire === false);
ok("a pane holding an in-flight contract is held at 30h idle",
  L.retireDecision(pane({ openContracts: 2 }), { hours: 24 }).retire === false);
ok("…and the hold names the contracts", /contract/.test(L.retireDecision(pane({ openContracts: 2 }), { hours: 24 }).reason));
ok("a pane with no transcript is held (nothing to hand off)",
  L.retireDecision(pane({ transcriptMissing: true }), { hours: 24 }).retire === false);
ok("a quiet pane UNDER the threshold is held",
  L.retireDecision(pane({ idleMs: 3 * HOUR }), { hours: 24 }).retire === false);
ok("a genuinely idle pane past the threshold retires",
  L.retireDecision(pane(), { hours: 24 }).retire === true);
ok("the working pane and the idle pane are at the SAME age",
  pane({ turnInFlight: true }).idleMs === pane().idleMs);
ok("a mid-turn transcript whose process is PROVABLY gone is a corpse, not work",
  L.retireDecision(pane({ turnInFlight: true, processState: "dead" }), { hours: 24 }).retire === true);
ok("…but an unproven process still holds the pane open",
  L.retireDecision(pane({ turnInFlight: true, processState: "unknown" }), { hours: 24 }).retire === false);

console.log("\nIdle age is read from the transcript, not from an LLM:");
{
  const t = join(bus, "t.jsonl");
  writeFileSync(t, "{}\n");
  const idle = L.idleMsFor(t, now + 5 * HOUR);
  ok("mtime age is the signal", idle !== null && idle >= 5 * HOUR - 1000 && idle <= 5 * HOUR + 60_000, `got ${idle}`);
  ok("a missing transcript yields no age, never zero", L.idleMsFor(join(bus, "nope.jsonl"), now) === null);
}

console.log("\nThe session map is the wake-target register, and retirement clears it:");
{
  P.writeOrchSession("alpha", "sid-alpha", "drill");
  P.writeOrchSession("beta", "sid-beta", "drill");
  ok("both projects are mapped", L.orchSessionRows().length === 2);
  ok("clearing one drops only that row", P.clearOrchSession("alpha", "drill") === true
    && P.readOrchSession("alpha") === "" && P.readOrchSession("beta") === "sid-beta");
  ok("the rewrite is attributable in orch-sessions.log",
    readFileSync(join(bus, "orch-sessions.log"), "utf8").includes("alpha\tsid-alpha\t-\tdrill"));
  ok("clearing an unmapped project is a no-op", P.clearOrchSession("gamma", "drill") === false);
}

console.log("\nA retired pane is distinguishable from a crashed one:");
{
  const ledger = L.retiredLedgerPath();
  ok("nothing is retired before anything retires", L.isRetired("sid-beta") === false);
  L.recordRetirement({ ts: now, project: "beta", sid: "sid-beta", retired: true, resume: "claude --resume sid-beta" }, ledger);
  ok("the ledger records the retirement", L.isRetired("sid-beta") === true);
  ok("a pane that merely vanished is NOT retired", L.isRetired("sid-crashed") === false);
  ok("the checkpoint names the resume command",
    L.retiredRows(ledger).some(r => r.resume === "claude --resume sid-beta"));
}

console.log("\nherdr's tracked orchestrator row goes with the pane:");
{
  const cw = L.crewWindowsPath();
  writeFileSync(cw, "beta\torch\t\tw2:p3\nbeta\therdr\tglm\tw2:p9\n");
  ok("the orch pane id is resolved from the row", L.orchPaneRow("beta") === "w2:p3");
  ok("dropping it removes only the orch row", L.dropOrchRow("beta") === true
    && readFileSync(cw, "utf8") === "beta\therdr\tglm\tw2:p9\n");
  ok("dropping again is a no-op", L.dropOrchRow("beta") === false);
}

console.log("\nRetirement writes the handoff FIRST, through the existing writer:");
{
  const calls = [];
  const out = await L.retirePane(
    { project: "beta", sid: "sid-beta", transcript: "/tmp/t.jsonl", pane: "", idleMs: 30 * HOUR, reason: "idle 30h" },
    {
      now, by: "drill", ledger: join(bus, "retired2.jsonl"),
      buildSummary: () => { calls.push("buildSummary"); return "what happened"; },
      writeHandoff: (a) => { calls.push(`writeHandoff:${a.trigger}:${a.summary}`); return { file: join(bus, "h.json") }; },
      clearMap: () => { calls.push("clearMap"); return true; },
      exec: () => { calls.push("herdr"); return "{}"; },
    });
  ok("the existing summariser is what composes it", calls.includes("buildSummary"));
  ok("the existing handoff writer is what saves it", calls.some(c => c.startsWith("writeHandoff:idle-retire:what happened")));
  ok("no second summariser was written",
    !existsSync(join(ROOT, "lib", "retire-summary.mjs")) && !/function\s+\w*[Ss]ummari[sz]e/.test(readFileSync(join(ROOT, "lib", "retire-panes.mjs"), "utf8")));
  ok("the handoff is written BEFORE the map is cleared",
    calls.indexOf("writeHandoff:idle-retire:what happened") < calls.indexOf("clearMap"));
  ok("the checkpoint lands before the pane is unmapped",
    L.retiredRows(join(bus, "retired2.jsonl")).some(r => r.sid === "sid-beta"));
  ok("the checkpoint carries the resume command",
    out.entry.resume === "claude --resume sid-beta");
  ok("the steps are reported in order",
    out.steps[0] === "handoff" && out.steps[1] === "checkpoint" && out.steps[2] === "unmap", out.steps.join(","));
  ok("a pane with no id says so rather than closing nothing silently",
    out.steps.some(s => s.startsWith("close-pane-skipped")));
}

console.log("\nThe CLI previews before it acts:");
{
  const src = readFileSync(join(ROOT, "bin", "retire.mjs"), "utf8");
  ok("--yes is required to perform anything", /if \(!APPLY\)/.test(src) && /--yes to retire/.test(src));
  ok("an unreadable contract count fails CLOSED", /return 1;/.test(src) && /fail CLOSED/i.test(src));
  ok("`trantor retire` is wired into the CLI",
    /case "retire": run\("bin\/retire.mjs"\)/.test(readFileSync(join(ROOT, "bin", "cli.mjs"), "utf8")));
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
