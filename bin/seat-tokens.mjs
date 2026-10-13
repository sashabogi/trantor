#!/usr/bin/env node
// trantor seat-tokens (#11559) — per-provider token totals for the seat fleet from opencode's
// session store, the 30-day shape compared week over week: sessions, assistant steps, tokens,
// the single biggest step, and cost. Read-only; a missing or locked DB prints "no data".
//   node bin/seat-tokens.mjs [--days 30] [--db <path>] [--json]
import { homedir } from "node:os";
import { join } from "node:path";
import { seatTokensReport } from "../lib/seat-tokens.mjs";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DAYS = Math.max(1, Number(val("--days", 30)) || 30);
const DB = val("--db", join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db"));
const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;
const rows = seatTokensReport({ dbPath: DB, sinceMs: since });
const fmt = (n) => Number(n).toLocaleString("en-US");

if (val("--json", "")) { console.log(JSON.stringify({ db: DB, days: DAYS, providers: rows }, null, 1)); process.exit(0); }
if (!rows.length) { console.log(`no session data in ${DB} for the last ${DAYS} day(s)`); process.exit(0); }
console.log(`opencode seat usage, last ${DAYS} day(s) — ${DB}\n`);
console.log("provider            sessions   steps  input        output     cache-read     cache-write  peak-step     cost");
for (const r of rows) {
  console.log(
    String(r.provider).padEnd(18),
    String(r.sessions).padStart(8),
    String(r.steps).padStart(8),
    fmt(r.input).padStart(12),
    fmt(r.output).padStart(10),
    fmt(r.cacheRead).padStart(14),
    fmt(r.cacheWrite).padStart(14),
    fmt(r.peakInput).padStart(12),
    fmt(Math.round(r.cost)).padStart(6),
  );
}
