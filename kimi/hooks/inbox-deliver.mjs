#!/usr/bin/env node
// trantor PostToolUse inbox delivery — Kimi Code port. Surfaces bus messages to a BUSY session:
// relay_send only enqueues on the hub; a session grinding through a long tool-use loop never
// chooses to poll. This hook polls /inbox on tool calls (throttled) and prints any NEW peer
// messages on stdout. NOTE: Kimi's PostToolUse is observation-only — whether this stdout reaches
// the model mid-turn is UNVERIFIED. The reliable channels are the relay MCP tools (relay_inbox /
// relay_wait), which the crew playbook's supervise loop already uses. This hook is best-effort on
// top — and it keeps the delivery cursor warm so relay_inbox shows what was auto-surfaced.
// Cheap + fail-silent by contract; first run initialises the cursor to "now" (no backlog replay).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readPayload, payloadCwd, isHomeSession, identity, relayUrl, sanitize, debugHook } from "./lib/common.mjs";

const POLL_MS = Number(process.env.RELAY_INBOX_POLL_MS || 4000);
const FETCH_TIMEOUT_MS = Number(process.env.RELAY_INBOX_TIMEOUT_MS || 1500);

async function getInbox(url, session, since) {
  const r = await fetch(`${url}/inbox?session=${encodeURIComponent(session)}&since=${since}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`hub ${r.status}`);
  return r.json();   // { messages: [...], cursor }
}

async function main(payload) {
  const projectDir = payloadCwd(payload);
  if (isHomeSession(projectDir)) return "";

  const { session } = identity(projectDir);

  const safe = session.replace(/[^A-Za-z0-9_.-]/g, "_");
  const dir = join(homedir(), ".agent-bus");
  const pollStamp = join(dir, `inbox-poll-${safe}.stamp`);
  const cursorFile = join(dir, `inbox-cursor-${safe}.id`);

  // Throttle: poll the hub at most once per POLL_MS (stamp before the network call).
  try {
    if (existsSync(pollStamp)) {
      const last = Number(readFileSync(pollStamp, "utf8")) || 0;
      if (Date.now() - last < POLL_MS) return "";
    }
  } catch {}
  try { writeFileSync(pollStamp, String(Date.now())); } catch {}

  const url = relayUrl();

  // First run: initialise the cursor to "now" and inject NOTHING (no backlog replay).
  if (!existsSync(cursorFile)) {
    try {
      const { cursor } = await getInbox(url, session, 0);
      writeFileSync(cursorFile, String(cursor || 0));
    } catch {}
    return "";
  }

  let cursor = 0;
  try { cursor = Number(readFileSync(cursorFile, "utf8")) || 0; } catch {}

  let messages = [], next = cursor;
  try {
    const res = await getInbox(url, session, cursor);
    messages = Array.isArray(res.messages) ? res.messages : [];
    next = res.cursor || cursor;
  } catch { return ""; }   // hub down / timeout — never block the tool flow

  if (!messages.length) return "";

  // Advance the cursor immediately so we don't re-surface these on the next tool call.
  try { writeFileSync(cursorFile, String(next)); } catch {}

  const lines = messages.map(m => {
    const direct = m.to === session;
    const tag = direct ? "📨 DIRECT" : "📣 broadcast";
    const when = (() => { try { return new Date(m.ts).toLocaleTimeString(); } catch { return ""; } })();
    return `- ${tag} from ${sanitize(m.from)}${when ? ` (${when})` : ""}: ${sanitize(m.text)}`;
  });

  return `<trantor-inbox count="${messages.length}">\n` +
    `📬 ${messages.length} new bus message(s) arrived while you were working (you did not poll for these — Trantor surfaced them automatically):\n` +
    lines.join("\n") + `\n` +
    `If a peer is asking you something or waiting on you, reply now with the relay_send tool (to their session id). ` +
    `If a message just needs an ack, send a short one. You can keep working after responding.\n` +
    `</trantor-inbox>\n`;
}

readPayload()
  .then(p => { debugHook("PostToolUse:inbox", p); return main(p); })
  .then(out => { if (out) { try { process.stdout.write(out); } catch {} } })
  .catch(() => {})
  .finally(() => process.exit(0));
