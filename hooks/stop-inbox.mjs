#!/usr/bin/env node
// trantor Stop hook — don't go idle with a peer waiting on you.
//
// Pairs with hooks/inbox-deliver.mjs (PostToolUse), which reaches a session while it is MID-TURN calling
// tools. Between them they cover a running session; this one covers the moment it is about to stop.
//
// Both deliver the SAME way, and it is the only way that is safe: a session's own hook reads that
// session's own inbox and hands the text to its own model through the harness's sanctioned channel.
// Nothing reaches across a process boundary. An earlier attempt DID reach across — it typed messages
// into another session's terminal — and was removed: /send is unauthenticated with a self-asserted
// `from`, so any local process could have aimed keystrokes at an agent running with permissions
// bypassed. Delivery must go through the receiving agent's own harness, never by driving its terminal.
//
// The mechanism is the one already proven in-house by ~/.claude/hooks/verify-done-gate.py: a Stop hook
// that prints {"decision":"block","reason":…} makes the model continue with `reason` as its instruction.
//
// Design rules (deliberately conservative — a hook that blocks stops is a hook that can trap a session):
//   * DIRECT messages only. A broadcast is FYI; refusing to go idle over one would be maddening, and
//     inbox-deliver will surface it on the next turn anyway.
//   * stop_hook_active -> ALWAYS allow. One block per stop-cycle, never a loop, no matter what arrives.
//   * Only claim delivery once we have actually decided to surface it (peek first). Marking a message
//     delivered and then letting the stop through would hide it from the waker too — a silent hole.
//   * Any error, or a hub that is down -> allow the stop. Never trap a session because of us.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolveProject, hostId } from "../lib/project.mjs";
import { signedGet } from "./lib/api.mjs";   // signed: enforce hubs 401 unsigned reads — unsigned, T2 delivery is silently dead
import { ledgerPaths, ensureStart, anchorCursor, writeCursor } from "./lib/inbox-ledger.mjs";
import { readArm, clearArm, markHandedOff } from "./lib/handoff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const FETCH_TIMEOUT_MS = Number(process.env.RELAY_STOP_TIMEOUT_MS || 1500);

function sanitize(s) { return String(s == null ? "" : s).replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }
const allow = () => { process.stdout.write("{}"); process.exit(0); };

function readStdin() {
  return new Promise(res => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 500);
  });
}


// ---- the metronome: never park while a dispatched contract is stalled ----------------------
// An empty inbox is not the same as nothing outstanding. A session that dispatched work to a seat
// that then died sees silence and parks, and the human becomes the one who remembers, which is the
// complaint this exists to answer. So before letting a stop through we ask the hub what this
// session is still owed, and refuse ONCE if any of it has gone quiet.
//
// Deliberately narrow: only a contract whose assignee is offline, or one that is overdue, blocks.
// An open contract with a healthy seat working on it is exactly what "in progress" looks like, and
// nagging about it every stop would be worse than saying nothing. Fail-open throughout: a hub that
// is down or slow must never trap a session.
const OVERDUE_MS = (() => {
  const raw = process.env.TRANTOR_CONTRACT_OVERDUE_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
})();

async function stalledContractCheck({ session, project, instanceId }) {
  if (process.env.RELAY_STOP_CONTRACTS === "0") return allow();
  let contracts = [];
  try {
    const r = await signedGet(`/contracts?session=${encodeURIComponent(session)}&project=${encodeURIComponent(project)}`,
      { timeoutMs: FETCH_TIMEOUT_MS, session, instance: instanceId, project });
    if (!r.ok) return allow();
    contracts = r.json?.contracts || [];
  } catch { return allow(); }

  const stalled = contracts.filter(c => !c.answered && (!c.assigneeOnline || c.ageMs >= OVERDUE_MS));
  if (!stalled.length) return allow();

  const mins = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);
  const lines = stalled.slice(0, 6).map(c => {
    const health = c.assigneeOnline ? `online, status "${sanitize(c.assigneeStatus || "?")}"`
      : c.assigneeLastSeenMs == null ? "never seen on the bus"
      : `LAST SEEN ${mins(c.assigneeLastSeenMs)} ago`;
    return `- ${sanitize(c.to)} (${health}) — asked ${mins(c.ageMs)} ago: "${sanitize(String(c.text).slice(0, 120))}"`;
  }).join("\n");

  const reason =
    `You dispatched ${stalled.length} contract(s) that have gone quiet, and you were about to go idle:\n` +
    lines + `\n\n` +
    `Do not just wait, and do not ask the human to check. Use relay_contracts to see everything you are owed, ` +
    `relay_peers to see whether the seat is alive, and relay_send to ask it directly. If a seat is down, say so and ` +
    `either swap it (\`trantor swap <agent>\`) or reassign the work. If the work is genuinely still running, say that ` +
    `plainly and stop. This check will not block you a second time.`;

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}

  // Loop guard FIRST, before any work: if we already blocked once this stop-cycle, the model has had
  // its chance to deal with the inbox and is entitled to stop.
  if (input.stop_hook_active) return allow();
  if (process.env.RELAY_STOP_INBOX === "0") return allow();

  const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // A Stop IS the turn boundary. If the heartbeat armed a baton while this session was mid-turn,
  // this is the first honest moment to fire it: the turn is complete, so the summary describes
  // finished work rather than a session thirty seconds from its own conclusions. Fired detached and
  // never awaited, and the arming is cleared FIRST so a crash in the worker cannot re-fire it on
  // every subsequent Stop.
  try {
    const armed = readArm(input.session_id || "");
    if (armed) {
      clearArm(input.session_id || "");
      const kid = spawn(process.execPath, [join(HERE, "handoff-now.mjs"),
        armed.projectDir || projectDir, String(input.session_id || ""), armed.transcript || "",
        armed.reason || "context-warn", armed.windowId || "", armed.tty || ""],
        { detached: true, stdio: "ignore" });
      kid.unref();
      // Mark it here, on the path that actually fired, so a session parked above the warn line
      // cannot re-arm and re-fire every tick.
      try { markHandedOff(String(input.session_id || ""), Number(armed.tokens) || 0); } catch {}
      process.stderr.write("[trantor] turn boundary reached — firing the armed baton\n");
    }
  } catch {}
  // Mirror the other hooks: a home-directory session isn't project work and isn't on the bus.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) return allow();

  // Identity resolved EXACTLY as mcp.mjs / heartbeat.mjs / inbox-deliver.mjs do, so we read the same
  // peer's inbox the relay registered.
  const project = resolveProject(projectDir);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);

  // Share inbox-deliver.mjs's cursor: ONE local delivery ledger, so a message injected mid-turn is never
  // re-surfaced here, and vice versa.
  // Same instance id + per-instance cursor as inbox-deliver (docs/INSTANCE-KEYS-CONTRACT.md):
  // T1 and T2 share one ledger within a session; a baton twin gets its own.
  const instanceId = String(input.session_id || "");
  const paths = ledgerPaths(session, instanceId);
  const cursorFile = paths.cursorFile;
  let cursor = 0;
  if (existsSync(cursorFile)) {
    try { cursor = Number(readFileSync(cursorFile, "utf8")) || 0; } catch { return allow(); }
  } else {
    // No cursor yet: no poll has succeeded this session. Anchor to session start (the same ledger
    // inbox-deliver uses) so a message that arrived on this session's watch still blocks the stop,
    // while the backlog from before it never does.
    const startTs = ensureStart(paths);
    try {
      const seed = await signedGet(`/inbox?session=${encodeURIComponent(session)}&since=0&peek=1`, { timeoutMs: FETCH_TIMEOUT_MS, session, instance: instanceId, project });
      if (!seed.ok) return allow();
      cursor = anchorCursor(seed.json?.messages, startTs);
      writeCursor(paths, cursor);
    } catch { return allow(); }
  }

  let messages = [];
  try {
    // PEEK: look without claiming delivery. We may yet decide to let the stop through.
    const peek = await signedGet(`/inbox?session=${encodeURIComponent(session)}&since=${cursor}&peek=1`, { timeoutMs: FETCH_TIMEOUT_MS, session, instance: instanceId, project });
    if (!peek.ok) return allow();
    // Superseded twin (instance-keys contract): a newer instance claimed the baton — this session
    // stands down. Blocking ITS stop over messages the new instance will handle would trap it.
    if (peek.json?.superseded === true) return allow();
    messages = peek.json?.messages || [];
  } catch { return allow(); }        // hub down — never trap the session

  const direct = messages.filter(m => m.to === session);
  if (!direct.length) return stalledContractCheck({ session, project, instanceId });

  // Committed now: claim delivery for real so neither inbox-deliver nor the deferred waker repeats it.
  let next = cursor;
  try {
    const claim = await signedGet(`/inbox?session=${encodeURIComponent(session)}&since=${cursor}`, { timeoutMs: FETCH_TIMEOUT_MS, session, instance: instanceId, project });
    if (claim.ok) next = claim.json?.cursor || cursor;
  } catch {}
  try { writeFileSync(cursorFile, String(next)); } catch {}

  const lines = direct.map(m => `- 📨 from ${sanitize(m.from)}: ${sanitize(m.text)}`).join("\n");
  const reason =
    `You have ${direct.length} unread DIRECT message(s) from another agent session, and you were about to go idle:\n` +
    lines + `\n\n` +
    `Handle them before stopping. If a peer is waiting on you, reply with relay_send (to their session id) ` +
    `and do whatever they need. If it only needs an acknowledgement, send a short one. ` +
    `Then you may stop — this check will not block you a second time.`;

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

main().catch(() => { try { process.stdout.write("{}"); } catch {} process.exit(0); });
