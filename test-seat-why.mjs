#!/usr/bin/env node
// trantor seat-why drill — hermetic. Fake ~/.agent-bus evidence in a temp dir, real lib logic.
// Never touches the real ~/.agent-bus; pids are injected so no live process scan is needed.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seatWhy, todaySpend, fmtSpend } from "./lib/seat-why.mjs";

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

// ---- #6134: what the seat SPENT today ---------------------------------------------------------
// The number the operator actually needs when the bill jumps 10x: turns, minutes and tokens for
// this seat since midnight. Turns from the runner's telemetry; tokens only from the turns whose
// CLI printed a usage line, and the count of those is reported so a partial total never reads as
// the whole truth.
console.log("\nToday's spend (#6134):");
{
  const t = (ts, extra = {}) => ({ ts, turn: 1, duration_ms: 60000, exit: 0, ...extra });
  const yesterday = now - 36 * 3600 * 1000;
  const s = todaySpend([
    { ts: now - 1000, boot: true },                 // boots are not turns
    t(now - 5000, { tokens: 12000 }),
    t(now - 4000, { tokens: 8000, cut: true }),
    t(now - 3000),                                   // this CLI printed no usage line
    t(yesterday, { tokens: 999999 }),                // yesterday is not today
  ]);
  ok("only today's turns are counted", s.turns === 3, `turns=${s.turns}`);
  ok("minutes come from the turns' real durations", s.minutes === 3, `minutes=${s.minutes}`);
  ok("tokens total only the turns that reported any", s.tokens === 20000, `tokens=${s.tokens}`);
  ok("…and the drill says how many of the turns those were", s.reported === 2, `reported=${s.reported}`);
  ok("cut turns are counted separately", s.cut === 1, `cut=${s.cut}`);
  ok("the line names turns, minutes and tokens",
    /3 turns/.test(fmtSpend(s)) && /3m/.test(fmtSpend(s)) && /20,000 tokens/.test(fmtSpend(s)), fmtSpend(s));
  ok("a CLI that reports no usage says so instead of claiming 0 tokens",
    /not reported/.test(fmtSpend(todaySpend([t(now - 1000)]))), fmtSpend(todaySpend([t(now - 1000)])));
  ok("seatWhy carries today's spend for the CLI to print",
    !!seatWhy("ttwhy", "codex", { dir: env().dir, pidCheck: noPids }).today);
}

console.log(`\nseat-why drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
