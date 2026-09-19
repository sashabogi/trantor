#!/usr/bin/env node
// A pane session's armed baton must actually open a successor (#8089).
//
// /trantor:handoff runs as a tool call, so a turn is ALWAYS in flight, so bin/baton.mjs ALWAYS takes
// the arm branch. The Stop hook then fires hooks/handoff-now.mjs, which writes the record and calls
// maybeSpawn(). For a pane session maybeSpawn used to return false outright — on the stated theory
// that "the pane is the successor surface, and the pane claims the handoff (trantor open) on its
// own" — while nothing was driving that. spawnPaneBaton, which the DIRECT path (spawnBaton) calls at
// exactly this point, was never reached.
//
// Result, witnessed on crebral-health 2026-09-19: record written 00:18:58, states [{written}],
// consumed:false, and the original session still alive in pane w9:p1 twelve minutes later. The
// operator's report was "fired off trantor handoff skill, and nothing happened".
//
// Two implementations of "which surface takes over" and only one knew about panes — and because the
// skill always arms, the blind one was the one that always ran. This suite pins that both know.
import { maybeSpawn } from "../../hooks/lib/handoff.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};

const DIR = "/tmp/proj/crebral-health";
const FILE = "/tmp/handoffs/crebral-health-1789791538.json";
const CONF = {};

/** A maybeSpawn call with every side effect captured instead of performed. */
function call({ pane = "", hasOrch = false, file = FILE, platform = "darwin", conf = CONF, env = {} } = {}) {
  const calls = [];
  const logs = [];
  const res = maybeSpawn(DIR, conf, file, {
    platform, env,
    paneSurfaceEnv: () => pane,
    hasOrchPane: () => hasOrch,
    spawnPaneBaton: (d, f, p) => { calls.push({ dir: d, file: f, pane: p }); return true; },
    log: (s) => logs.push(s),
  });
  return { res, calls, logs: logs.join("") };
}

console.log("\nthe bug: a pane session's armed baton opens a successor");
{
  const { res, calls } = call({ pane: "w9:p1" });
  ok("maybeSpawn reports it acted", res === true, `got ${res}`);
  ok("…by driving the pane baton", calls.length === 1, JSON.stringify(calls));
  ok("…for THIS pane, not one guessed from cwd", calls[0]?.pane === "w9:p1", JSON.stringify(calls[0]));
  ok("…carrying the handoff file the successor must claim", calls[0]?.file === FILE, JSON.stringify(calls[0]));
}

console.log("\nthe cwd-keyed orch pane takes the same route");
{
  const { res, calls } = call({ hasOrch: true });
  ok("an orch pane also gets a baton driver", res === true && calls.length === 1, JSON.stringify(calls));
  ok("…and without HERDR_PANE_ID the driver resolves the pane itself", calls[0]?.pane === undefined, JSON.stringify(calls[0]));
}

console.log("\nno handoff file is a refusal that SAYS SO, never a silent false");
{
  const { res, calls, logs } = call({ pane: "w9:p1", file: "" });
  ok("it refuses", res === false && calls.length === 0);
  ok("…and names why, so the failure is readable", /needs the handoff file/.test(logs), logs);
}

console.log("\na driver that fails to spawn is reported, not swallowed");
{
  const logs = [];
  const res = maybeSpawn(DIR, CONF, FILE, {
    platform: "darwin", env: {},
    paneSurfaceEnv: () => "w9:p1",
    hasOrchPane: () => false,
    spawnPaneBaton: () => false,
    log: (s) => logs.push(s),
  });
  ok("a failed driver returns false", res === false);
  ok("…and says FAILED rather than going quiet", /FAILED to spawn/.test(logs.join("")), logs.join(""));
}

console.log("\nthe non-pane paths are untouched");
{
  // No pane anywhere: maybeSpawn must NOT take a pane branch. It falls through to the Terminal leg,
  // which this drill deliberately does not exercise — spawning a real window is not a unit test.
  const { calls } = call({ pane: "", hasOrch: false });
  ok("no pane → no pane-baton driver", calls.length === 0, JSON.stringify(calls));

  const off = call({ pane: "w9:p1", env: { TRANTOR_NO_HANDOFF_SPAWN: "1" } });
  ok("the spawn kill-switch still wins over the pane branch", off.res === false && off.calls.length === 0);

  const linux = call({ pane: "w9:p1", platform: "linux" });
  ok("a non-darwin host spawns nothing", linux.res === false && linux.calls.length === 0);

  const declined = call({ hasOrch: true, conf: { autoHandoffPrompt: false } });
  ok("autoHandoffPrompt:false still declines before the orch-pane leg", declined.res === false && declined.calls.length === 0);
}

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
