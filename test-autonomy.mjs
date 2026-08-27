#!/usr/bin/env node
// Autonomy drills. These matter more than most: the file decides whether Trantor is allowed to
// push to a remote on its own, so every safe default and every dependency between dials is
// asserted rather than assumed.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "trantor-autonomy-"));
mkdirSync(join(dir, "bus"), { recursive: true });
process.env.AGENT_BUS_DIR = join(dir, "bus");

const { loadAutonomy, resolveAutonomy, setAutonomy, mayAct, DEFAULTS, AUTONOMY_PATH } =
  await import("./lib/autonomy.mjs");

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log("# trantor autonomy drills");

console.log("\nA fresh install does nothing on its own:");
{
  const a = resolveAutonomy("trantor");
  ok("it will not commit", a.commit === false);
  ok("it will not push", a.push === false);
  ok("it will not deploy", a.deploy === false);
  ok("the operator's harness still asks before acting", a.harness === "prompt");
  ok("seats propose rather than act", a.seats === "propose");
  ok("…but replacing a dead seat is allowed, which loses nothing", a.swapDeadSeat === true);
}

console.log("\nThe dials depend on each other, and the dependency is enforced on READ:");
{
  // A hand-edited file is the case that matters — the UI would refuse to produce this state.
  writeFileSync(AUTONOMY_PATH(), JSON.stringify({
    defaults: { ...DEFAULTS, commit: false, push: true, deploy: true },
  }));
  const a = resolveAutonomy("trantor");
  ok("push is refused when commit is off (you cannot push what you never committed)", a.push === false);
  ok("deploy falls with it", a.deploy === false);
}

console.log("\nA project overrides the defaults without changing them:");
{
  writeFileSync(AUTONOMY_PATH(), JSON.stringify({ defaults: { ...DEFAULTS }, projects: {} }));
  setAutonomy("trantor", { commit: true, push: true, harness: "bypass" });
  const mine = resolveAutonomy("trantor");
  const other = resolveAutonomy("crebral-health");
  ok("the named project takes the override", mine.commit === true && mine.push === true);
  ok("…including the harness dial", mine.harness === "bypass");
  ok("every other project is untouched", other.commit === false && other.harness === "prompt");
}

console.log("\nmayAct is the single gate every autonomous action asks:");
{
  ok("commit is allowed where it was turned on", mayAct("commit", "trantor") === true);
  ok("…and refused where it was not", mayAct("commit", "crebral-health") === false);
  ok("an unknown action is refused rather than allowed", mayAct("rm -rf", "trantor") === false);
}

console.log("\nA corrupt file grants nothing:");
{
  writeFileSync(AUTONOMY_PATH(), "{ this is not json");
  const a = resolveAutonomy("trantor");
  ok("it falls back to the safe defaults instead of throwing", a.commit === false && a.push === false);
  ok("…and loading it still returns a usable shape", typeof loadAutonomy().defaults === "object");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} autonomy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
