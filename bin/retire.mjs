#!/usr/bin/env node
// `trantor retire` — retire orchestrator panes that nothing is using (#8017). Previews by default;
// --yes performs it. Liveness, never age alone, decides: a pane mid-turn or holding an in-flight
// contract is held open whatever its idle age.
import { execFileSync } from "node:child_process";
import { turnInFlight, buildSummary, writeHandoff, sessionProcessState } from "../hooks/lib/handoff.mjs";
import { hostId, resolveHub } from "../lib/project.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";
import {
  retireHours, retireEnabled, collectPanes, retireDecision, retirePane,
  isRetired, humanHours, retiredLedgerPath,
} from "../lib/retire-panes.mjs";

const D = "\x1b[2m", B = "\x1b[1m", Y = "\x1b[33m", G = "\x1b[32m", R = "\x1b[0m";
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes("--yes");
const JSON_OUT = args.includes("--json");

const hours = flag("--hours") !== null ? Number(flag("--hours")) : retireHours();
if (!retireEnabled(hours)) {
  console.log(`retirement disabled (threshold ${hours}h) — set TRANTOR_PANE_RETIRE_HOURS or config.paneRetireHours`);
  process.exit(0);
}

const host = hostId();
// Fail CLOSED on the hub: a contract count we could not read must never be taken as zero, or an
// unreachable hub would retire a pane that is holding work.
async function contractsFor(session) {
  try {
    const res = await sfetchJson(`${resolveHub("")}/contracts?session=${encodeURIComponent(session)}`,
      { method: "GET", name: session });
    if (!res.ok) return 1;
    return Number((await res.json())?.open) || 0;
  } catch { return 1; }
}

const panes = collectPanes({ turnInFlight, sessionProcessState, hostId: host }).filter(p => !isRetired(p.sid));
for (const p of panes) p.openContracts = await contractsFor(`${host}:${p.project}`);
const decided = panes.map(p => retireDecision(p, { hours }));
const due = decided.filter(d => d.retire);

if (JSON_OUT) {
  console.log(JSON.stringify({ hours, applied: APPLY, panes: decided }, null, 2));
}

if (!JSON_OUT) {
  console.log(`${B}retire${R} ${D}· threshold ${hours}h · ledger ${retiredLedgerPath()}${R}`);
  for (const d of decided) {
    const mark = d.retire ? `${Y}retire${R}` : `${G}hold  ${R}`;
    const age = d.idleMs === null ? "?" : humanHours(d.idleMs);
    console.log(`  ${mark} ${d.project.padEnd(18)} ${D}idle ${age.padEnd(7)} ${d.reason}${R}`);
  }
  if (!decided.length) console.log(`  ${D}no orchestrator panes in the session map${R}`);
}

if (!due.length) process.exit(0);
if (!APPLY) {
  if (!JSON_OUT) console.log(`\n${D}preview only — rerun with --yes to retire ${due.length} pane(s)${R}`);
  process.exit(0);
}

for (const d of due) {
  const out = await retirePane(d, { by: `retire@${host}`, exec: execFileSync, writeHandoff, buildSummary });
  console.log(`  ${G}retired${R} ${d.project} ${D}${out.steps.join(" · ")}${R}`);
  console.log(`    ${D}resume the thread with: claude --resume ${d.sid}${R}`);
}
