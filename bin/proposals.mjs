#!/usr/bin/env node
// trantor proposals — the operator's half of agent-proposed permissions (governance).
// Agents file bounded proposals over the bus (relay_propose); THIS is where the human decides.
//   trantor proposals                       pending proposals across your hubs
//   trantor proposals --all                 every proposal, all statuses
//   trantor proposals approve <id> [--note "…"]
//   trantor proposals deny <id> --note "…"       (a denial without a reason teaches nothing)
//   [--hub <url>]                           target one hub when an id exists on several
// Owner-signed: /proposal/decide is owner-gated hub-side — approval is the human's act alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";

const BUS_DIR = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
let config;
try { config = JSON.parse(readFileSync(join(BUS_DIR, "config.json"), "utf8")); } catch { config = {}; }

const ownerId = loadOrCreate(config.ownerIdentity || "admin", "human");
const argv = process.argv.slice(2);
const val = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const hubs = val("hub") ? [val("hub")] : [...new Set([config.url || "http://127.0.0.1:4477", ...Object.values(config.hubs || {})])];

const get = async (hub, path) => {
  const r = await sfetchJson(`${hub}${path}`, { method: "GET", identity: ownerId, signal: AbortSignal.timeout(8000) });
  return r.json();
};
const post = async (hub, path, payload) => {
  const r = await sfetchJson(`${hub}${path}`, { method: "POST", identity: ownerId, payload, signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

const ICON = { pending: "⏳", approved: "✅", denied: "⛔", withdrawn: "↩️" };
const when = (ts) => ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
function show(p, hub) {
  console.log(`  #${p.id} ${ICON[p.status] || ""} ${p.status.toUpperCase()} · ${p.project} · from ${p.session} · ${when(p.ts)}`);
  console.log(`      scope:      ${p.scope}`);
  console.log(`      when:       ${p.condition}`);
  console.log(`      NOT covered: ${p.exclusions}`);
  if (p.status !== "pending") console.log(`      decided ${when(p.decidedTs)} by ${p.decidedBy}${p.note ? ` — "${p.note}"` : ""}`);
}
function usage() {
  console.log('usage: trantor proposals [--all] | approve <id> [--note "…"] | deny <id> --note "…"  [--hub <url>]');
  process.exit(1);
}

const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "list";

if (cmd === "list") {
  let shown = 0;
  for (const hub of hubs) {
    try {
      const q = argv.includes("--all") ? "" : "?status=pending";
      const { proposals } = await get(hub, `/proposals${q}`);
      if (!proposals?.length) continue;
      console.log(hub);
      for (const p of proposals) { show(p, hub); shown++; }
    } catch (err) { console.warn(`  ⚠ ${hub}: ${err.message}`); }
  }
  if (!shown) console.log(argv.includes("--all") ? "no proposals on any hub" : "no pending proposals — nothing waiting on you");
  else if (!argv.includes("--all")) console.log(`\ndecide with: trantor proposals approve <id> [--note "…"]  ·  trantor proposals deny <id> --note "…"`);
  process.exit(0);
}

if (cmd === "approve" || cmd === "deny") {
  const id = Number(argv[1]);
  if (!Number.isInteger(id) || id <= 0) usage();
  const note = val("note");
  if (cmd === "deny" && !note) { console.error('a denial needs a reason: deny <id> --note "why" — the note is what stops the agent re-proposing blind'); process.exit(1); }
  // an id is only unique per hub — find where THIS pending proposal lives before deciding
  const holding = [];
  for (const hub of hubs) {
    try {
      const { proposals } = await get(hub, "/proposals?status=pending");
      if (proposals?.some(p => p.id === id)) holding.push(hub);
    } catch {}
  }
  if (!holding.length) { console.error(`no PENDING proposal #${id} on ${hubs.length > 1 ? "any of your hubs" : hubs[0]}`); process.exit(1); }
  if (holding.length > 1) { console.error(`proposal #${id} is pending on several hubs (${holding.join(", ")}) — pick one with --hub <url>`); process.exit(1); }
  try {
    // `by` is the warn-mode fallback only — under enforce the hub stamps the SIGNER's name over it
    const { proposal } = await post(holding[0], "/proposal/decide", { id, status: cmd === "approve" ? "approved" : "denied", note, by: ownerId.name || "owner" });
    console.log(`${ICON[proposal.status]} #${proposal.id} ${proposal.status} on ${holding[0]} — the proposer (${proposal.session}) has been told over the bus`);
  } catch (err) { console.error(`⚠ ${holding[0]}: ${err.message}`); process.exit(1); }
  process.exit(0);
}

usage();
