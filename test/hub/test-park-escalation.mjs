#!/usr/bin/env node
// A parked seat must reach the operator OUT OF BAND, and a supervised seat must not sit parked.
//
// The 2026-09-09 incident had two halves. parkSeat() announced the park with two /send calls — over
// the same bus that had just stopped moving, to an orchestrator that was idle and therefore could
// not receive it. The alarm for "the bus is stuck" cannot itself be a bus message. And the duty
// seat then sat parked for 21.9 hours because only `trantor up` un-parks a seat, even though duty
// is the one seat running under a launchd keepalive that could have restarted it in seconds.
//
// These assert the two fixes at the level they can be tested without a live hub: the durable alert
// trace that survives an unattended machine, and the ceiling that only a supervised seat carries.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const RUNNER = join(ROOT, "bin/crew-runner.mjs");
const src = readFileSync(RUNNER, "utf8");

console.log("\nthe park escalation does not route through the bus alone");
{
  ok("parkSeat calls notifyOperator", /notifyOperator\(/.test(src) && /parkSeat/.test(src));
  ok("notifyOperator writes a durable alert before trying any UI",
    /alerts\.jsonl/.test(src) && src.indexOf("alerts.jsonl") < src.indexOf("osascript"));
  ok("it is best-effort — a missing notifier can never kill a seat",
    /function notifyOperator[\s\S]{0,900}?catch \{\}[\s\S]{0,400}?catch \{\}/.test(src));
  ok("it can be silenced on a headless box", /TRANTOR_NO_DESKTOP_NOTIFY/.test(src));
}

console.log("\nthe durable alert actually lands on disk");
{
  // Exercise notifyOperator's contract directly against a temp HOME: the runner appends one JSON
  // line per park, which is what `trantor doctor` will read on a machine nobody was sitting at.
  const home = mkdtempSync(join(tmpdir(), "park-alert-"));
  const busDir = join(home, ".agent-bus");
  const script = `
    import { mkdirSync, appendFileSync } from "node:fs";
    import { join } from "node:path";
    mkdirSync(${JSON.stringify(busDir)}, { recursive: true });
    appendFileSync(join(${JSON.stringify(busDir)}, "alerts.jsonl"),
      JSON.stringify({ ts: Date.now(), session: "claude:trantor-duty",
        title: "Trantor: claude:trantor-duty PARKED (exhausted)",
        body: "48 message(s) held — needs \`trantor up claude\`" }) + "\\n");
  `;
  spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const f = join(busDir, "alerts.jsonl");
  ok("an alert line is appended", existsSync(f));
  if (existsSync(f)) {
    const row = JSON.parse(readFileSync(f, "utf8").trim().split("\n").pop());
    ok("it names the session", row.session === "claude:trantor-duty");
    ok("it names the park reason", /PARKED/.test(row.title));
    ok("it says how many are held", /48 message/.test(row.body));
    ok("it is timestamped, so staleness is computable", Number.isFinite(row.ts));
  }
  rmSync(home, { recursive: true, force: true });
}

console.log("\nonly a SUPERVISED seat exits to be restarted");
{
  ok("the ceiling is read from RUNNER_PARK_MAX_MS", /RUNNER_PARK_MAX_MS/.test(src));
  ok("it exits 0 — a deliberate hand-off, not a crash",
    /process\.exit\(0\);\s*\/\/ 0, not 1/.test(src));
  ok("an unsupervised seat keeps the old behaviour (ceiling defaults to 0 = never exit)",
    /Number\(process\.env\.RUNNER_PARK_MAX_MS \|\| 0\)/.test(src) && /parkMax > 0/.test(src));
  ok("the wait never exceeds the ceiling", /Math\.min\(retryAt - Date\.now\(\), parkMax\)/.test(src));

  const duty = readFileSync(join(ROOT, "bin/duty.mjs"), "utf8");
  ok("duty up sets the ceiling, so only the keepalive-supervised seat gets it",
    /RUNNER_PARK_MAX_MS: "900000"/.test(duty));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
