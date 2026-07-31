#!/usr/bin/env node
// trantor recost — recompute Claude Code sub-agent NOTIONAL cost from on-disk transcripts and reseed the
// board, replacing stale/contaminated cc-subagent cards (e.g. after the v0.17.37 transcript-resolution
// fix). Honest by construction: only transcripts still on disk are counted, and mis-resolved/implausible
// ones are guarded out. Run it once after upgrading; new sub-agents accrue correctly via the fixed hook.
//
// Usage: trantor recost [--dry-run] [--json]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { scanSubagentCosts } from "../lib/subagent-scan.mjs";

// Signed via the shared client (2026-07-31, agent-UX audit): unsigned POST rejected under enforce.
import { relayUrl, signedPost } from "../hooks/lib/api.mjs";

const dry = process.argv.includes("--dry-run");
const asJson = process.argv.includes("--json");
const byProject = scanSubagentCosts();

// flatten to one entry list (each tagged with its raw project) — the hub canon-merges alias lanes
const allEntries = [];
for (const [project, entries] of byProject) for (const e of entries) allEntries.push({ ...e, project });
const scanTotal = allEntries.reduce((s, e) => s + (e.costUsd || 0), 0);

if (dry) {
  const rows = [...byProject.entries()].map(([project, entries]) => ({ project, cards: entries.length, invocations: entries.reduce((s, e) => s + e.count, 0), usd: +entries.reduce((s, e) => s + (e.costUsd || 0), 0).toFixed(2) })).sort((a, b) => b.usd - a.usd);
  if (asJson) { console.log(JSON.stringify({ dry: true, scanTotal: +scanTotal.toFixed(2), byScannedProject: rows }, null, 2)); process.exit(0); }
  console.log("[dry-run] Sub-agent notional recomputed from on-disk transcripts (pre-canonicalization):\n");
  for (const r of rows) console.log(`  ${r.project.padEnd(24)} ${String(r.cards).padStart(3)} cards · ${String(r.invocations).padStart(4)} inv · $${r.usd.toFixed(2)}`);
  console.log(`\n[dry-run] scanned total $${scanTotal.toFixed(2)} (drop --dry-run to reseed; only on-board project lanes are kept)`);
  process.exit(0);
}

let result;
{
  const r = await signedPost("/subagent-recost", { entries: allEntries }, { timeoutMs: 15000 });
  if (!r.ok) { console.error(`recost failed: hub ${r.status} at ${relayUrl()}`); process.exit(1); }
  result = r.json;
}

const projs = (result?.projects || []);
const seeded = projs.filter(p => !p.skipped);
const skipped = projs.filter(p => p.skipped);
const seededUsd = seeded.reduce((s, p) => s + (p.usd || 0), 0);

if (asJson) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
console.log("Sub-agent notional reseeded from on-disk transcripts (canonical project lanes):\n");
for (const p of seeded.sort((a, b) => (b.usd || 0) - (a.usd || 0))) console.log(`  ${p.project.padEnd(24)} ${String(p.added).padStart(3)} cards · $${(p.usd || 0).toFixed(2)}  ✓`);
console.log(`\nSEEDED: $${seededUsd.toFixed(2)} notional · ${result.added} cards across ${seeded.length} project lanes → on the board`);
if (skipped.length) console.log(`skipped ${skipped.length} non-board context(s) (worktrees / non-project dirs) — not real Trantor lanes.`);
