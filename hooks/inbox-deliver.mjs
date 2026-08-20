#!/usr/bin/env node
// trantor PostToolUse inbox delivery — surface bus messages to a BUSY session.
//
// The bug this fixes: Trantor message delivery is pure pull-on-demand. relay_send only
// enqueues on the hub; the recipient learns of a message ONLY when the model itself
// chooses to call relay_inbox/relay_wait. A session grinding through a long tool-use loop
// never makes that choice, so it sits "online" (the heartbeat keeps lastSeen fresh) but
// DEAF — a peer can ping it twice over 10 minutes and get no reply. (Observed 2026-06-23:
// a new session pinged a mid-build sibling; the sibling never answered because it was busy
// and never polled.)
//
// The fix, hook-side (don't trust the model to poll): a busy session IS firing tool calls,
// so this PostToolUse hook runs constantly. Each run polls /inbox and injects any NEW peer
// messages via hookSpecificOutput.additionalContext — which Claude Code delivers as a
// system reminder the model acts on IN THE SAME TURN, between its own tool calls. So a ping
// lands within a few seconds even mid-build, and the model can reply via relay_send without
// waiting for the human to prompt it.
//
// Cheap + fail-silent by contract: a per-session poll stamp gates the network call, a short
// fetch timeout means we never add real latency, and we ALWAYS exit clean with valid stdout.
// First run initialises the cursor to "now" (current max id) and injects NOTHING, so a
// session is never flooded with the whole backlog of old broadcasts on its first tool call.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId } from "../lib/project.mjs";
import { signedGet } from "./lib/api.mjs";   // signed: enforce hubs 401 unsigned reads — unsigned, T1 delivery is silently dead

const POLL_MS = Number(process.env.RELAY_INBOX_POLL_MS || 4000);
const FETCH_TIMEOUT_MS = Number(process.env.RELAY_INBOX_TIMEOUT_MS || 1500);

// Keep injected text safe to embed in JSON: drop control chars that could corrupt the
// additionalContext payload (the model still gets the readable message).
function sanitize(s) { return String(s == null ? "" : s).replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }

async function getInbox(session, since, instance, project) {
  const { ok, json } = await signedGet(`/inbox?session=${encodeURIComponent(session)}&since=${since}`, { timeoutMs: FETCH_TIMEOUT_MS, session, instance, project });
  if (!ok || !json) throw new Error("hub unreachable");
  return json;   // { messages: [...], cursor, superseded? }
}

// PostToolUse hands us the tool-input JSON on stdin, and we MUST drain it: a large tool input
// (e.g. a big Write) can exceed the 64KB pipe buffer and block the parent's write if nobody reads.
// It used to drain into the void and resolve with NOTHING, so `main(stdinRaw)` always got
// undefined — which silently cost two things: `session_id` (so the per-instance cursor in
// docs/INSTANCE-KEYS-CONTRACT.md never actually keyed by instance) and `cwd` (so this hook could
// only ever guess its project from the process directory). Draining and KEEPING the bytes is the
// same protection, minus the amnesia.
function drainStdin() {
  return new Promise(res => {
    let d = "";
    try {
      process.stdin.setEncoding("utf8"); process.stdin.resume();
      process.stdin.on("data", c => (d += c));
      process.stdin.on("end", () => res(d));
    } catch { res(d); }
    setTimeout(() => res(d), 80);
  });
}

// Self-validating stdout: model-facing additionalContext only when we actually deliver.
function emit(ctx) {
  if (!ctx) return "{}";
  const obj = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } };
  const out = JSON.stringify(obj);
  try { JSON.parse(out); return out; } catch { return "{}"; }
}

async function main(stdinRaw) {
  // The harness session_id is this session's INSTANCE id (docs/INSTANCE-KEYS-CONTRACT.md): it keys
  // the endorsed subkey that signs our reads AND the local cursor, so a baton twin (same durable
  // name, different session_id) has its own ledger and can't eat this session's messages.
  let instanceId = "";
  try { instanceId = String(JSON.parse(stdinRaw || "{}").session_id || ""); } catch {}
  // input.cwd FIRST — every hook must derive the project the SAME way, or two hooks in one
  // session resolve two projects, two hubs, and half the work records where nobody reads.
  let _in = {}; try { _in = JSON.parse(stdinRaw || "{}"); } catch {}
  const projectDir = _in.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Mirror heartbeat.mjs / sessionstart.mjs: a home-directory session isn't project work and
  // isn't on the bus — nothing to deliver. Opt in with RELAY_SESSION / RELAY_PROJECT.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) return "{}";

  // Resolve THIS session's identity EXACTLY as mcp.mjs / heartbeat.mjs do, so we poll the
  // same peer the relay registered (RELAY_SESSION wins; else RELAY_AGENT brand; else host:project).
  const project = resolveProject(projectDir);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);

  const safe = (session + (instanceId ? `@${instanceId.slice(0, 8)}` : "")).replace(/[^A-Za-z0-9_.@-]/g, "_");
  const dir = join(homedir(), ".agent-bus");
  const pollStamp = join(dir, `inbox-poll-${safe}.stamp`);
  const cursorFile = join(dir, `inbox-cursor-${safe}.id`);

  // Throttle: poll the hub at most once per POLL_MS. Write the stamp BEFORE the network call
  // so a burst of parallel tool calls doesn't all fire (and double-deliver).
  try {
    if (existsSync(pollStamp)) {
      const last = Number(readFileSync(pollStamp, "utf8")) || 0;
      if (Date.now() - last < POLL_MS) return "{}";   // within window — skip
    }
  } catch {}
  try { writeFileSync(pollStamp, String(Date.now())); } catch {}

  // First run: no cursor yet. Initialise to the current max deliverable id and inject NOTHING,
  // so we start listening "from now" instead of replaying the whole backlog of old broadcasts.
  if (!existsSync(cursorFile)) {
    try {
      const { cursor } = await getInbox(session, 0, instanceId, project);
      writeFileSync(cursorFile, String(cursor || 0));
    } catch {}
    return "{}";
  }

  let cursor = 0;
  try { cursor = Number(readFileSync(cursorFile, "utf8")) || 0; } catch {}

  let messages = [], next = cursor, superseded = false;
  try {
    const res = await getInbox(session, cursor, instanceId, project);
    messages = Array.isArray(res.messages) ? res.messages : [];
    next = res.cursor || cursor;
    superseded = res.superseded === true;
  } catch { return "{}"; }   // hub down / timeout — never block the tool flow

  // Stand-down note (never a block): a newer instance of this durable identity claimed the baton.
  if (superseded && !messages.length) {
    return emit(`<trantor-inbox count="0">\n⚠️ A newer instance of this session has claimed the baton (instance supersession). Stand down: finish your current thought, do not consume bus messages, and let the new session carry the work.\n</trantor-inbox>\n`);
  }

  if (!messages.length) return "{}";

  // Advance the cursor immediately so we don't re-inject these on the next tool call.
  try { writeFileSync(cursorFile, String(next)); } catch {}

  const lines = messages.map(m => {
    const direct = m.to === session;
    const tag = direct ? "📨 DIRECT" : "📣 broadcast";
    const when = (() => { try { return new Date(m.ts).toLocaleTimeString(); } catch { return ""; } })();
    return `- ${tag} from ${sanitize(m.from)}${when ? ` (${when})` : ""}: ${sanitize(m.text)}`;
  });

  const ctx =
    `<trantor-inbox count="${messages.length}">\n` +
    (superseded ? `⚠️ A newer instance of this session has claimed the baton — stand down after handling anything addressed directly to you; the new session carries the work.\n` : "") +
    `📬 ${messages.length} new bus message(s) arrived while you were working (you did not poll for these — Trantor surfaced them automatically):\n` +
    lines.join("\n") + `\n` +
    `If a peer is asking you something or waiting on you, reply now with the relay_send tool (to their session id). ` +
    `If a message just needs an ack, send a short one. You can keep working after responding.\n` +
    `</trantor-inbox>\n`;

  return emit(ctx);
}

// Never block or break the tool flow: drain stdin, swallow everything, always emit valid stdout.
drainStdin()
  .then(main)
  .then(out => { try { process.stdout.write(out || "{}"); } catch {} })
  .catch(() => { try { process.stdout.write("{}"); } catch {} })
  .finally(() => process.exit(0));
