#!/usr/bin/env node
// trantor seat-why drill — hermetic. Fake ~/.agent-bus evidence in a temp dir, real lib logic.
// Never touches the real ~/.agent-bus; pids are injected so no live process scan is needed.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seatWhy } from "./lib/seat-why.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
console.log("# trantor seat-why drill");

let n = 0;
function env() {
  const dir = mkdtempSync(join(tmpdir(), `tt-why-${n++}-`));
  mkdirSync(join(dir, "logs"), { recursive: true });
  return { dir, put: (p, s) => writeFileSync(join(dir, p), s) };
}
const noPids = () => [];
const pid = (p) => [p];

const now = Date.now();
const turn = (t, trigger, exit, opts = {}) => JSON.stringify({
  ts: t, agent: "codex", project: "ttwhy", turn: 3, trigger, exit,
  effExit: opts.effExit, authFailed: !!opts.authFailed,
});

console.log("\nLive seat (runner pid + pane + clean last turn):");
{
  const { dir, put } = env();
  put("crew-windows.txt", "ttwhy\therdr\tcodex\tpane-1\n");
  put("logs/codex-ttwhy.jsonl",
    JSON.stringify({ ts: now - 120000, agent: "codex", project: "ttwhy", boot: true }) + "\n" +
    turn(now - 60000, "message", 0) + "\n");
  const r = seatWhy("ttwhy", "codex", { dir, pidCheck: () => pid(4242) });
  ok("runner pid + pane + clean turn = live", r.state === "live", JSON.stringify(r));
  ok("...advice says nothing to do", /nothing to do/i.test(r.advice));
  ok("...why names the pid", /4242/.test(r.why));
}

console.log("\nHeadless seat (runner pid, no pane row):");
{
  const { dir } = env();
  const r = seatWhy("ttwhy", "codex", { dir, pidCheck: () => pid(4242) });
  ok("runner pid with no pane row = no-pane", r.state === "no-pane", JSON.stringify(r));
  ok("...advice suggests giving it a window", /trantor up/i.test(r.advice));
}

console.log("\nDead seats (no runner pid, evidence classifies the death):");
{
  const { dir, put } = env();
  put("err-codex-ttwhy.txt", "Error: 401 Unauthorized — Invalid API key provided\n");
  put("logs/codex-ttwhy.jsonl", turn(now - 300000, "message", 0, { effExit: 1, authFailed: true }) + "\n");
  const r = seatWhy("ttwhy", "codex", { dir, pidCheck: noPids });
  ok("authFailed telemetry = dead-auth", r.state === "dead-auth", JSON.stringify(r));
  ok("...advice points at credentials", /credential/i.test(r.advice));
}
{
  const { dir, put } = env();
  put("err-codex-ttwhy.txt", "Invalid API key\n");
  const r = seatWhy("ttwhy", "codex", { dir, pidCheck: noPids });
  ok("auth markers in err file only = dead-auth", r.state === "dead-auth", JSON.stringify(r));
}
{
  const { dir, put } = env();
  put("err-codex-ttwhy.txt", "Error: insufficient_quota — you exceeded your current quota, please check your plan\n");
  put("logs/codex-ttwhy.jsonl", turn(now - 300000, "message", 1) + "\n");
  const r = seatWhy("ttwhy", "codex", { dir, pidCheck: noPids });
  ok("quota markers = dead-quota", r.state === "dead-quota", JSON.stringify(r));
  ok("...advice suggests trantor swap", /trantor swap/i.test(r.advice));
}
{
  const { dir, put } = env();
  put("err-codex-ttwhy.txt", "Segmentation fault\n");
  put("logs/codex-ttwhy.jsonl", turn(now - 300000, "message", 1) + "\n");
  const r = seatWhy("ttwhy", "codex", { dir, pidCheck: noPids });
  ok("non-zero exit without quota/auth = dead-crash", r.state === "dead-crash", JSON.stringify(r));
}

console.log("\nNever-run seat:");
{
  const { dir } = env();
  const r = seatWhy("ttwhy", "codex", { dir, pidCheck: noPids });
  ok("no pid, no err, no telemetry = no-runner", r.state === "no-runner", JSON.stringify(r));
  ok("...advice says trantor up", /trantor up/.test(r.advice));
}
{
  const r = seatWhy("zzz-proj", "zzz-never-an-agent", { dir: mkdtempSync(join(tmpdir(), "tt-why-scan-")) });
  ok("default pid scan on a never-run seat = no-runner (no false live)", r.state === "no-runner", JSON.stringify(r));
}

console.log(`\nseat-why drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
