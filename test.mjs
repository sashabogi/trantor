#!/usr/bin/env node
// agent-bus tests — hermetic (no network: RELAY_URL points at a closed port).
// Focus: the hook must ALWAYS emit valid JSON, even when injected handoff content
// contains control chars / U+2028 / quotes (the non-deterministic bug we hit).
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
const CLOSED = "http://127.0.0.1:1"; // refuses fast -> no network dependency
const runHook = (projDir, sess) => spawnSync("node", ["hooks/sessionstart.mjs"], {
  input: '{"source":"startup"}', encoding: "utf8", timeout: 15000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: projDir, RELAY_SESSION: sess, RELAY_URL: CLOSED },
});

const proj = "relay-selftest-" + process.pid;
const projDir = join(tmpdir(), proj);
const handoffDir = join(homedir(), ".agent-bus", "handoffs");
mkdirSync(handoffDir, { recursive: true });
const hfFile = join(handoffDir, `${proj}-9999999999.json`);

// Adversarial handoff: control chars, bell, line/paragraph separators, quotes, backslash, newline, emoji.
const nasty = "TASK" + String.fromCharCode(0x1f,0x07,0x00) + "ctrl " + String.fromCharCode(0x2028) + " LS " + String.fromCharCode(0x2029) + " PS " + String.fromCharCode(0x7f) + " DEL quoted backslash NEXT done <tag>";
writeFileSync(hfFile, JSON.stringify({
  id: `${proj}-9999999999`, project: projDir, projectName: proj,
  machine: "hostname", trigger: "manual", summary: nasty,
  gitStatus: "M file", transcript_path: "/tmp/x.jsonl", consumed: false,
}, null, 2));

console.log("# agent-bus tests");
const r = runHook(projDir, proj);
ok("hook exits 0", r.status === 0);

let parsed = null, valid = false;
try { parsed = JSON.parse(r.stdout); valid = true; } catch { valid = false; }
ok("hook stdout is VALID JSON despite adversarial handoff content", valid);
if (!valid) console.log("    raw stdout (first 160):", JSON.stringify(r.stdout.slice(0, 160)));

const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
ok("injected the <agent-bus-handoff> block", ctx.includes("<agent-bus-handoff"));
ok("no raw control chars left in injected context",
   ![...ctx].some(ch => { const c = ch.codePointAt(0); return (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f || c === 0x2028 || c === 0x2029; }));
ok("handoff marked consumed after load",
   existsSync(hfFile) && JSON.parse(readFileSync(hfFile, "utf8")).consumed === true);

const r2 = runHook(projDir, proj);
let ctx2 = "";
try { ctx2 = JSON.parse(r2.stdout || "{}")?.hookSpecificOutput?.additionalContext || ""; } catch {}
ok("consumed handoff is NOT re-injected on next start", !ctx2.includes("agent-bus-handoff"));

rmSync(hfFile, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
