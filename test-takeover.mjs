#!/usr/bin/env node
// takeover decision-table drills — the pure heart of `trantor takeover` (#5495).
// Every branch of the design's "must never do" list gets a row here.
import { decide } from "./bin/takeover.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
const c = (id, ageSec) => ({ id, ageSec });

ok("no terminal session → plain open (start/reopen)", decide({ terminalPids: [], candidates: [], sessionFlag: null, force: false }).action === "open");
ok("two claudes in one dir → refuse, never guess", decide({ terminalPids: [1, 2], candidates: [c("a", 60)], sessionFlag: null, force: false }).action === "refuse");
ok("claude but no recent transcript → refuse", decide({ terminalPids: [1], candidates: [], sessionFlag: null, force: false }).action === "refuse");
ok("mid-turn (fresh transcript) → refuse without --force", decide({ terminalPids: [1], candidates: [c("a", 3)], sessionFlag: null, force: false }).action === "refuse");
ok("mid-turn + --force → takeover", decide({ terminalPids: [1], candidates: [c("a", 3)], sessionFlag: null, force: true }).action === "takeover");
ok("idle single candidate → takeover with its sid", (() => { const d = decide({ terminalPids: [9], candidates: [c("sid-x", 120)], sessionFlag: null, force: false }); return d.action === "takeover" && d.sid === "sid-x" && d.pid === 9; })());
ok("two live conversations → refuse and name both", (() => { const d = decide({ terminalPids: [1], candidates: [c("a", 30), c("b", 90)], sessionFlag: null, force: false }); return d.action === "refuse" && d.reason.includes("a") && d.reason.includes("b"); })());
ok("--session picks among candidates", decide({ terminalPids: [1], candidates: [c("a", 30), c("b", 90)], sessionFlag: "b", force: false }).sid === "b");
ok("--session naming an unknown id → refuse", decide({ terminalPids: [1], candidates: [c("a", 30)], sessionFlag: "zz", force: false }).action === "refuse");
ok("custom idle gate is honoured", decide({ terminalPids: [1], candidates: [c("a", 20)], sessionFlag: null, force: false, idleGateSec: 30 }).action === "refuse");

console.log(`\ntakeover drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
