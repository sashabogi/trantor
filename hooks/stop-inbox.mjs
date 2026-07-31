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
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId } from "../lib/project.mjs";
import { signedGet } from "./lib/api.mjs";   // signed: enforce hubs 401 unsigned reads — unsigned, T2 delivery is silently dead

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

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}

  // Loop guard FIRST, before any work: if we already blocked once this stop-cycle, the model has had
  // its chance to deal with the inbox and is entitled to stop.
  if (input.stop_hook_active) return allow();
  if (process.env.RELAY_STOP_INBOX === "0") return allow();

  const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Mirror the other hooks: a home-directory session isn't project work and isn't on the bus.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) return allow();

  // Identity resolved EXACTLY as mcp.mjs / heartbeat.mjs / inbox-deliver.mjs do, so we read the same
  // peer's inbox the relay registered.
  const project = resolveProject(projectDir);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);

  // Share inbox-deliver.mjs's cursor: ONE local delivery ledger, so a message injected mid-turn is never
  // re-surfaced here, and vice versa.
  const safe = session.replace(/[^A-Za-z0-9_.-]/g, "_");
  const cursorFile = join(homedir(), ".agent-bus", `inbox-cursor-${safe}.id`);
  // No cursor yet means inbox-deliver has never run for this session; it initialises to "now" on its
  // first tool call. Blocking on the whole backlog of old messages would be a terrible first impression.
  if (!existsSync(cursorFile)) return allow();

  let cursor = 0;
  try { cursor = Number(readFileSync(cursorFile, "utf8")) || 0; } catch { return allow(); }

  let messages = [];
  try {
    // PEEK: look without claiming delivery. We may yet decide to let the stop through.
    const peek = await signedGet(`/inbox?session=${encodeURIComponent(session)}&since=${cursor}&peek=1`, { timeoutMs: FETCH_TIMEOUT_MS, session });
    if (!peek.ok) return allow();
    messages = peek.json?.messages || [];
  } catch { return allow(); }        // hub down — never trap the session

  const direct = messages.filter(m => m.to === session);
  if (!direct.length) return allow();

  // Committed now: claim delivery for real so neither inbox-deliver nor the deferred waker repeats it.
  let next = cursor;
  try {
    const claim = await signedGet(`/inbox?session=${encodeURIComponent(session)}&since=${cursor}`, { timeoutMs: FETCH_TIMEOUT_MS, session });
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
