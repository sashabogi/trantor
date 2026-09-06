#!/usr/bin/env node
// trantor — the #6528 boundary gate: a handoff request during an IN-FLIGHT turn arms the baton
// and writes nothing; only the session's Stop (with no sub-agent still running) fires it.
//
// Witnessed 2026-09-05: handoff trantor-1788661956 (trigger manual-cli) was written at 22:32:36
// while the orchestrator was mid-turn with subagent orca-onboarding-map in flight. bin/baton.mjs
// consulted nothing — the banner's fire went straight to writeHandoff+spawn. The successor took
// over a half-described session, its STATE section elided to "[…]".
//
// This suite drills the REAL CLI path (bin/baton.mjs, the one every banner fire rides) and the
// REAL Stop hook (stop-inbox.mjs, the one fire point a boundary gives us), on a synthetic world:
//   1. a fire during a synthetic in-flight turn ARMS, writes no record;
//   2. re-firing does not slide the arm's timestamp (the hard cap must stay honest);
//   3. a Stop with a sub-agent still active keeps the arm (and says so);
//   4. the next Stop — turn complete, sub-agents quiet — writes the record and clears the arm;
//   5. --force (the hard-cap leg) writes immediately even mid-turn;
//   6. an idle session still fires immediately (no regression for the operator's typed baton);
//   7. lastRowMidTurn reads the transcript tail the way the gate consumes it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lastRowMidTurn } from "./hooks/lib/handoff.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor handoff boundary-gate drill (#6528)");

// A world whose session is MID-TURN: the transcript's last row is a tool_result (the model is
// about to continue) and a sub-agent transcript was written seconds ago.
function makeWorld({ midTurn = true, subagent = true } = {}) {
  const w = mkdtempSync(join(tmpdir(), "tt-baton-gate-"));
  const BUS = join(w, ".agent-bus"); mkdirSync(join(BUS, "handoffs"), { recursive: true });
  const proj = join(w, "proj"); mkdirSync(proj, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  // bin/baton.mjs's findTranscript() looks under $HOME/.claude/projects/<proj-with-dashes>/ —
  // the world must lay the transcript out where the REAL discovery finds it.
  const tdir = join(w, ".claude", "projects", proj.replace(/\//g, "-")); mkdirSync(tdir, { recursive: true });
  const transcript = join(tdir, "t.jsonl");
  const rows = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "starting the build" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "make" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } }),
  ];
  if (!midTurn) rows.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done — turn complete" }] } }));
  writeFileSync(transcript, rows.join("\n") + "\n");
  if (subagent) {
    const sub = join(tdir, "t", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-orca.jsonl"), JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "mapping onboarding" }] } }) + "\n");
  }
  return { w, BUS, proj, transcript };
}

const env = (W) => ({
  ...drillEnvOf(W),
});
function drillEnvOf(W) {
  return {
    PATH: process.env.PATH,
    HOME: W.w, TMPDIR: process.env.TMPDIR,
    AGENT_BUS_DIR: W.BUS, RELAY_DATA_DIR: W.BUS,
    CLAUDE_PROJECT_DIR: W.proj,
    RELAY_URL: "http://127.0.0.1:9",       // hub unreachable: the storm guard fails OPEN, the record still writes
    RELAY_SESSION: "", RELAY_PROJECT: "",
    TRANTOR_NO_SCROOGE: "1",               // no LLM in a drill
    TRANTOR_NO_BATON_SPAWN: "1",           // and never open a real Terminal window…
    TRANTOR_NO_HANDOFF_SPAWN: "1",         // …by EITHER name
  };
}

function runScript(script, W, args = [], stdin = "") {
  return new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], env: env(W) });
    let so = "", se = ""; kid.stdout.on("data", d => (so += d)); kid.stderr.on("data", d => (se += d));
    kid.on("close", (code) => resolve({ so, se, code }));
    kid.stdin.end(stdin);
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 30000).unref?.();
  });
}
const handoffs = (W) => { try { return readdirSync(join(W.BUS, "handoffs")).filter(f => f.endsWith(".json") && !f.startsWith("recap-pending")); } catch { return []; } };
// bin/baton.mjs derives the arm's session id from the transcript filename (t.jsonl → "t"), and
// the Stop hook below must read the SAME arm — the real chain connects the same way.
const SID = "t";
const armFile = (W) => join(W.BUS, `handoff-armed-${SID}.json`);
const readArm = (W) => { try { return JSON.parse(readFileSync(armFile(W), "utf8")); } catch { return null; } };

console.log("\n1. A fire during an in-flight turn ARMS; no record is written:");
const W1 = makeWorld({});
{
  const r = await runScript("bin/baton.mjs", W1, ["--write-only", "--reason", "unattended"]);
  ok("exit 0", r.code === 0, r.se.slice(0, 200));
  ok("no handoff record mid-turn", handoffs(W1).length === 0, handoffs(W1).join(", "));
  const arm = readArm(W1);
  ok("…the baton is armed", !!arm, armFile(W1));
  ok("…with the banner's real trigger, not manual-cli", arm?.reason === "unattended", String(arm?.reason));
  ok("…and it says so on stdout", /handoff armed/.test(r.so), r.so.slice(0, 160));
  ok("…promising the boundary, not the clock", /when this turn finishes/.test(r.so) && /hard cap/.test(r.so), r.so.slice(0, 200));
}

console.log("\n2. Re-firing (the banner retries) must NOT slide the arm's timestamp:");
{
  const before = readArm(W1)?.ts;
  await sleep(1200);
  await runScript("bin/baton.mjs", W1, ["--write-only", "--reason", "unattended"]);
  const after = readArm(W1)?.ts;
  ok("arm timestamp preserved", before > 0 && before === after, `${before} -> ${after}`);
  ok("still no record", handoffs(W1).length === 0, handoffs(W1).join(", "));
}

console.log("\n3. A Stop with a sub-agent STILL active keeps the arm:");
{
  const r = await runScript("hooks/stop-inbox.mjs", W1, [], JSON.stringify({ session_id: SID, cwd: W1.proj, stop_hook_active: false }));
  await sleep(2000);
  ok("no record written", handoffs(W1).length === 0, handoffs(W1).join(", "));
  ok("…the arm survives", !!readArm(W1), armFile(W1));
  ok("…and the hook says why", /sub-agents are still active/.test(r.se), r.se.slice(0, 200));
}

console.log("\n4. The next Stop — turn complete, sub-agents quiet — fires the baton:");
{
  utimesSync(join(W1.transcript, "..", "t", "subagents", "agent-orca.jsonl"), new Date(Date.now() - 10 * 60000), new Date(Date.now() - 10 * 60000));
  appendFileSync(W1.transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "turn complete — handing off" }] } }) + "\n");
  await runScript("hooks/stop-inbox.mjs", W1, [], JSON.stringify({ session_id: SID, cwd: W1.proj, stop_hook_active: false }));
  await sleep(3000);
  ok("the record exists at the boundary", handoffs(W1).length === 1, handoffs(W1).join(", "));
  ok("…carrying the armed trigger", (() => { try { return JSON.parse(readFileSync(join(W1.BUS, "handoffs", handoffs(W1)[0]), "utf8")).trigger === "unattended"; } catch { return false; } })());
  ok("…and the arming is cleared", !readArm(W1), armFile(W1));
}

console.log("\n5. --force (the hard-cap leg) writes immediately even mid-turn:");
{
  const W5 = makeWorld({});
  const r = await runScript("bin/baton.mjs", W5, ["--write-only", "--reason", "unattended", "--force"]);
  ok("the record is written despite the in-flight turn", handoffs(W5).length === 1, `${handoffs(W5).join(", ")} / ${r.so.slice(0, 120)}`);
}

console.log("\n6. An idle session (no regression for the operator's typed baton):");
{
  const W6 = makeWorld({ midTurn: false, subagent: false });
  const r = await runScript("bin/baton.mjs", W6, ["--write-only", "--reason", "countdown"]);
  ok("the record is written immediately", handoffs(W6).length === 1, `${handoffs(W6).join(", ")} / ${r.so.slice(0, 120)}`);
  ok("…no arm was created", !readArm(W6), armFile(W6));
}

console.log("\n7. lastRowMidTurn reads the tail the way the gate consumes it:");
{
  const W7 = makeWorld({});
  ok("tool_result last → mid-turn", lastRowMidTurn(W7.transcript) === true);
  const W7b = makeWorld({ midTurn: false, subagent: false });
  ok("closing text last → idle", lastRowMidTurn(W7b.transcript) === false);
  ok("missing transcript → not mid-turn", lastRowMidTurn(join(W7.w, "nope.jsonl")) === false);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} handoff-boundary-gate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
