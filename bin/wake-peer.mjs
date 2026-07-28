#!/usr/bin/env node
// trantor — the deferred waker. Spawned DETACHED by relay_send when a session sends a DIRECT message,
// this waits out the in-session delivery paths and, only if none of them got there, types the message
// into the recipient's terminal so an idle agent wakes up on its own.
//
//   node bin/wake-peer.mjs <recipientSession> <msgId> [hubUrl]
//
// WHY DETACHED, AND WHY FROM THE SENDER
// The hub cannot do this. It runs under launchd and macOS TCC blocks a background job from driving
// Terminal — `osascript -e 'tell application "Terminal" …'` from that context hangs with no output and no
// exit code (verified 2026-07-28). Only a descendant of the user's terminal session holds the Automation
// permission. The sender IS such a session, and a detached+unref'd child keeps the permission even after
// its parent exits — which matters, because the classic case is agent A messaging "I'm done" and then
// going idle itself. The waker has to outlive the session that spawned it.
//
// FIRST REFUSAL
// Typing into somebody's prompt is intrusive, so it is the LAST resort, never the first. We sleep, then
// ask the hub whether the recipient has been handed this message by any other path (relay_inbox polling,
// or hooks/inbox-deliver.mjs injecting mid-turn). Only if the delivery ledger is still behind do we type.
// A busy session almost always self-serves inside the delay and this process exits having done nothing.
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { wakePane, formatWakeText, isDarwin } from "../lib/wake.mjs";

const DELAY_MS = Number(process.env.RELAY_WAKE_DELAY_MS || 20000);
const TIMEOUT_MS = 2500;

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    if (existsSync(cfg)) { const u = JSON.parse(readFileSync(cfg, "utf8")).url; if (u) return u; }
  } catch {}
  return "http://127.0.0.1:4477";
}

// Opt-in debugging: this process is detached and silent by design, so there is otherwise no way to see
// why a wake did or didn't happen. RELAY_WAKE_DEBUG=1 -> ~/.agent-bus/wake.log
function log(line) {
  if (!process.env.RELAY_WAKE_DEBUG) return;
  try { appendFileSync(join(homedir(), ".agent-bus", "wake.log"), `${new Date().toISOString()} ${line}\n`); } catch {}
}

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`hub ${r.status}`);
  return r.json();
}

async function main() {
  const [, , to, msgIdRaw, urlArg] = process.argv;
  const msgId = Number(msgIdRaw || 0);
  if (!to || !msgId) { log(`bad args to=${to} msgId=${msgIdRaw}`); return; }
  if (process.env.RELAY_WAKE === "0") { log(`disabled by RELAY_WAKE=0`); return; }
  if (!isDarwin()) { log(`not darwin — no transport`); return; }

  const url = urlArg || relayUrl();
  await sleep(DELAY_MS);

  let peer;
  try { peer = await get(`${url}/peer?session=${encodeURIComponent(to)}`); }
  catch (e) { log(`peer lookup failed for ${to}: ${e.message}`); return; }

  // Already handed over by relay_inbox or the PostToolUse injector — nothing to do. This is the common
  // path for a session that was merely busy rather than idle.
  if ((peer.deliveredUpTo || 0) >= msgId) { log(`#${msgId} -> ${to}: already delivered (ledger ${peer.deliveredUpTo}) — no wake`); return; }

  const { tty, windowId, host } = peer.pane || {};
  if (!windowId || !tty) { log(`#${msgId} -> ${to}: no pane address (session predates wake support, or not a Terminal session)`); return; }

  // Never try to type into another machine's terminal. Pane addresses are only meaningful on the host that
  // recorded them; on a shared/teams hub a peer can legitimately live somewhere else.
  const me = process.env.RELAY_WAKE_HOST || (await import("../lib/project.mjs")).hostId();
  if (host && host !== me) { log(`#${msgId} -> ${to}: peer on host ${host}, we are ${me} — not ours to wake`); return; }

  // Fetch the message text. Read as the RECIPIENT so the hub's own deliverable() decides what they may
  // see — we never hand a session something it wasn't entitled to.
  let msg;
  try {
    const box = await get(`${url}/inbox?session=${encodeURIComponent(to)}&since=${msgId - 1}`);
    msg = (box.messages || []).find(m => m.id === msgId);
  } catch (e) { log(`#${msgId} -> ${to}: inbox read failed: ${e.message}`); return; }
  if (!msg) { log(`#${msgId} -> ${to}: message not found/not deliverable`); return; }

  // NOTE: that /inbox read just advanced the recipient's delivery ledger past this message, which is
  // correct — we are about to deliver it — and it also means a second waker racing on the same message
  // will see it as delivered and stand down.
  const res = wakePane({ windowId, tty, text: formatWakeText(msg.from, msg.text, msg.id) });
  log(`#${msgId} -> ${to}: wake ${res.ok ? "OK" : "FAILED (" + res.reason + ")"} window=${windowId} tty=${tty}`);
}

main().catch(e => log(`fatal: ${e && e.message}`)).finally(() => process.exit(0));
