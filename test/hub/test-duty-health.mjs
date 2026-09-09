#!/usr/bin/env node
// `trantor duty status` must report whether duty is MOVING MAIL, not whether a pid exists.
//
// The incident this locks down (2026-09-09): the duty runner hit an empty-output turn, classified
// the plan as exhausted, and parkSeat() held redelivery until a quota reset ~9h out — and only
// `trantor up` un-parks it. For 21.9 hours it held 48 undelivered messages while `duty status`
// printed "RUNNING (pid 16860)", because that line read the process table and nothing else. The
// orchestrator slept through a whole night of finished crew work as a direct result.
//
// Park state lives only in an in-memory flag in the runner, so status cannot see it. The queue can:
// crew-runner persists pending-<agent>-<project>.json on every failed delivery and unlinks it when
// the queue drains. A backlog with an old head means mail is not moving, whatever the pid says.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const HOUR = 3.6e6;

/** Run `duty status` against a throwaway bus dir holding the given queue. Never the real one. */
function statusWith(queue, { alive = true } = {}) {
  const bus = mkdtempSync(join(tmpdir(), "duty-health-"));
  mkdirSync(bus, { recursive: true });
  // A LIVE pid, so the status path under test is the running-seat branch — the one the incident
  // actually took. Our own pid is alive by definition, and duty.mjs only probes it with kill(pid,0).
  if (alive) writeFileSync(join(bus, "duty.pid"), String(process.pid));
  if (queue) writeFileSync(join(bus, "pending-claude-trantor-duty.json"), JSON.stringify(queue));
  const r = spawnSync(process.execPath, [join(ROOT, "bin/duty.mjs"), "status"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, AGENT_BUS_DIR: bus },
  });
  rmSync(bus, { recursive: true, force: true });
  // Strip ANSI so assertions match the words, not the colour codes.
  return `${r.stdout || ""}${r.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
}

console.log("\na long-held queue reads as STALLED, not RUNNING");
{
  // The real shape of the incident: 48 held, oldest ~22h.
  const old = Date.now() - 21.9 * HOUR;
  const out = statusWith({
    agent: "claude", project: "trantor-duty", ts: Date.now(),
    wake: Array.from({ length: 40 }, (_, i) => ({ id: i, ts: old + i * 1000, text: "held" })),
    bcast: Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, ts: old, text: "held" })),
  });
  ok("says STALLED", /STALLED/.test(out), out.split("\n").slice(4, 9).join(" | "));
  ok("does NOT claim a healthy RUNNING", !/RUNNING/.test(out));
  ok("names how many are held", /48 undelivered message/.test(out));
  ok("names how old the head is", /21\.9h old/.test(out));
  ok("names the remedy", /trantor duty up/.test(out));
}

console.log("\na queue that is merely draining is NOT stalled");
{
  const recent = Date.now() - 2 * 60 * 1000;   // 2 minutes: inside the retry ladder
  const out = statusWith({
    agent: "claude", project: "trantor-duty", ts: Date.now(),
    wake: [{ id: 1, ts: recent, text: "just queued" }], bcast: [],
  });
  ok("does not cry stall over a normal retry", !/STALLED/.test(out), out.split("\n").slice(4,8).join(" | "));
  ok("reports RUNNING and names the backlog", /RUNNING.*draining 1 queued message/.test(out));
}

console.log("\nno queue file at all means nothing is held");
{
  const out = statusWith(null);
  ok("reports RUNNING with an empty queue", /RUNNING.*queue empty/.test(out), out.split("\n").slice(4,8).join(" | "));
  ok("does not report a stall", !/STALLED/.test(out));
}

console.log("\nthe seat is DOWN with a backlog — the case that matters most");
{
  const out = statusWith({
    agent: "claude", project: "trantor-duty", ts: Date.now(),
    wake: [{ id: 1, ts: Date.now() - 5 * HOUR, text: "held" }], bcast: [],
  }, { alive: false });
  ok("says NOT running", /NOT running/.test(out));
  ok("still names the stranded mail", /1 undelivered message\(s\) are held on disk/.test(out),
    out.split("\n").slice(4, 8).join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
