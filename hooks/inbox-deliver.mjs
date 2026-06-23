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

const POLL_MS = Number(process.env.RELAY_INBOX_POLL_MS || 4000);
const FETCH_TIMEOUT_MS = Number(process.env.RELAY_INBOX_TIMEOUT_MS || 1500);

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    if (existsSync(cfg)) { const u = JSON.parse(readFileSync(cfg, "utf8")).url; if (u) return u; }
  } catch {}
  return "http://127.0.0.1:4477";
}

// Keep injected text safe to embed in JSON: drop control chars that could corrupt the
// additionalContext payload (the model still gets the readable message).
function sanitize(s) { return String(s == null ? "" : s).replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }

async function getInbox(url, session, since) {
  const r = await fetch(`${url}/inbox?session=${encodeURIComponent(session)}&since=${since}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`hub ${r.status}`);
  return r.json();   // { messages: [...], cursor }
}

// PostToolUse hands us the tool-input JSON on stdin. We don't need it, but we must DRAIN it:
// a large tool input (e.g. a big Write) can exceed the 64KB pipe buffer and block the parent's
// write if nobody reads. Consume + discard, with a short timeout so we never hang.
function drainStdin() {
  return new Promise(res => {
    try { process.stdin.resume(); process.stdin.on("data", () => {}); process.stdin.on("end", res); }
    catch { res(); }
    setTimeout(res, 80);
  });
}

// Self-validating stdout: model-facing additionalContext only when we actually deliver.
function emit(ctx) {
  if (!ctx) return "{}";
  const obj = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } };
  const out = JSON.stringify(obj);
  try { JSON.parse(out); return out; } catch { return "{}"; }
}

async function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Mirror heartbeat.mjs / sessionstart.mjs: a home-directory session isn't project work and
  // isn't on the bus — nothing to deliver. Opt in with RELAY_SESSION / RELAY_PROJECT.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) return "{}";

  // Resolve THIS session's identity EXACTLY as mcp.mjs / heartbeat.mjs do, so we poll the
  // same peer the relay registered (RELAY_SESSION wins; else RELAY_AGENT brand; else host:project).
  const project = resolveProject(projectDir);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);

  const safe = session.replace(/[^A-Za-z0-9_.-]/g, "_");
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

  const url = relayUrl();

  // First run: no cursor yet. Initialise to the current max deliverable id and inject NOTHING,
  // so we start listening "from now" instead of replaying the whole backlog of old broadcasts.
  if (!existsSync(cursorFile)) {
    try {
      const { cursor } = await getInbox(url, session, 0);
      writeFileSync(cursorFile, String(cursor || 0));
    } catch {}
    return "{}";
  }

  let cursor = 0;
  try { cursor = Number(readFileSync(cursorFile, "utf8")) || 0; } catch {}

  let messages = [], next = cursor;
  try {
    const res = await getInbox(url, session, cursor);
    messages = Array.isArray(res.messages) ? res.messages : [];
    next = res.cursor || cursor;
  } catch { return "{}"; }   // hub down / timeout — never block the tool flow

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
