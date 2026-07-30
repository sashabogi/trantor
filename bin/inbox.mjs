#!/usr/bin/env node
// trantor inbox — read THIS session's bus messages from the terminal, signed.
//
//   trantor inbox              peek at unread (does NOT consume — hooks still deliver them)
//   trantor inbox --all        the full history for this session (peek)
//   trantor inbox --consume    read AND advance the delivery cursor (marks them delivered)
//   trantor inbox --json       raw JSON out
//   trantor inbox --limit N    show at most N messages (default 30)
//
// Born from the 2026-07-30 agent-UX gap: a session asked to "check your messages" had NO way to —
// the MCP tools 401'd on the enforce hub and there was no CLI. Reads here are SIGNED with the same
// session keypair the hooks and MCP server use, so they work under RELAY_AUTH=enforce; the hub's
// scope filtering (own project + direct messages) is the intended behavior, not a limitation.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId, resolveHub } from "../lib/project.mjs";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";

const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const val = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? (argv[i + 1] ?? "") : ""; };

const project = resolveProject(process.cwd());
const session = process.env.RELAY_SESSION
  || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);
const hub = resolveHub(project);
const identity = loadOrCreate(session, "agent");

// Default `since` = the SAME cursor file the delivery hooks keep, so "trantor inbox" means
// "what have my hooks not handed me yet" — not a 2,000-message historical replay.
const safe = session.replace(/[^A-Za-z0-9_.-]/g, "_");
const cursorFile = join(process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), `inbox-cursor-${safe}.id`);
let since = 0;
if (!has("all")) { try { since = Number(readFileSync(cursorFile, "utf8")) || 0; } catch {} }

const peek = !has("consume");
const url = `${hub}/inbox?session=${encodeURIComponent(session)}&since=${since}${peek ? "&peek=1" : ""}`;
let r;
try { r = await sfetchJson(url, { method: "GET", identity, signal: AbortSignal.timeout(8000) }); }
catch (e) { console.error(`hub unreachable at ${hub}: ${e.message}`); process.exit(1); }
if (!r.ok) {
  console.error(`hub ${r.status} on /inbox — ${r.status === 401 ? "this identity isn't enrolled on the hub (RELAY_ENROLL=invite?)" : "read failed"}`);
  process.exit(1);
}
const { messages = [], cursor = since } = await r.json();

if (has("json")) { console.log(JSON.stringify({ session, hub, cursor, messages }, null, 2)); }
else {
  const limit = Math.max(1, Number(val("limit")) || 30);
  const show = messages.slice(-limit);
  console.log(`${session} @ ${hub} — ${messages.length} message(s)${messages.length > show.length ? `, showing last ${show.length}` : ""}${peek ? " (peek)" : ""}`);
  for (const m of show) {
    const when = new Date(m.ts).toLocaleString();
    console.log(`\n#${m.id} ${when}  ${m.from} -> ${m.to}`);
    console.log(`  ${String(m.text || "").split("\n").join("\n  ")}`);
  }
  if (!messages.length) console.log("(inbox empty — you're caught up)");
}

// --consume: the hub's shared delivery ledger already advanced (non-peek read); mirror it into the
// local cursor file so the delivery hooks agree these are handled and don't re-inject them.
if (!peek && cursor > since) { try { writeFileSync(cursorFile, String(cursor)); } catch {} }
