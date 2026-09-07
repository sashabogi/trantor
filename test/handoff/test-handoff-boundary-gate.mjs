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
//   7. lastRowMidTurn reads the transcript tail the way the gate consumes it;
//   8. a trailing plain user prompt is mid-turn;
//   9. (#6668) a lone relay_wait tail is a boundary — the CLI writes, never arms;
//  10. (#6668) a transcript whose session has no live process (~/.claude/sessions) writes at once;
//  11. (#6668) a live session mid-turn still arms, and a registry that says nothing changes nothing.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lastRowMidTurn, sessionProcessState } from "../../hooks/lib/handoff.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor handoff boundary-gate drill (#6528)");

// A world whose session is MID-TURN: the transcript's last row is a tool_result (the model is
// about to continue) and a sub-agent transcript was written seconds ago.
function makeWorld({ midTurn = true, subagent = true, promptTail = false, relayWaitTail = false, alongsideBash = false } = {}) {
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
  if (promptTail) rows.push(JSON.stringify({ type: "user", message: { role: "user", content: "ok, next: map the onboarding flow" } }));
  if (relayWaitTail) {
    // #6668: the orchestrator parked on the bus — a tool_use with no result, by the MCP's full name.
    const calls = [{ type: "tool_use", id: "tu9", name: "mcp__plugin_trantor_relay__relay_wait", input: { timeout: 600 } }];
    if (alongsideBash) calls.push({ type: "tool_use", id: "tu10", name: "Bash", input: { command: "make" } });
    rows.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: calls } }));
  }
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

console.log("\n8. A trailing PLAIN user prompt is mid-turn, not idle (gate review 2026-09-06):");
{
  // Claude Code does not flush the assistant turn until it ENDS — a trailing user prompt with
  // no assistant row after it is the model WORKING on that prompt. Reading it as idle armed a
  // mid-turn fire at exactly the moment the user's next turn began. A trailing user row of ANY
  // kind means in flight; the only idle evidence is a text-only assistant row (or the Stop hook).
  const W8 = makeWorld({ promptTail: true, subagent: false });
  ok("plain user prompt last → mid-turn", lastRowMidTurn(W8.transcript) === true);
  const r = await runScript("bin/baton.mjs", W8, ["--write-only", "--reason", "unattended"]);
  ok("the CLI arms on it, writes no record", handoffs(W8).length === 0 && !!readArm(W8), `${handoffs(W8).join(", ")} / ${r.so.slice(0, 120)}`);
}

console.log("\n9. A lone relay_wait tail is a boundary, not a turn in flight (#6668):");
{
  // An orchestrator parked in relay_wait reads "working" to herdr for as long as the bus is
  // quiet. Arming on it meant a 17-minute boundary wait on a turn that never ends by itself;
  // the wait is not work — everything the turn did is already on disk.
  const W9 = makeWorld({ midTurn: false, subagent: false, relayWaitTail: true });
  ok("relay_wait tool_use last → at the boundary", lastRowMidTurn(W9.transcript) === false);
  const r = await runScript("bin/baton.mjs", W9, ["--write-only", "--reason", "unattended"]);
  ok("the CLI writes at once, no arm", handoffs(W9).length === 1 && !readArm(W9), `${handoffs(W9).join(", ")} / ${r.so.slice(0, 120)}`);
  const W9b = makeWorld({ midTurn: false, subagent: false, relayWaitTail: true, alongsideBash: true });
  ok("relay_wait beside a real tool call → still mid-turn", lastRowMidTurn(W9b.transcript) === true);
}

console.log("\n10. A transcript whose session has NO live process is at its boundary (#6668):");
// Claude Code's registry: ~/.claude/sessions/<pid>.json = {pid, sessionId, ...}, removed at exit.
// 09-07 12:35: the chain armed on a transcript whose session had exited at 12:16 — its tail was
// a tool_result ("Connection closed"), so the gate read mid-turn and waited on nobody.
const seedRegistry = (W, entries) => {
  const dir = join(W.w, ".claude", "sessions"); mkdirSync(dir, { recursive: true });
  for (const e of entries) writeFileSync(join(dir, `${e.pid}.json`), JSON.stringify({ ...e, cwd: W.proj, version: "2.1.257" }));
};
const deadPid = (() => { const p = spawnSync("true").pid; return p; })();   // exited before we read it
{
  const W10 = makeWorld({});   // mid-turn tail AND an active sub-agent: a dead session overrides both
  seedRegistry(W10, [{ pid: process.pid, sessionId: "another-live-session" }, { pid: deadPid, sessionId: SID }]);
  ok("sessionProcessState → dead", sessionProcessState(SID, { home: W10.w }) === "dead", sessionProcessState(SID, { home: W10.w }));
  const r = await runScript("bin/baton.mjs", W10, ["--write-only", "--reason", "unattended"]);
  ok("the record is written, nothing armed", handoffs(W10).length === 1 && !readArm(W10), `${handoffs(W10).join(", ")} / ${r.so.slice(0, 160)}`);
  ok("…and stdout says why", /no live process/.test(r.so), r.so.slice(0, 160));
}

console.log("\n11. …while a LIVE session mid-turn still arms (no regression on #6528):");
{
  const W11 = makeWorld({});
  seedRegistry(W11, [{ pid: process.pid, sessionId: SID }]);
  ok("sessionProcessState → live", sessionProcessState(SID, { home: W11.w }) === "live");
  const r = await runScript("bin/baton.mjs", W11, ["--write-only", "--reason", "unattended"]);
  ok("arms, writes no record", handoffs(W11).length === 0 && !!readArm(W11), `${handoffs(W11).join(", ")} / ${r.so.slice(0, 120)}`);
  // The verdict needs evidence: no registry, or one with nothing alive in it, says nothing.
  const W11b = makeWorld({});
  ok("no registry → unknown", sessionProcessState(SID, { home: W11b.w }) === "unknown");
  seedRegistry(W11b, [{ pid: deadPid, sessionId: "someone-else" }]);
  ok("a registry with only dead entries → unknown", sessionProcessState(SID, { home: W11b.w }) === "unknown");
  const r2 = await runScript("bin/baton.mjs", W11b, ["--write-only", "--reason", "unattended"]);
  ok("…so the gate still arms", handoffs(W11b).length === 0 && !!readArm(W11b), `${handoffs(W11b).join(", ")} / ${r2.so.slice(0, 120)}`);
}

console.log("\n12. The pane leg never ends the pane's SHELL (#6668, parity with lib.rs foreground_pid_from_process_info):");
{
  // 09-07 12:35: herdr's process-info had foreground_process_group_id = 80368 = the bare zsh the
  // dead session left behind; taken as-is, the graceful end would have closed the pane.
  const { foregroundPid } = await import("../../bin/baton-pane.mjs");
  ok("bare zsh by shell_pid and name → null", foregroundPid({ foreground_process_group_id: 80368, foreground_processes: [{ name: "zsh", argv0: "-zsh", pid: 80368 }], shell_pid: 80368 }) === null);
  ok("bare shell by shell_pid alone (no name) → null", foregroundPid({ foreground_process_group_id: 80368, foreground_processes: [{ pid: 80368 }], shell_pid: 80368 }) === null);
  ok("bare shell by name alone (older herdr, no shell_pid) → null", foregroundPid({ foreground_process_group_id: 4242, foreground_processes: [{ name: "bash", pid: 4242 }] }) === null);
  ok("no process-info at all → null", foregroundPid(null) === null && foregroundPid(undefined) === null);
  ok("the live shape (group id = claude, MCP children, shell_pid = the pane's zsh) → claude",
    foregroundPid({ foreground_process_group_id: 87044, foreground_processes: [{ name: "node", pid: 87076 }, { name: "claude.exe", argv0: "claude", pid: 87044 }], shell_pid: 2309 }) === 87044);
  ok("the last-entry fallback skips the shell", foregroundPid({ foreground_processes: [{ name: "node", pid: 10 }, { name: "/bin/zsh", pid: 11 }], shell_pid: 11 }) === 10);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} handoff-boundary-gate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
