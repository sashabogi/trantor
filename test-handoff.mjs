#!/usr/bin/env node
// trantor handoff tests — the context-limit → fresh-session machinery.
// Hermetic: no network (RELAY_URL closed), no LLM (TRANTOR_NO_SCROOGE=1 → the
// deterministic whole-session digest is used instead of scrooge), no Terminal
// windows (TRANTOR_NO_HANDOFF_SPAWN=1). Regression coverage for the three gaps
// that broke the promise: tail-only summary, compact eating its own handoff,
// and the spawn never firing.
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  contextUsage, resolveWindow, warnFrac,
  alreadyHandedOff, markHandedOff, buildSummary, verbatimRecentTail, writeHandoff, spawnBaton,
  resolveOriginalWindow, supersedeOlderHandoffs, subagentsActive, armBatonClose,
} from "./hooks/lib/handoff.mjs";
import { orchWriterSid } from "./lib/project.mjs";
import { freshEngaged, originalStillWorking } from "./bin/baton-close.mjs";

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
ok("warnFrac default 0.90 (baton pass fires at 90%)", warnFrac({}) === 0.90);
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
// baton pass: the handoff record must carry a VERBATIM recent-exchange block (exact in-flight state)
ok("verbatimRecentTail returns the exact recent text", verbatimRecentTail(transcript).includes(LAST));
const { record: hrec, file: hfile } = writeHandoff({ projectDir: tmp, sessionId: "vt", transcript, trigger: "context-warn" });
ok("writeHandoff embeds the verbatim in-flight block", /Verbatim recent exchange/.test(hrec.summary) && hrec.summary.includes(LAST));
// The operator's OWN spawn guards, if they exported them. The GOTCHAS tell every session to set
// TRANTOR_NO_HANDOFF_SPAWN and TRANTOR_NO_BATON_SPAWN before running anything that can open a
// window, so this suite must assume they are set — and must put them back exactly as it found them
// rather than deleting them, which would strip the operator's protection for the rest of the file.
const GUARDS = ["TRANTOR_NO_HANDOFF_SPAWN", "TRANTOR_NO_BATON_SPAWN"];
const savedGuards = Object.fromEntries(GUARDS.map(k => [k, process.env[k]]));
const restoreGuards = () => { for (const k of GUARDS) { if (savedGuards[k] === undefined) delete process.env[k]; else process.env[k] = savedGuards[k]; } };
const clearGuards = () => { for (const k of GUARDS) delete process.env[k]; };

// manual baton: when spawning is disabled it must NOT touch any window (spawned:false, armed:false)
process.env.TRANTOR_NO_HANDOFF_SPAWN = "1";
const b = spawnBaton({ projectDir: tmp, handoffFile: "/tmp/nope.json" });
ok("spawnBaton is a no-op (no window) when spawning is disabled", b.spawned === false && b.armed === false);
restoreGuards();
delete process.env.TRANTOR_NO_SCROOGE;

// --- regression: baton must close the ORIGINAL window, never the freshly-spawned successor ---
// Bug (2026-06-18): spawnBaton spawned the fresh session FIRST, then detected the window to close.
// The new window was frontmost, so the front-window fallback captured IT — and baton-close killed
// the SUCCESSOR the instant it took over ("you're supposed to shut yourself off, not the other one").
// Lock the order: resolve the original window BEFORE spawning, and arm the close against it.
{
  // 0.17.98 moved spawnBaton onto spawnSuppressed(), which honours BOTH guard names — and that check
  // runs BEFORE the injected seams. So an operator who exported the guards (as the GOTCHAS instruct)
  // turned this ordering regression test into a silent no-op that reported two spurious failures.
  // Clearing them here is safe BY CONSTRUCTION: every seam that could touch a real window is mocked
  // below, so nothing can spawn. Restored in the finally, whatever happens.
  const order = [];
  let b2;
  clearGuards();
  try {
    b2 = spawnBaton({
      projectDir: tmp, handoffFile: "/tmp/x.json",
      _resolveWindow: () => { order.push("detect"); return { windowId: "W-ORIGINAL", tty: "/dev/ttysORIG" }; },
      _spawnFresh: () => { order.push("spawn"); return true; },
      _armClose: (hf, id) => { order.push(`arm:${id}`); return true; },
    });
  } finally { restoreGuards(); }
  ok("spawnBaton resolves the original window BEFORE spawning the fresh one", order[0] === "detect" && order[1] === "spawn");
  ok("spawnBaton arms the close against the ORIGINAL window, not the successor", order[2] === "arm:W-ORIGINAL" && b2.windowId === "W-ORIGINAL");
  ok("…and the drill still works with the operator's spawn guards exported (it mocks every seam)",
    order.length === 3, `order=${JSON.stringify(order)}`);
  // resolveOriginalWindow is callable and shaped right (returns {windowId,tty}); headless → empty, never throws
  const rw = resolveOriginalWindow();
  ok("resolveOriginalWindow returns a {windowId,tty} shape", typeof rw.windowId === "string" && typeof rw.tty === "string");
}

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

// --- regression: select newest-by-STAMP for THIS project, ignore look-alike names ---
// Bug (2026-06-18): loose startsWith()+lexicographic sort grabbed a stale
// "<proj>-handoff-<pid>-….json" leaked fixture over the real "<proj>-<stamp>.json",
// because a letter ('h') sorts above a digit. So a manual baton handed the fresh
// session synthetic test data instead of the just-written handoff. Lock it down.
rmSync(hf, { force: true });
const older = join(handoffDir, `${proj}-1000000000.json`);
const newer = join(handoffDir, `${proj}-2000000000.json`);
const decoy = join(handoffDir, `${proj}-handoff-${process.pid}-9999999999.json`); // look-alike, lexically higher
const mk = (f, id) => writeFileSync(f, JSON.stringify({ id, project: projDir, projectName: proj, machine: "h", trigger: "auto", summary: id, gitStatus: "", consumed: false }, null, 2));
mk(older, "OLDER_HANDOFF"); mk(newer, "NEWER_HANDOFF"); mk(decoy, "DECOY_FIXTURE");
const rsel = ss("startup");
const selCtx = (() => { try { return JSON.parse(rsel.stdout).hookSpecificOutput.additionalContext; } catch { return ""; } })();
ok("selector injects the NEWEST valid handoff (by stamp, not lexicographic)", selCtx.includes("NEWER_HANDOFF") && !selCtx.includes("OLDER_HANDOFF"));
ok("selector ignores look-alike '<proj>-handoff-…' fixtures", !selCtx.includes("DECOY_FIXTURE") && JSON.parse(readFileSync(decoy, "utf8")).consumed === false);
rmSync(older, { force: true }); rmSync(newer, { force: true }); rmSync(decoy, { force: true });
seed();

// --- regression: a new handoff SUPERSEDES older unconsumed siblings (no stale-pile / scrambled load) ---
// Bug (2026-06-21): the early-warning re-fired every 5 min (guarded only by the inflight stamp, never
// markHandedOff), stacking 8 unconsumed handoffs ~5 min apart for one project. A scrambled spawn could
// then load an OLD snapshot ("stale by ~15 commits"). writeHandoff now retires older unconsumed ones.
{
  const sp = "supersede-" + process.pid;
  const spDir = join(tmpdir(), sp);
  mkdirSync(spDir, { recursive: true });
  const a = join(handoffDir, `${sp}-1000000000.json`);
  const b = join(handoffDir, `${sp}-1000000300.json`);
  writeFileSync(a, JSON.stringify({ id: `${sp}-1000000000`, projectName: sp, consumed: false, summary: "A" }, null, 2));
  writeFileSync(b, JSON.stringify({ id: `${sp}-1000000300`, projectName: sp, consumed: false, summary: "B" }, null, 2));
  // a third, real one lands (via writeHandoff, which calls supersedeOlderHandoffs)
  process.env.TRANTOR_NO_SCROOGE = "1"; // hermetic: deterministic digest, no LLM call
  const { file: cFile } = writeHandoff({ projectDir: spDir, sessionId: "s", transcript, trigger: "context-warn" });
  delete process.env.TRANTOR_NO_SCROOGE;
  const ja = JSON.parse(readFileSync(a, "utf8")), jb = JSON.parse(readFileSync(b, "utf8")), jc = JSON.parse(readFileSync(cFile, "utf8"));
  ok("supersede: the just-written handoff stays unconsumed", jc.consumed === false);
  ok("supersede: older unconsumed siblings are retired (consumed+superseded)", ja.consumed === true && ja.superseded === true && jb.consumed === true);
  // direct call is idempotent + keeps the named id
  supersedeOlderHandoffs(sp, jc.id);
  ok("supersede: keepId is never retired by a direct call", JSON.parse(readFileSync(cFile, "utf8")).consumed === false);
  rmSync(a, { force: true }); rmSync(b, { force: true }); rmSync(cFile, { force: true });
  rmSync(spDir, { recursive: true, force: true });
}

// --- regression: claiming a handoff stamps WHO took over, and baton-close waits for a real turn ---
// Bug (2026-06-21): `consumed` flips at SessionStart (inject time), and baton-close closed the original
// ~4s later — before the fresh model had read the handoff. Now sessionstart records consumedBy/consumedAt
// and baton-close (freshEngaged) waits for the fresh session's first assistant turn.
{
  const cp = "consumedby-" + process.pid;
  const cpDir = join(tmpdir(), cp);
  mkdirSync(cpDir, { recursive: true });
  const chf = join(handoffDir, `${cp}-1500000000.json`);
  writeFileSync(chf, JSON.stringify({ id: `${cp}-1500000000`, project: cpDir, projectName: cp, machine: "h", trigger: "context-warn", summary: "S", gitStatus: "", consumed: false }, null, 2));
  const freshTranscript = join(cpDir, "fresh.jsonl");
  const r = spawnSync("node", ["hooks/sessionstart.mjs"], {
    input: JSON.stringify({ source: "startup", session_id: "FRESH-SID", transcript_path: freshTranscript }),
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cpDir, RELAY_SESSION: cp, RELAY_URL: CLOSED },
  });
  const claimed = JSON.parse(readFileSync(chf, "utf8"));
  ok("consumedBy: claim records the fresh session id + transcript path", claimed.consumed === true && claimed.consumedBy?.session_id === "FRESH-SID" && claimed.consumedBy?.transcript_path === freshTranscript);
  ok("consumedBy: claim stamps consumedAt (epoch sec)", typeof claimed.consumedAt === "number" && claimed.consumedAt > 1_700_000_000);

  // freshEngaged: false until the fresh transcript shows an assistant turn; true once it does.
  ok("freshEngaged: false before any fresh turn exists", freshEngaged(claimed) === false);
  writeFileSync(freshTranscript, JSON.stringify({ type: "user", message: { content: "Recap…" } }) + "\n");
  ok("freshEngaged: still false with only a user turn", freshEngaged(claimed) === false);
  writeFileSync(freshTranscript, JSON.stringify({ type: "user", message: { content: "Recap…" } }) + "\n" +
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Taking over." }] } }) + "\n");
  ok("freshEngaged: true once the fresh session produces an assistant turn", freshEngaged(claimed) === true);
  ok("freshEngaged: false when the handoff has no consumedBy transcript (older record)", freshEngaged({ consumed: true }) === false);
  rmSync(chf, { force: true });
  rmSync(cpDir, { recursive: true, force: true });
}

// --- SAFETY (incident 2026-06-21): auto-baton must not fire mid-build, and must never auto-close ---
// A 90% baton fired while the session was orchestrating 2 agents and the original was SIGKILLed
// mid-flight. Three guards now: (1) detect live sub-agents, (2) auto-close is opt-in only,
// (3) baton-close aborts if the original is still working.
{
  // (1) subagentsActive — the mid-build signal the heartbeat defers on.
  const sd = join(tmpdir(), "subact-" + process.pid);
  mkdirSync(sd, { recursive: true });
  const stp = join(sd, "s.jsonl"); writeFileSync(stp, "x\n");
  ok("subagentsActive: false when there's no subagents dir", subagentsActive(stp) === false);
  const sub = join(sd, "s", "subagents"); mkdirSync(sub, { recursive: true });
  const ag = join(sub, "agent-abc.jsonl"); writeFileSync(ag, "y\n");
  ok("subagentsActive: true when an agent-*.jsonl was just written", subagentsActive(stp) === true);
  const oldT = (Date.now() - 200_000) / 1000;
  utimesSync(ag, oldT, oldT);
  ok("subagentsActive: false once the agent transcript ages past the window", subagentsActive(stp) === false);
  ok("subagentsActive: false for an empty path", subagentsActive("") === false);
  rmSync(sd, { recursive: true, force: true });

  // (2) armBatonClose — auto path never arms a close without explicit opt-in.
  ok("armBatonClose: AUTO does not arm without config.autoCloseOriginal",
    armBatonClose("/tmp/nope.json", "9999", "", {}, { auto: true }) === false);
  ok("armBatonClose: AUTO opt-in still blocked by batonClose:false",
    armBatonClose("/tmp/nope.json", "9999", "", { autoCloseOriginal: true, batonClose: false }, { auto: true }) === false);
  ok("armBatonClose: never arms without a window id",
    armBatonClose("/tmp/nope.json", "", "", { autoCloseOriginal: true }, { auto: true }) === false);

  // (3) originalStillWorking — baton-close's final abort gate.
  const od = join(tmpdir(), "origbusy-" + process.pid);
  mkdirSync(od, { recursive: true });
  const ot = join(od, "orig.jsonl"); writeFileSync(ot, "x\n");
  ok("originalStillWorking: true when the original transcript was just written", originalStillWorking({ transcript_path: ot }) === true);
  const quietT = (Date.now() - 60_000) / 1000;
  utimesSync(ot, quietT, quietT);
  ok("originalStillWorking: false when quiet + no sub-agents", originalStillWorking({ transcript_path: ot }) === false);
  const osub = join(od, "orig", "subagents"); mkdirSync(osub, { recursive: true });
  writeFileSync(join(osub, "agent-1.jsonl"), "z\n");
  ok("originalStillWorking: true when a sub-agent transcript is fresh (still building)", originalStillWorking({ transcript_path: ot }) === true);
  ok("originalStillWorking: false for a record with no transcript", originalStillWorking({}) === false);
  rmSync(od, { recursive: true, force: true });
}

// --- orchestrator baton: held for the pane, and the map follows the thread (2026-08-27 seam) ---
// A handoff written by the project's recorded orchestrator thread (orch-sessions.txt) must not go
// to whichever window starts first: a stray 22:58 Terminal session claimed the orch baton, died,
// and muzzled the pane all night. Held for the pane (TRANTOR_ORCH) for a window that LAPSES; and
// whoever claims the orch baton becomes the recorded orch thread, so `trantor open` follows it.
// Hermetic: its own AGENT_BUS_DIR, so nothing touches the real map or handoffs.
{
  const op = "orchbaton-" + process.pid;
  const opDir = join(tmpdir(), op);
  const bus = join(tmpdir(), "orchbus-" + process.pid);
  mkdirSync(join(bus, "handoffs"), { recursive: true });
  mkdirSync(opDir, { recursive: true });
  const map = join(bus, "orch-sessions.txt");
  const hfp = (stamp) => join(bus, "handoffs", `${op}-${stamp}.json`);
  const mkhf = (stamp, sid) => writeFileSync(hfp(stamp), JSON.stringify({ id: `${op}-${stamp}`, project: opDir, projectName: op, machine: "h", trigger: "auto", session_id: sid, stamp, summary: "ORCH_SUMMARY", gitStatus: "", consumed: false }, null, 2));
  const run = (env = {}, sid = "SUCC-SID") => {
    const r = spawnSync("node", ["hooks/sessionstart.mjs"], {
      input: JSON.stringify({ source: "startup", session_id: sid }),
      encoding: "utf8", timeout: 15000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: opDir, RELAY_SESSION: op, RELAY_URL: CLOSED, AGENT_BUS_DIR: bus, TRANTOR_ORCH: "", TRANTOR_ORCH_HOLD_MS: "", ...env },
    });
    try { return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext || ""; } catch { return ""; }
  };
  const consumedAt = (stamp) => JSON.parse(readFileSync(hfp(stamp), "utf8")).consumed;

  // held: a fresh orch-origin handoff + a plain session → notice only, unconsumed, map untouched
  writeFileSync(map, `${op}\tORCH-SID\n`);
  let st = Math.floor(Date.now() / 1000) - 60;
  mkhf(st, "ORCH-SID");
  let ctx = run();
  ok("orch-origin handoff is HELD for the pane (notice injected)", ctx.includes("trantor-handoff-held"));
  ok("held: the summary is NOT injected", !ctx.includes("ORCH_SUMMARY"));
  ok("held: the handoff stays unconsumed", consumedAt(st) === false);
  ok("held: the orch map is untouched", readFileSync(map, "utf8").includes("ORCH-SID"));

  // the pane claims immediately, and the map follows it
  ctx = run({ TRANTOR_ORCH: op }, "PANE-SID");
  ok("the orch pane claims the held baton immediately", ctx.includes("ORCH_SUMMARY") && consumedAt(st) === true);
  ok("…and the map now points at the pane's session", readFileSync(map, "utf8").includes(`${op}\tPANE-SID`));
  rmSync(hfp(st), { force: true });

  // the hold lapses: an aged orch baton is first-come, and the map follows the claimant
  writeFileSync(map, `${op}\tPANE-SID\n`);
  st = Math.floor(Date.now() / 1000) - 3600;
  mkhf(st, "PANE-SID");
  ctx = run({}, "LATE-SID");
  ok("the hold LAPSES: an aged orch baton is claimed first-come", ctx.includes("ORCH_SUMMARY") && consumedAt(st) === true);
  ok("…and the map follows the late claimant", readFileSync(map, "utf8").includes(`${op}\tLATE-SID`));
  rmSync(hfp(st), { force: true });

  // a handoff from a NON-orch thread keeps first-wins and leaves the map alone
  writeFileSync(map, `${op}\tOTHER-SID\n`);
  st = Math.floor(Date.now() / 1000) - 60;
  mkhf(st, "TERMINAL-SID");
  ctx = run({}, "ANY-SID");
  ok("a non-orch handoff keeps first-fresh-session-wins", ctx.includes("ORCH_SUMMARY") && consumedAt(st) === true);
  ok("…and does NOT rewrite the orch map", readFileSync(map, "utf8").includes(`${op}\tOTHER-SID`));
  rmSync(hfp(st), { force: true });
  rmSync(bus, { recursive: true, force: true });
  rmSync(opDir, { recursive: true, force: true });
}

// --- orchWriterSid: who is writing this handoff — evidence, not assertion ---
// The relay MCP server has no harness session id (found live 2026-08-28: a tool-written orch
// handoff carried session_id null, so the baton-hold could never fire). The writer is the orch
// thread when the pane badge says so, or when the recorded thread's transcript is being written
// RIGHT NOW (mtime — the adopt standard). Idle-thread and no-map cases must answer "".
{
  const wp = "orchwriter-" + process.pid;
  const wpDir = join(tmpdir(), wp);
  const bus = join(tmpdir(), "orchwbus-" + process.pid);
  const cpd = join(tmpdir(), "orchwclaude-" + process.pid);
  const slug = wpDir.replace(/[/.]/g, "-");
  mkdirSync(join(cpd, slug), { recursive: true });
  mkdirSync(bus, { recursive: true });
  const prevBus = process.env.AGENT_BUS_DIR;   // restore, never delete — the operator may have set it
  process.env.AGENT_BUS_DIR = bus;   // readOrchSession resolves through busDir()
  const opts = { env: {}, claudeProjectsDir: cpd };
  ok("orchWriterSid: no map row → empty", orchWriterSid(wpDir, wp, opts) === "");
  writeFileSync(join(bus, "orch-sessions.txt"), `${wp}\tW-SID\n`);
  ok("orchWriterSid: mapped but transcript missing → empty", orchWriterSid(wpDir, wp, opts) === "");
  ok("orchWriterSid: the pane badge is definitive", orchWriterSid(wpDir, wp, { ...opts, env: { TRANTOR_ORCH: wp } }) === "W-SID");
  ok("orchWriterSid: a badge for ANOTHER project does not count", orchWriterSid(wpDir, wp, { ...opts, env: { TRANTOR_ORCH: "other" } }) === "");
  const tpath = join(cpd, slug, "W-SID.jsonl");
  writeFileSync(tpath, "x\n");
  ok("orchWriterSid: a freshly-written orch transcript is the writer", orchWriterSid(wpDir, wp, opts) === "W-SID");
  const oldT = (Date.now() - 600_000) / 1000;
  utimesSync(tpath, oldT, oldT);
  ok("orchWriterSid: an idle orch thread is NOT the writer", orchWriterSid(wpDir, wp, opts) === "");
  if (prevBus === undefined) delete process.env.AGENT_BUS_DIR; else process.env.AGENT_BUS_DIR = prevBus;
  rmSync(bus, { recursive: true, force: true });
  rmSync(cpd, { recursive: true, force: true });
}

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
rmSync(hfile, { force: true }); // the writeHandoff() record above — was leaking into the live handoffs dir
rmSync(join(homedir(), ".agent-bus", `handoff-fired-pctest-${process.pid}.json`), { force: true });
rmSync(tmp, { recursive: true, force: true });
rmSync(projDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
