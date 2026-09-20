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
  const windows = [];
  const logs = [];
  const res = maybeSpawn(DIR, conf, file, {
    platform, env,
    paneSurfaceEnv: () => pane,
    hasOrchPane: () => hasOrch,
    spawnPaneBaton: (d, f, p) => { calls.push({ dir: d, file: f, pane: p }); return true; },
    // MUST be injected. Without it the no-pane case falls through to a REAL `spawn` of
    // handoff-prompt.sh and opens a Terminal window on every run of this suite — which is exactly
    // what happened between 2026-09-18 and 2026-09-19 until the operator saw four of them.
    spawnPrompt: (...a) => { windows.push(a[1]?.[1]); return { unref() {} }; },
    log: (s) => logs.push(s),
  });
  return { res, calls, windows, logs: logs.join("") };
}

// REVERSED 2026-09-19. This suite briefly asserted that maybeSpawn DRIVES the pane baton. That was
// wrong and it broke two working paths. The app owns a pane replacement: handoff_now runs
// `trantor handoff --write-only`, waits for the record (armed-mid-turn included), then does its own
// idle gate, kill and reopen (#6081). A driver spawned here races the app's on the same pane.
// maybeSpawn cannot tell "the app is driving" from "nobody is driving", so it must not drive.
console.log("\na pane session gets NO driver from maybeSpawn — the app owns the replacement");
{
  const { res, calls, logs } = call({ pane: "w9:p1" });
  ok("maybeSpawn declines for a pane", res === false, `got ${res}`);
  ok("…and spawns NO second driver onto that pane", calls.length === 0, JSON.stringify(calls));
  ok("…and says so, rather than going silent", /no baton driver from here/.test(logs), logs);
}

console.log("\nthe cwd-keyed orch pane declines too, for the same reason");
{
  const { res, calls } = call({ hasOrch: true });
  ok("an orch pane gets no driver either", res === false && calls.length === 0, JSON.stringify(calls));
}



console.log("\nthe non-pane paths are untouched");
{
  // No pane anywhere: maybeSpawn must NOT take a pane branch, and DOES fall through to the Terminal
  // leg. That leg is injected above — reaching it for real opens a window, which is what this very
  // block used to do on every `npm test`.
  const { calls, windows } = call({ pane: "", hasOrch: false });
  ok("no pane → no pane-baton driver", calls.length === 0, JSON.stringify(calls));
  ok("…it takes the Terminal leg instead, and this drill CAPTURES it rather than opening a window",
    windows.length === 1 && windows[0] === DIR, JSON.stringify(windows));

  const off = call({ pane: "w9:p1", env: { TRANTOR_NO_HANDOFF_SPAWN: "1" } });
  ok("the spawn kill-switch still wins over the pane branch", off.res === false && off.calls.length === 0);

  const linux = call({ pane: "w9:p1", platform: "linux" });
  ok("a non-darwin host spawns nothing", linux.res === false && linux.calls.length === 0);

  const declined = call({ hasOrch: true, conf: { autoHandoffPrompt: false } });
  ok("autoHandoffPrompt:false still declines before the orch-pane leg", declined.res === false && declined.calls.length === 0);
}

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
