#!/usr/bin/env node
// trantor handoff tests — the context-limit → fresh-session machinery.
// Hermetic: no network (RELAY_URL closed), no LLM (TRANTOR_NO_SCROOGE=1 → the
// deterministic whole-session digest is used instead of scrooge), no Terminal
// windows (TRANTOR_NO_HANDOFF_SPAWN=1). Regression coverage for the three gaps
// that broke the promise: tail-only summary, compact eating its own handoff,
// and the spawn never firing.
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync, execSync } from "node:child_process";
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

// Hermetic env: a crew seat's runner exports RELAY_PROJECT/RELAY_AGENT, which the spawned hooks
// below would inherit — resolving the CREW's project instead of each fixture's (2026-08-31: six
// orch-baton failures on the kimi:trantor seat, all from the leaked RELAY_PROJECT). Strip them
// once here; every block that needs a seat identity sets RELAY_SESSION explicitly.
delete process.env.RELAY_PROJECT;
delete process.env.RELAY_AGENT;

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
ok("#5503: resolveWindow knows fable is a 1M window by name", resolveWindow("fable", {}) === 1_000_000);
ok("#5503: a fable variant name resolves 1M too", resolveWindow("fable-5-2026", {}) === 1_000_000);
ok("#5503: an explicit declaration still wins over the fable heuristic", resolveWindow("fable", { contextWindow: 200000 }) === 200000);
ok("warnFrac default 0.90 (baton pass fires at 90%)", warnFrac({}) === 0.90);
ok("warnFrac config override", warnFrac({ contextWarnFrac: 0.9 }) === 0.9);

// #5503 end to end: a fable transcript with NO declared window now computes frac —
// the early-warning activates exactly where #5503 silently stayed off (the baton
// never fired; the session hit the wall).
const fableT = join(tmp, "fable.jsonl");
writeFileSync(fableT, rows.map(r => JSON.stringify({ ...r, message: { ...r.message, model: "fable" } })).join("\n"));
const fwin = contextUsage(fableT, {});
ok("#5503: a fable transcript gets its window by NAME (frac computed, no config)", fwin && fwin.window === 1_000_000 && Math.abs(fwin.frac - 0.910) < 0.01);

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
// #5648: the verbatim tail is NO LONGER embedded — the summary is the recap, capped ~4KB, and
// transcript_path points at the full exchange. Embedding it made the successor pay for the same
// context twice (injected summary + persisted overflow re-read).
ok("writeHandoff does NOT embed the verbatim block (transcript_path points at it)",
  !/Verbatim recent exchange/.test(hrec.summary) && hrec.transcript_path === transcript);
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
      projectDir: tmp, handoffFile: "/tmp/x.json", _env: {},   // pin the env: a drill (or crew seat) may ITSELF live in a herdr pane — HERDR_PANE_ID must not preempt these mocks (#6074)
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
      // RELAY_PROJECT="" — a seat runner exports RELAY_PROJECT for ITS project, and
      // resolveProject honours it BEFORE any path, so the subprocess would resolve the fixture
      // dir to the seat's project and the orch map row would never match (#5648 drill fix).
      env: { ...process.env, RELAY_PROJECT: "", CLAUDE_PROJECT_DIR: opDir, RELAY_SESSION: op, RELAY_URL: CLOSED, AGENT_BUS_DIR: bus, TRANTOR_ORCH: "", TRANTOR_ORCH_HOLD_MS: "", ...env },
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

// --- #5509 W1: the pane is the successor surface ---
{
  const bus = join(tmpdir(), "orchpane-" + process.pid);
  mkdirSync(bus, { recursive: true });
  const prevBus2 = process.env.AGENT_BUS_DIR;
  process.env.AGENT_BUS_DIR = bus;
  const { hasOrchPane } = await import("./hooks/lib/handoff.mjs?orchpane");
  ok("hasOrchPane: false with no state file", hasOrchPane("paneproj") === false);
  writeFileSync(join(bus, "crew-windows.txt"), "paneproj\therdrws\t__ws__\tw9\npaneproj\torch\t__orch__\tw9:p1\n");
  ok("hasOrchPane: true when the project has a tracked orch row", hasOrchPane("paneproj") === true);
  ok("hasOrchPane: false for a project with only seat rows", hasOrchPane("otherproj") === false);
  if (prevBus2 === undefined) delete process.env.AGENT_BUS_DIR; else process.env.AGENT_BUS_DIR = prevBus2;
  rmSync(bus, { recursive: true, force: true });
}

// --- baton --write-only: writes and announces, NEVER spawns (the in-app flow, #5509) ---
{
  const bus = join(tmpdir(), "wobus-" + process.pid);
  const projDir2 = join(tmpdir(), "woproj-" + process.pid);
  mkdirSync(join(bus, "handoffs"), { recursive: true });
  mkdirSync(projDir2, { recursive: true });
  const r = spawnSync("node", [join(process.cwd(), "bin", "baton.mjs"), "--write-only"], {
    cwd: projDir2, encoding: "utf8", timeout: 30000,
    // Explicit env, no process.env passthrough (#6074) — same identity-var reason as above.
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      AGENT_BUS_DIR: bus, TRANTOR_NO_SCROOGE: "1", TRANTOR_NO_HANDOFF_SPAWN: "1", RELAY_URL: CLOSED,
      HERDR_ENV: "", HERDR_PANE_ID: "", TRANTOR_ORCH: "",
      RELAY_PROJECT: "", TRANTOR_PROJECT: "", RELAY_SESSION: "", RELAY_AGENT: "",
    },
  });
  const wrote = (await import("node:fs")).readdirSync(join(bus, "handoffs")).length;
  ok("write-only exits 0", r.status === 0);
  ok("write-only writes the handoff", wrote === 1);
  ok("write-only announces itself and stops before any spawn", r.stdout.includes("write-only") && !r.stdout.includes("fresh session is opening"));
  rmSync(bus, { recursive: true, force: true });
  rmSync(projDir2, { recursive: true, force: true });
}

// ---- #5572 context guard: the SHARED manifest both implementations must satisfy ----
// (the Rust twin runs the same file in cargo — test/fixtures/context/manifest.json)
{
  const { guardContextTokens } = await import("./hooks/lib/handoff.mjs");
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/context/manifest.json"), "utf8"));
  for (const c of manifest.cases) {
    const got = guardContextTokens(c.rows);
    ok(`context guard: ${c.name} → ${c.expect}`, (got ?? null) === (c.expect ?? null));
  }
  // #5572 drill extension: the aborted-turn STUB shape (7% shown at a real 88%) at
  // every stub count. The manifest above is shared with the Rust twin, so these
  // stub-count drills stay inline here rather than editing the shared spec file.
  const REAL = 889929, STUB = 70000;
  ok("guard drill: a single stub tail reads the real level", guardContextTokens([REAL, STUB]) === REAL);
  ok("guard drill: 2 consecutive stubs still read the real level", guardContextTokens([884056, REAL, STUB, STUB]) === REAL);
  ok("guard drill: 4 consecutive stubs still read the real level", guardContextTokens([884056, REAL, STUB, STUB, STUB, STUB]) === REAL);
  ok("guard drill: 5 consecutive stubs are a sustained new level (re-baseline)", guardContextTokens([884056, REAL, STUB, STUB, STUB, STUB, STUB]) === STUB);
  ok("guard drill: a drop to exactly the 40% floor is accepted as reality", guardContextTokens([1_000_000, 400_000]) === 400_000);
  // And end-to-end through contextUsage: a poisoned transcript tail reads as the real level.
  const dir = join(tmpdir(), `tt-ctx-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const t = join(dir, "poisoned.jsonl");
  const row = (tok) => JSON.stringify({ type: "assistant", message: { model: "fable", usage: { input_tokens: 1000, cache_read_input_tokens: tok - 1000 } } });
  writeFileSync(t, [row(400000), row(884056), row(889929), row(70000)].join("\n") + "\n");
  const u = contextUsage(t, { contextWindow: 1000000 });
  ok("contextUsage survives a poisoned tail (reads 889929, not 70000)", u?.tokens === 889929 && Math.abs(u.frac - 0.889929) < 1e-6);
  rmSync(dir, { recursive: true, force: true });
}

// ---- §5 state ledger + recap net (Phase 4B): the machine's transitions ride the handoff file ----
{
  const { appendHandoffState } = await import("./hooks/lib/handoff.mjs");
  const { handoffDir } = await import("./lib/project.mjs");
  const projDir = join(tmpdir(), `tt-h5-${process.pid}`); mkdirSync(projDir, { recursive: true });
  const t = join(projDir, "t.jsonl");
  writeFileSync(t, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "work ".repeat(40) }], usage: { input_tokens: 100000 } } }) + "\n");
  process.env.TRANTOR_NO_SCROOGE = "1";   // hermetic: deterministic digest, no LLM call
  const { record: w, file: wfile } = writeHandoff({ projectDir: projDir, sessionId: "pred-1", transcript: t, trigger: "drill", force: true });
  const rec0 = JSON.parse(readFileSync(join(handoffDir(), `${w.id}.json`), "utf8"));
  ok("§5 ledger: a written handoff records WRITTEN with its author", rec0.states?.length === 1 && rec0.states[0].state === "written" && rec0.states[0].by === "pred-1");
  appendHandoffState(w.id, "claimed", "succ-1");
  appendHandoffState(w.id, "recapped", "succ-1");
  const rec1 = JSON.parse(readFileSync(join(handoffDir(), `${w.id}.json`), "utf8"));
  ok("§5 ledger: claimed and recapped append in order", rec1.states.map(s => s.state).join(",") === "written,claimed,recapped");

  // The recap net, end to end through the REAL hooks as subprocesses.
  const sid = "succ-net-1";
  writeFileSync(join(handoffDir(), `recap-pending-${sid}.json`), JSON.stringify({ handoffId: w.id, ts: 1 }));
  const hookEnv = { ...process.env, RELAY_URL: CLOSED, TRANTOR_NO_FOCUS: "" };
  const pf = spawnSync(process.execPath, ["hooks/prompt-focus.mjs"], { input: JSON.stringify({ session_id: sid, prompt: "a stale queued message that must still carry the reminder", cwd: projDir }), encoding: "utf8", env: hookEnv, timeout: 15000 });
  ok("recap net: every pre-recap prompt carries the reminder", pf.stdout.includes("additionalContext") && pf.stdout.includes(w.id));
  const si = spawnSync(process.execPath, ["hooks/stop-inbox.mjs"], { input: JSON.stringify({ session_id: sid, cwd: projDir }), encoding: "utf8", env: { ...hookEnv, RELAY_STOP_TIMEOUT_MS: "200" }, timeout: 15000 });
  const rec2 = JSON.parse(readFileSync(join(handoffDir(), `${w.id}.json`), "utf8"));
  ok("recap net: the first Stop records RECAPPED on the ledger", rec2.states.some(s => s.state === "recapped" && s.by === sid));
  ok("recap net: the stamp is cleared — the reminder stops", !existsSync(join(handoffDir(), `recap-pending-${sid}.json`)));
  const pf2 = spawnSync(process.execPath, ["hooks/prompt-focus.mjs"], { input: JSON.stringify({ session_id: sid, prompt: "a later ordinary message", cwd: projDir }), encoding: "utf8", env: hookEnv, timeout: 15000 });
  ok("recap net: after recap, prompts carry nothing", !pf2.stdout.includes("additionalContext"));
  rmSync(projDir, { recursive: true, force: true });
  rmSync(wfile, { force: true });   // like the earlier writeHandoff drill: never leak into the live handoffs dir
}

// ---- #5648: handoff writer discipline — capped recap, defer to fresh model-authored, mode ----
{
  const { capSummary, freshAuthoredHandoff, handoffMode } = await import("./hooks/lib/handoff.mjs");
  const { setAutonomy } = await import("./lib/autonomy.mjs");

  // cap: pure function — small text untouched, big text keeps BOTH ends on paragraph boundaries
  const small = "tiny";
  ok("capSummary: text under the cap is untouched", capSummary(small) === small);
  const big = Array.from({ length: 400 }, (_, i) => `para ${i} ${String(i).repeat(30)}`).join("\n\n");
  const capped = capSummary(big);
  ok("capSummary: oversized text is cut to ~4KB", capped.length <= 4096 && capped.includes("[…]"));
  ok("capSummary: the cut keeps the opening AND the tail", capped.startsWith(big.slice(0, 40)) && capped.endsWith(big.slice(-40)));

  // end to end: the composed digest of a big transcript is recap-sufficient at <=~4KB,
  // carries mode:"attended" by default, and seeds the §5 ledger. Own transcript: the shared
  // `transcript` fixture is DELETED by the mid-file cleanup above, and a deleted input would
  // silently summarize to the placeholder.
  const cp = "cap-e2e-" + process.pid;
  const cpDir = join(tmpdir(), cp);
  mkdirSync(cpDir, { recursive: true });
  const capT = join(cpDir, "t.jsonl");
  writeFileSync(capT, rows.map(r => JSON.stringify(r)).join("\n"));
  process.env.TRANTOR_NO_SCROOGE = "1";
  const { record: crec, file: cfile } = writeHandoff({ projectDir: cpDir, sessionId: "cap-e2e", transcript: capT, trigger: "context-warn" });
  delete process.env.TRANTOR_NO_SCROOGE;
  ok("cap: the inline summary stays within the ~4KB injection budget", crec.summary.length <= 4200);
  ok("cap: recap-sufficient — the SESSION START and END both survive the cut", crec.summary.includes(FIRST) && crec.summary.includes(LAST));
  ok("mode: defaults to attended", crec.mode === "attended");
  rmSync(cfile, { force: true });
  rmSync(cpDir, { recursive: true, force: true });

  // defer: a FRESH (<15min) unconsumed model-authored handoff is deferred TO — not recomposed,
  // not superseded. The digest is the fallback, never the replacement (#5648 incident).
  const fp = "defer-" + process.pid;
  const fpDir = join(tmpdir(), fp);
  mkdirSync(fpDir, { recursive: true });
  const nowS = Math.floor(Date.now() / 1000);
  const freshFile = join(handoffDir, `${fp}-${nowS}.json`);
  writeFileSync(freshFile, JSON.stringify({ id: `${fp}-${nowS}`, project: fpDir, projectName: fp, machine: "h", trigger: "manual-skill", stamp: nowS, summary: "HAND_AUTHORED_WORDS", consumed: false }, null, 2));
  ok("freshAuthoredHandoff: finds the fresh manual-skill record", freshAuthoredHandoff(fp)?.id === `${fp}-${nowS}`);
  process.env.TRANTOR_NO_SCROOGE = "1";
  const dres = writeHandoff({ projectDir: fpDir, sessionId: "def", transcript, trigger: "context-warn" });
  delete process.env.TRANTOR_NO_SCROOGE;
  ok("defer: writeHandoff defers to the fresh model-authored handoff", dres.deferred === true && dres.file === freshFile && dres.record.summary === "HAND_AUTHORED_WORDS");
  ok("defer: the authored record stays unconsumed — nothing superseded it", JSON.parse(readFileSync(freshFile, "utf8")).consumed === false);
  ok("defer: no new record was composed", readdirSync(handoffDir).filter(f => f.startsWith(fp + "-")).length === 1);

  // a manual-baton trigger counts too; a stale (>15min) authored one does NOT defer — and a fresh
  // digest then correctly retires it via supersede
  rmSync(freshFile, { force: true });
  const oldS = nowS - 1000;
  const staleFile = join(handoffDir, `${fp}-${oldS}.json`);
  writeFileSync(staleFile, JSON.stringify({ id: `${fp}-${oldS}`, project: fpDir, projectName: fp, machine: "h", trigger: "manual-baton", stamp: oldS, summary: "STALE_AUTHORED", consumed: false }, null, 2));
  ok("freshAuthoredHandoff: a >15min authored handoff is NOT fresh", freshAuthoredHandoff(fp) === null);
  process.env.TRANTOR_NO_SCROOGE = "1";
  const sres = writeHandoff({ projectDir: fpDir, sessionId: "def2", transcript, trigger: "context-warn" });
  delete process.env.TRANTOR_NO_SCROOGE;
  ok("defer: a STALE authored handoff does not defer — compose fresh", sres.deferred === undefined && !!sres.record);
  ok("defer: the stale authored record is retired by the fresh digest", JSON.parse(readFileSync(staleFile, "utf8")).consumed === true && JSON.parse(readFileSync(staleFile, "utf8")).superseded === true);
  ok("defer: an AUTO trigger never defers (records above were the only ones)", sres.record.trigger === "context-warn");
  rmSync(staleFile, { force: true });
  rmSync(sres.file, { force: true });
  rmSync(fpDir, { recursive: true, force: true });

  // mode: unattended comes from the resolved autonomy baton dial (`trantor autonomy json`),
  // read through an AGENT_BUS_DIR redirect so the drill never touches the operator's real dials
  const mp = "mode-" + process.pid;
  const mpDir = join(tmpdir(), mp);
  const mbus = join(tmpdir(), "modebus-" + process.pid);
  mkdirSync(mpDir, { recursive: true });
  mkdirSync(mbus, { recursive: true });
  const prevBusM = process.env.AGENT_BUS_DIR;
  process.env.AGENT_BUS_DIR = mbus;
  ok("mode: no autonomy file → attended", handoffMode(mp) === "attended");
  setAutonomy(mp, { baton: "auto" });
  ok("mode: baton:auto → unattended", handoffMode(mp) === "unattended");
  ok("mode: another project stays attended (the dial is per-project)", handoffMode("other-" + process.pid) === "attended");
  const mrec = (() => { try { return handoffMode("") === "attended"; } catch { return false; } })();
  ok("mode: empty project name still answers attended", mrec);
  if (prevBusM === undefined) delete process.env.AGENT_BUS_DIR; else process.env.AGENT_BUS_DIR = prevBusM;
  rmSync(mbus, { recursive: true, force: true });
  rmSync(mpDir, { recursive: true, force: true });
}

// ---- #5642/#5648: the MANUAL skill path opens the §5 ledger and carries the same interface ----
{
  const wp2 = "manual-skill-" + process.pid;
  const wp2Dir = join(tmpdir(), wp2);
  mkdirSync(wp2Dir, { recursive: true });
  const r = spawnSync("node", [join(process.cwd(), "bin", "write-handoff.mjs")], {
    cwd: wp2Dir, input: "# handoff\nMANUAL_SKILL_BODY", encoding: "utf8", timeout: 30000,
    // Explicit env, no process.env passthrough (#6074): a gate runner inside a herdr pane exports
    // HERDR_PANE_ID/TRANTOR_ORCH — the resolver reads that registration FIRST, so the record would
    // be named (and autonomy-keyed) after the RUNNER's project instead of this temp one.
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      CLAUDE_PROJECT_DIR: wp2Dir, RELAY_URL: CLOSED, TRANTOR_NO_HANDOFF_SPAWN: "1", TRANTOR_NO_BATON_SPAWN: "1",
      HERDR_ENV: "", HERDR_PANE_ID: "", TRANTOR_ORCH: "",
      RELAY_PROJECT: "", TRANTOR_PROJECT: "", RELAY_SESSION: "", RELAY_AGENT: "",
    },
  });
  ok("manual write-handoff exits 0", r.status === 0);
  const mf = /handoff saved: (\S+\.json)/.exec(r.stdout)?.[1];
  const mrec = (() => { try { return JSON.parse(readFileSync(mf, "utf8")); } catch { return null; } })();
  ok("manual record opens the §5 ledger with WRITTEN (#5642)", mrec?.states?.length === 1 && mrec.states[0].state === "written" && mrec.states[0].by === "manual-skill");
  ok("manual record carries the kimi-consumed interface (mode + transcript_path)", mrec?.mode === "attended" && mrec?.transcript_path === "");
  if (mf) rmSync(mf, { force: true });
  rmSync(wp2Dir, { recursive: true, force: true });
}

// ---- #5645 agent-aware succession: arm-time notice, injection cap, mandate pinning ----
// Hermetic: temp AGENT_BUS_DIR (autonomy dial baton:"auto"), closed hub, no LLM, no windows.
{
  const bus = join(tmpdir(), `tt-succ-bus-${process.pid}`);
  const projDir3 = join(tmpdir(), `tt-succ-proj-${process.pid}`);
  const proj3 = projDir3.split("/").pop();
  mkdirSync(join(bus, "handoffs"), { recursive: true });
  mkdirSync(projDir3, { recursive: true });
  writeFileSync(join(bus, "autonomy.json"), JSON.stringify({ defaults: { baton: "auto" } }));
  const succEnv = { ...process.env, AGENT_BUS_DIR: bus, RELAY_URL: CLOSED, RELAY_CONTEXT_WINDOW: "1000000", RELAY_CONTEXT_WARN_FRAC: "0.9" };

  // (1) the heartbeat ARMS at the warn line and tells the RUNNING agent — exactly once per arming.
  // NB: the suite's shared `transcript` fixture is already cleaned up by this point — write our own
  // (91% of the declared 1M window).
  const hbTranscript = join(bus, "hb.jsonl");
  writeFileSync(hbTranscript, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }], model: "claude-opus-4-8", usage: { input_tokens: 5, cache_read_input_tokens: 909000, cache_creation_input_tokens: 1000 } } }) + "\n");
  const hbSid = `hb5645-${process.pid}`;
  const hbIn = JSON.stringify({ transcript_path: hbTranscript, session_id: hbSid, cwd: projDir3 });
  const hbEnv = { ...succEnv, RELAY_SESSION: `kimi5645:${proj3}`, CLAUDE_PROJECT_DIR: projDir3, RELAY_HEARTBEAT_MS: "0" };
  const hb1 = spawnSync(process.execPath, ["hooks/heartbeat.mjs"], { input: hbIn, encoding: "utf8", timeout: 15000, env: hbEnv });
  const hbCtx1 = (() => { try { return JSON.parse(hb1.stdout).hookSpecificOutput?.additionalContext || ""; } catch { return ""; } })();
  ok("arm: the heartbeat injects the succession notice AT arm time", hbCtx1.includes("SUCCESSION ARMED") && hbCtx1.includes("NEXT STOP"));
  ok("arm: the notice makes the agent author its own boundary handoff", hbCtx1.includes("handoff skill") && hbCtx1.includes("relay_handoff"));
  const hb2 = spawnSync(process.execPath, ["hooks/heartbeat.mjs"], { input: hbIn, encoding: "utf8", timeout: 15000, env: hbEnv });
  ok("arm: already-armed ticks inject NOTHING (no per-tool-call spam)", hb2.stdout.trim() === "{}");

  // sessionstart runner for this block (claims whatever handoff is pending for proj3)
  const ssrun = (sid) => spawnSync(process.execPath, ["hooks/sessionstart.mjs"], {
    input: JSON.stringify({ source: "startup", session_id: sid }), encoding: "utf8", timeout: 15000,
    env: { ...succEnv, CLAUDE_PROJECT_DIR: projDir3, RELAY_SESSION: proj3 },
  });
  const ctxOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext || ""; } catch { return ""; } };

  // (2) injection cap: a 15KB record (narrative + embedded verbatim tail) injects ≤4KB + a pointer.
  const big = "N".repeat(6000) + "\n---\n## Verbatim recent exchange (exact in-flight state — continue from here)\n" + "V".repeat(9000);
  writeFileSync(join(bus, "handoffs", `${proj3}-1000000000.json`), JSON.stringify({
    id: `${proj3}-1000000000`, project: projDir3, projectName: proj3, machine: "h", trigger: "context-warn",
    summary: big, transcript_path: "/tmp/full-transcript.jsonl", stamp: 1000000000, gitStatus: "", consumed: false,
  }, null, 2));
  const capCtx = ctxOf(ssrun("CAP-SID"));
  ok("cap: the embedded verbatim tail is NEVER injected inline", !capCtx.includes("V".repeat(100)));
  ok("cap: the injected summary is hard-capped at 4KB", capCtx.includes("N".repeat(4096)) && !capCtx.includes("N".repeat(4100)));
  ok("cap: the cap notice points at the full record + transcript", capCtx.includes("summary capped at 4096 chars") && capCtx.includes("full transcript: /tmp/full-transcript.jsonl"));
  ok("cap: a capped record still claims + stamps the recap net (default attended)",
    JSON.parse(readFileSync(join(bus, "handoffs", `${proj3}-1000000000.json`), "utf8")).consumed === true
    && JSON.parse(readFileSync(join(bus, "handoffs", "recap-pending-CAP-SID.json"), "utf8")).mode === "attended");

  // (3) mandate pinning by rec.mode.
  ok("mandate: attended (default) pins recap-then-WAIT", capCtx.includes('mode="attended"') && capCtx.includes("then wait"));
  const pfA = spawnSync(process.execPath, ["hooks/prompt-focus.mjs"], {
    input: JSON.stringify({ session_id: "CAP-SID", prompt: "a queued message before the recap", cwd: projDir3 }),
    encoding: "utf8", env: { ...succEnv, TRANTOR_NO_FOCUS: "" }, timeout: 15000 });
  ok("mandate: the attended recap reminder pins WAIT", pfA.stdout.includes("WAIT for the user"));

  writeFileSync(join(bus, "handoffs", `${proj3}-1000000100.json`), JSON.stringify({
    id: `${proj3}-1000000100`, project: projDir3, projectName: proj3, machine: "h", trigger: "context-warn",
    summary: "UNATTENDED_SUMMARY", stamp: 1000000100, mode: "unattended", gitStatus: "", consumed: false,
  }, null, 2));
  const uctx = ctxOf(ssrun("UNATT-SID"));
  ok("mandate: unattended pins recap-then-RESUME (open threads are the work order)",
    uctx.includes('mode="unattended"') && uctx.includes("RESUME") && uctx.includes("work order") && !uctx.includes("then wait"));
  ok("mandate: the recap stamp carries mode=unattended",
    JSON.parse(readFileSync(join(bus, "handoffs", "recap-pending-UNATT-SID.json"), "utf8")).mode === "unattended");
  const pfU = spawnSync(process.execPath, ["hooks/prompt-focus.mjs"], {
    input: JSON.stringify({ session_id: "UNATT-SID", prompt: "a queued message before the recap", cwd: projDir3 }),
    encoding: "utf8", env: { ...succEnv, TRANTOR_NO_FOCUS: "" }, timeout: 15000 });
  ok("mandate: the unattended recap reminder pins RESUME, not wait", pfU.stdout.includes("RESUME") && pfU.stdout.includes("do NOT wait"));

  rmSync(bus, { recursive: true, force: true });
  rmSync(projDir3, { recursive: true, force: true });
  rmSync(join(homedir(), ".agent-bus", `handoff-armed-${hbSid}.json`), { force: true });
  rmSync(join(homedir(), ".agent-bus", `hb-kimi5645_${proj3}.stamp`), { force: true });
}

// ---- #5643: the baton's pane leg — routing and the row parser ----
// All seams mocked, so nothing can spawn; the operator's guard envs are cleared for the call
// (same doctrine as the ordering regression above) and restored whatever happens.
{
  const PANE_GUARDS = ["TRANTOR_NO_HANDOFF_SPAWN", "TRANTOR_NO_BATON_SPAWN"];
  const saved = Object.fromEntries(PANE_GUARDS.map(k => [k, process.env[k]]));
  const calls = [];
  let r;
  try {
    for (const k of PANE_GUARDS) delete process.env[k];
    r = spawnBaton({ projectDir: "/x/projP", handoffFile: "/x/h.json", conf: {}, _env: {},
      _hasPane: (n) => { calls.push(`has:${n}`); return true; },
      _spawnPane: (d, f) => { calls.push(`pane:${d}:${f}`); return true; },
      _resolveWindow: () => { calls.push("resolve"); return { windowId: "W", tty: "" }; },
      _spawnFresh: () => { calls.push("fresh"); return true; },
      _armClose: () => { calls.push("arm"); return true; },
    });
  } finally { for (const k of PANE_GUARDS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  ok("#5643: a hosted pane routes the baton to the pane driver, never a window",
    r?.pane === true && r?.spawned === true && calls.join(",") === "has:projP,pane:/x/projP:/x/h.json");
  const { orchPane } = await import("./bin/baton-pane.mjs");
  ok("#5643: orchPane picks the LAST orch row's pane (orch_pane_from_rows parity)",
    orchPane("p\torch\t__orch__\tw1:p1\nq\torch\t__orch__\tw9:p9\np\torch\t__orch__\tw2:p2\n", "p") === "w2:p2"
    && orchPane("x\therdr\ta\tw1:p1\n", "x") === null);
}

// ---- the resume-vs-handoff collision (2026-08-31: TWO handoffs written, ZERO fresh takeovers —
// each "successor" was the old conversation resumed with the takeover banner injected on top,
// so the recap read clean while the context never reset) ----
{
  const bus = join(tmpdir(), `tt-resume-${process.pid}`);
  const projDir = join(bus, "proj");
  mkdirSync(join(bus, "handoffs"), { recursive: true });
  mkdirSync(projDir, { recursive: true });
  const hf = join(bus, "handoffs", "proj-1000000200.json");
  const baseRec = { id: "proj-1000000200", project: projDir, projectName: "proj", machine: "h", trigger: "manual-skill", stamp: 1000000200, summary: "REBOOT_HANDOFF", consumed: false, states: [{ state: "written", ts: 1, by: "pred" }] };
  writeFileSync(hf, JSON.stringify(baseRec));
  const env = { ...process.env, AGENT_BUS_DIR: bus, RELAY_URL: CLOSED, TRANTOR_NO_HANDOFF_SPAWN: "1", TRANTOR_NO_BATON_SPAWN: "1" };
  delete env.TRANTOR_ORCH;

  // 1) a RESUMED session must not claim — and must not wear the takeover banner
  const r1 = spawnSync(process.execPath, ["hooks/sessionstart.mjs"], { input: JSON.stringify({ session_id: "resumed-1", source: "resume", cwd: projDir }), encoding: "utf8", env, timeout: 20000 });
  const rec1 = JSON.parse(readFileSync(hf, "utf8"));
  ok("resume guard: a resumed session does NOT claim the waiting handoff", rec1.consumed === false && !rec1.states.some(s => s.state === "claimed"));
  ok("resume guard: no takeover banner into a resumed context", !r1.stdout.includes("You are taking over"));
  ok("resume guard: the refusal is LOUD (unclaimed notice names trantor open)", r1.stdout.includes("trantor-handoff-unclaimed") && r1.stdout.includes("trantor open"));

  // 2) a FRESH start still claims it, banner and all
  const r2 = spawnSync(process.execPath, ["hooks/sessionstart.mjs"], { input: JSON.stringify({ session_id: "fresh-1", source: "startup", cwd: projDir }), encoding: "utf8", env, timeout: 20000 });
  const rec2 = JSON.parse(readFileSync(hf, "utf8"));
  ok("resume guard: a fresh start still claims (consumed + CLAIMED by the fresh sid)", rec2.consumed === true && rec2.states.some(s => s.state === "claimed" && s.by === "fresh-1"));
  ok("resume guard: the fresh claimer gets the takeover banner", r2.stdout.includes("You are taking over"));

  // 3) crew.sh `open`: ANY unconsumed handoff forces a FRESH sid — manual records carry no
  //    session_id, which is exactly why the old written-by-this-sid predicate never fired.
  writeFileSync(hf, JSON.stringify(baseRec));   // re-arm as unconsumed
  // End at a LONE brace: /^}/ also matched the embedded node script's "}catch(e){}" line and
  // truncated the function mid-body.
  const fnSrc = execSync(`sed -n '/^_orch_takeover_sid()/,/^}$/p' bin/crew.sh`, { encoding: "utf8" });
  // Via stdin (`bash -s`), never `bash -c "<double-quoted>"`: the outer shell would expand the
  // function body's $(uuidgen), $1 and $& before bash ever saw them.
  const runFn = () => {
    const r = spawnSync("bash", ["-s"], { input: fnSrc + "\n_orch_takeover_sid proj recorded-sid\n", encoding: "utf8", env });
    return (r.stdout || "").trim();
  };
  const out1 = runFn();
  ok("open: an unconsumed handoff (no session_id field) forces a FRESH sid", out1 !== "recorded-sid" && out1.length >= 8);
  writeFileSync(hf, JSON.stringify({ ...baseRec, consumed: true }));
  ok("open: with nothing unclaimed, the recorded sid resumes as before", runFn() === "recorded-sid");
  rmSync(bus, { recursive: true, force: true });
}

// ---- open resolves a NAMED project's checkout (2026-08-31: the app's Wake ran `trantor open
// crebral-health` from the Tauri cwd and claude booted there — wrong-folder trust prompt, wrong
// transcript slug, ACTIVE NOW blind) ----
{
  const root = join(tmpdir(), `tt-resolve-${process.pid}`);
  mkdirSync(join(root, "devroot", "someproj"), { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  const fnSrc = execSync(`sed -n '/^_orch_resolve_dir()/,/^}$/p' bin/crew.sh`, { encoding: "utf8" });
  const env = { ...process.env, TRANTOR_DEV_ROOT: join(root, "devroot") };
  const runFn = (cwd, proj) => spawnSync("bash", ["-s"], {
    input: `${fnSrc}\n_orch_resolve_dir '${cwd}' '${proj}'\n`, encoding: "utf8", env,
  });
  const r1 = runFn(join(root, "elsewhere"), "someproj");
  ok("open: a named project opens in ITS checkout, not the caller's cwd",
    r1.status === 0 && r1.stdout.trim() === join(root, "devroot", "someproj") && r1.stderr.includes("its checkout"));
  const r2 = runFn(join(root, "elsewhere"), "");
  ok("open: no project arg keeps the caller's cwd (the from-inside-the-checkout habit)",
    r2.status === 0 && r2.stdout.trim() === join(root, "elsewhere"));
  const r3 = runFn(join(root, "elsewhere"), "no-such-proj");
  ok("open: an unknown name from an unrelated cwd refuses LOUDLY instead of opening somewhere silly",
    r3.status !== 0 && r3.stderr.includes("no checkout"));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

