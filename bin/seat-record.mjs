#!/usr/bin/env node
// trantor seat-record [--project p] [--reset <seat>] [--json]
// #7762: the per-project seat record the advisor benches from — derived from board cards +
// card-move events + runner ledgers, never a store of its own. --reset is the manual
// forgiveness path: evidence at or before the stamp stops counting (new completed cards are
// the organic one — they age the bad ones out of the 3-card window).
import { resolveProject } from "../lib/project.mjs";
import { loadSeatRecord, resetSeat, benchedAt, STRIKE, RECORD_LIMIT } from "../lib/seat-record.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const project = opt("--project") || resolveProject(process.cwd());
const reset = opt("--reset");

if (reset) {
  const okReset = resetSeat({ project, seat: reset });
  console.log(okReset
    ? `${reset} reset on ${project} — its earlier cards no longer count toward a bench; new completed cards still age in`
    : `reset FAILED — could not write the resets file`);
  process.exit(okReset ? 0 : 1);
}

const record = await loadSeatRecord({ project });
if (args.includes("--json")) { console.log(JSON.stringify({ project, ...record }, null, 2)); process.exit(0); }

const seats = Object.entries(record.seats);
if (!seats.length) {
  console.log(`no seat record for ${project} yet — it derives from board cards + runner ledgers once seats work cards`);
  process.exit(0);
}
console.log(`seat record for ${project} — last ${RECORD_LIMIT} cards/seat (✓ completed · ∅ empty · ↩ bounced); a seat is benched at a difficulty after ${STRIKE} straight ∅/↩ there:`);
const MARK = { completed: "✓", empty: "∅", bounced: "↩" };
for (const [seat, s] of seats.sort(([a], [b]) => a.localeCompare(b))) {
  const byDiff = {};
  for (const c of s.cards) (byDiff[c.difficulty || "?"] ||= []).push(c);
  const parts = Object.entries(byDiff).sort().map(([d, cs]) => `${d}:${cs.map(c => MARK[c.outcome] || c.outcome).join("")}`);
  const bench = ["easy", "medium", "hard"].filter(d => benchedAt(record, seat, d));
  const wasted = s.wastedTokens ? ` · wasted ≈${(s.wastedTokens / 1e6).toFixed(1)}M tok on ∅/↩` : "";
  const hint = bench.length ? ` · BENCHED at ${bench.join(",")} — the advisor routes those elsewhere (forgive: trantor seat-record --project ${project} --reset ${seat})` : "";
  console.log(`  ${seat.padEnd(12)} ${parts.join("  ")}${wasted}${hint}`);
}
