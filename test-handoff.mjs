#!/usr/bin/env node
// trantor handoff tests — the context-limit → fresh-session machinery.
// Hermetic: no network (RELAY_URL closed), no LLM (TRANTOR_NO_SCROOGE=1 → the
// deterministic whole-session digest is used instead of scrooge), no Terminal
// windows (TRANTOR_NO_HANDOFF_SPAWN=1). Regression coverage for the three gaps
// that broke the promise: tail-only summary, compact eating its own handoff,
// and the spawn never firing.
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  contextUsage, resolveWindow, warnFrac,
  alreadyHandedOff, markHandedOff, buildSummary,
} from "./hooks/lib/handoff.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
const CLOSED = "http://127.0.0.1:1";
console.log("# trantor handoff tests");

const tmp = join(tmpdir(), "trantor-handoff-" + process.pid);
mkdirSync(tmp, { recursive: true });
const handoffDir = join(homedir(), ".agent-bus", "handoffs");
mkdirSync(handoffDir, { recursive: true });

// A transcript whose START and END are clearly distinct, so we can prove the
// summary spans the WHOLE session (the old bug kept only the last 16KB).
const FIRST = "FIRSTLINE_build_the_estimator_engine_phase_zero";
const LAST = "LASTLINE_firing_the_phase5_crew_on_cards_255_258";
const rows = [
  { type: "user", message: { content: FIRST + " — goal: ship it." } },
  { type: "assistant", message: { content: [{ type: "text", text: "Plan A then B." }], model: "claude-opus-4-8", usage: { input_tokens: 5, cache_read_input_tokens: 870000, cache_creation_input_tokens: 1000 } } },
];
for (let i = 0; i < 200; i++) rows.push({ type: "assistant", message: { content: [{ type: "text", text: "mid step " + i }], model: "claude-opus-4-8", usage: { input_tokens: 1, cache_read_input_tokens: 880000 + i, cache_creation_input_tokens: 100 } } });
rows.push({ type: "assistant", message: { content: [{ type: "text", text: LAST }], model: "claude-opus-4-8", usage: { input_tokens: 5, cache_read_input_tokens: 909000, cache_creation_input_tokens: 1000 } } });
const transcript = join(tmp, "t.jsonl");
writeFileSync(transcript, rows.map(r => JSON.stringify(r)).join("\n"));

// --- contextUsage / window resolution ---
const noWin = contextUsage(transcript, {});
ok("contextUsage reads live tokens from transcript usage", noWin && noWin.tokens > 900000);
ok("window UNKNOWN → frac null (no false early-warning)", noWin && noWin.frac === null);
const win = contextUsage(transcript, { contextWindow: 1_000_000 });
ok("window declared → frac computed", win && Math.abs(win.frac - 0.910) < 0.01);
ok("resolveWindow honors config.contextWindow", resolveWindow("claude-opus-4-8", { contextWindow: 200000 }) === 200000);
ok("resolveWindow honors a [1m] model marker", resolveWindow("claude-opus-4-8[1m]", {}) === 1_000_000);
ok("warnFrac default 0.85", warnFrac({}) === 0.85);
ok("warnFrac config override", warnFrac({ contextWarnFrac: 0.9 }) === 0.9);

// --- per-session guard (shared by heartbeat + precompact) ---
const sid = "guardtest-" + process.pid;
const gpath = join(homedir(), ".agent-bus", `handoff-fired-${sid}.json`);
rmSync(gpath, { force: true });
ok("guard: not fired initially", alreadyHandedOff(sid, 900000) === false);
markHandedOff(sid, 900000);
ok("guard: fired after mark", alreadyHandedOff(sid, 905000) === true);
ok("guard: RE-ARMS after context reset (tokens drop <70%)", alreadyHandedOff(sid, 100000) === false);
rmSync(gpath, { force: true });

// --- whole-session summary (no LLM → deterministic digest) ---
process.env.TRANTOR_NO_SCROOGE = "1";
const summary = buildSummary(transcript);
ok("summary includes the SESSION START (not just the tail)", summary.includes(FIRST));
ok("summary includes the SESSION END", summary.includes(LAST));
delete process.env.TRANTOR_NO_SCROOGE;

// --- sessionstart: compact must NOT consume; startup MUST consume ---
const proj = "hoff-selftest-" + process.pid;
const projDir = join(tmpdir(), proj);
mkdirSync(projDir, { recursive: true });
const hf = join(handoffDir, `${proj}-9999999999.json`);
const seed = () => writeFileSync(hf, JSON.stringify({ id: `${proj}-9999999999`, project: projDir, projectName: proj, machine: "h", trigger: "auto", summary: "S", gitStatus: "", consumed: false }, null, 2));
const ss = (source) => spawnSync("node", ["hooks/sessionstart.mjs"], { input: JSON.stringify({ source, session_id: "x" }), encoding: "utf8", timeout: 15000, env: { ...process.env, CLAUDE_PROJECT_DIR: projDir, RELAY_SESSION: proj, RELAY_URL: CLOSED } });
const consumed = () => JSON.parse(readFileSync(hf, "utf8")).consumed;

seed();
const rc = ss("compact");
const ctxC = (() => { try { return JSON.parse(rc.stdout).hookSpecificOutput.additionalContext; } catch { return ""; } })();
ok("compact start injects the handoff", ctxC.includes("trantor-handoff"));
ok("compact start does NOT consume it (reserved for fresh window)", consumed() === false);
const rs = ss("startup");
ok("startup consumes the handoff", consumed() === true);

// --- precompact: writes a handoff (consumed:false), never spawns under guard ---
seed(); rmSync(hf, { force: true });
const pc = spawnSync("node", ["hooks/precompact.mjs"], {
  input: JSON.stringify({ transcript_path: transcript, session_id: "pctest-" + process.pid, trigger: "auto" }),
  encoding: "utf8", timeout: 30000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: projDir, RELAY_URL: CLOSED, TRANTOR_NO_SCROOGE: "1", TRANTOR_NO_HANDOFF_SPAWN: "1" },
});
ok("precompact exits 0", pc.status === 0);
ok("precompact emits valid JSON", (() => { try { JSON.parse(pc.stdout); return true; } catch { return false; } })());
// find the handoff it wrote for this project
const written = (() => { try { return readFileSync(join(handoffDir, `${proj}-${/handoff written:.*\/(.*?)\.json/.exec(pc.stderr)?.[1] || ""}.json`), "utf8"); } catch { return ""; } })();
const wrec = (() => { const m = /handoff written: (\S+\.json)/.exec(pc.stderr); return m ? JSON.parse(readFileSync(m[1], "utf8")) : null; })();
ok("precompact wrote a handoff record", !!wrec);
ok("precompact handoff is unconsumed + whole-session", wrec && wrec.consumed === false && wrec.summary.includes(FIRST) && wrec.summary.includes(LAST));
if (wrec) { const m = /handoff written: (\S+\.json)/.exec(pc.stderr); if (m) rmSync(m[1], { force: true }); }

// cleanup
rmSync(hf, { force: true });
rmSync(join(homedir(), ".agent-bus", `handoff-fired-pctest-${process.pid}.json`), { force: true });
rmSync(tmp, { recursive: true, force: true });
rmSync(projDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
