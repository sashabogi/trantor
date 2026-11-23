#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
let since = "1h";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--since" && args[i + 1]) since = args[++i];
  else { console.error("usage: trantor hub timeouts [--since 1h]"); process.exit(2); }
}
const match = since.match(/^(\d+)(m|h|d)$/);
if (!match) { console.error("--since must be a duration such as 30m, 1h, or 2d"); process.exit(2); }
const amount = Number(match[1]);
const ageMs = amount * ({ m: 60_000, h: 3_600_000, d: 86_400_000 })[match[2]];
const cutoff = Date.now() - ageMs;
const sinceArg = `${amount} ${match[2] === "m" ? "minute" : match[2] === "h" ? "hour" : "day"}${amount === 1 ? "" : "s"} ago`;
const busDir = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
const receiptFile = process.env.TRANTOR_HUB_TIMEOUTS_FILE || join(busDir, "hub-timeouts.jsonl");
let receipts = [];
if (existsSync(receiptFile)) {
  receipts = readFileSync(receiptFile, "utf8").split("\n").filter(Boolean).flatMap(line => {
    try {
      const row = JSON.parse(line);
      return Date.parse(row.ts) >= cutoff ? [{ time: Date.parse(row.ts), kind: "client timeout", text: `${row.route} op=${row.op} elapsed=${row.elapsedMs}ms hub=${row.hubUrl}` }] : [];
    } catch { return []; }
  });
}

let journal = "";
const remote = process.env.TRANTOR_HUB_SSH;
if (process.env.TRANTOR_HUB_JOURNAL_FILE) {
  journal = readFileSync(process.env.TRANTOR_HUB_JOURNAL_FILE, "utf8");
} else {
  const command = ["journalctl", "-u", "trantor-hub", "--since", sinceArg, "--output=short-iso", "--no-pager"];
  try {
    journal = remote
      ? execFileSync("ssh", [remote, "journalctl", "-u", "trantor-hub", "--since", sinceArg, "--output=short-iso", "--no-pager"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      : execFileSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { journal = ""; }
}
const journalRows = journal.split("\n").filter(line => /\[trantor\] (event-loop stall|slow request)/.test(line)).flatMap(line => {
  const iso = line.match(/^(\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?)/)?.[1];
  const time = Date.parse(iso || "");
  return Number.isFinite(time) && time >= cutoff ? [{ time, kind: "hub", text: line }] : [];
});
const rows = [...receipts, ...journalRows].sort((a, b) => a.time - b.time);
console.log(`Hub diagnostics for the last ${since}${remote ? ` (journal via ssh ${remote})` : " (local journal only; set TRANTOR_HUB_SSH to include the remote hub journal)"}`);
if (!rows.length) console.log("No matching hub timeouts, event-loop stalls, or slow requests in this window.");
for (const row of rows) console.log(`${new Date(row.time).toISOString()} [${row.kind}] ${row.text}`);
