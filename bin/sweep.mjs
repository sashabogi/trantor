#!/usr/bin/env node
// trantor sweep — clear stuck IN-PROGRESS cards. The automatic hub reaper only stales cards whose OWNER is
// OFFLINE (safe: it never touches live work). `trantor sweep` is the explicit "a live seat forgot its card"
// broom: it moves EVERY doing/testing card idle past --older (default 30m) to the Stale lane. It PREVIEWS
// first and changes NOTHING until you re-run with --yes.
//   trantor sweep                 # preview this project's stuck cards
//   trantor sweep --yes           # actually move them to Stale
//   trantor sweep --older 2h      # widen/narrow the idle threshold (ms|s|m|h|d, default 30m)
//   trantor sweep --all-projects  # every board, not just this one
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject } from "../lib/project.mjs";

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const c = join(homedir(), ".agent-bus", "config.json"); if (existsSync(c)) { const u = JSON.parse(readFileSync(c, "utf8")).url; if (u) return u; } } catch {}
  return "http://127.0.0.1:4477";
}
function parseDur(s, def) {
  if (!s) return def;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return def;
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || "m").toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}
const fmtAge = ms => { const m = Math.round(ms / 60000); return m >= 1440 ? `${Math.floor(m / 1440)}d` : m >= 90 ? `${Math.floor(m / 60)}h` : `${m}m`; };

const argv = process.argv.slice(2);
const has = (...f) => f.some(x => argv.includes(x));
const val = (...f) => { for (const x of f) { const i = argv.indexOf(x); if (i >= 0) return argv[i + 1]; } return undefined; };
const olderMs = parseDur(val("--older", "-o"), 30 * 60 * 1000);
const doIt = has("--yes", "-y");
const allProjects = has("--all-projects", "--all");
const project = allProjects ? null : resolveProject(process.cwd());
const url = relayUrl();

async function sweep(dryRun) {
  const body = { olderMs, dryRun, by: "cli-sweep" };
  if (project) body.project = project;
  const r = await fetch(`${url}/sweep`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  return r.json();
}

try {
  const scope = project ? `project "${project}"` : "ALL projects";
  const pre = await sweep(true);
  const cand = pre.candidates || [];
  console.log(`\n🧹 trantor sweep — ${scope} · idle > ${fmtAge(olderMs)}\n${"─".repeat(52)}`);
  if (!cand.length) { console.log("  nothing stuck — every in-progress card is fresh or owned-live.\n"); process.exit(0); }
  for (const c of cand) console.log(`  #${c.id} [${c.status}] ${String(c.title).slice(0, 58)}  · ${c.assignee || "?"} · idle ${fmtAge(c.ageMs)}${allProjects ? ` · ${c.project}` : ""}`);
  if (!doIt) {
    console.log(`\n  ${cand.length} card(s) would move to the Stale lane. Re-run to confirm:`);
    console.log(`    trantor sweep${allProjects ? " --all-projects" : ""}${val("--older", "-o") ? ` --older ${val("--older", "-o")}` : ""} --yes\n`);
    process.exit(0);
  }
  const res = await sweep(false);
  console.log(`\n  ✓ swept ${res.swept} card(s) → Stale. Triage on the board (click a stale card to re-queue, or move it to Done).\n`);
} catch (e) {
  console.error(`could not reach hub at ${url}: ${e.message}`);
  process.exit(1);
}
