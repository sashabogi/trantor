#!/usr/bin/env node
// `trantor sync [<seat>]` (#7748): realign a seat branch with main from the harvest receipts.
// Every commit main lacks must carry a receipt; otherwise the sync refuses and names them.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProject, busDir } from "../lib/project.mjs";
import { syncSeat, receiptsPath } from "../lib/harvest.mjs";

const D = "\x1b[2m", G = "\x1b[32m", Y = "\x1b[33m", RED = "\x1b[31m", R = "\x1b[0m";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : ""; };
const seat = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--project"));
if (args.includes("--help")) {
  console.log("usage: trantor sync [<seat>] [--project <p>] [--dry-run] [--no-fetch]   (no seat: the worktree you are in)");
  process.exit(0);
}

const project = flag("project") || resolveProject(process.cwd());
const dir = seat ? join(busDir(), "worktrees", project, seat) : process.cwd();
if (seat && !existsSync(join(dir, ".git"))) {
  console.error(`sync: no worktree for seat '${seat}' at ${dir}`);
  process.exit(1);
}

const r = syncSeat(dir, { dryRun: args.includes("--dry-run"), fetch: !args.includes("--no-fetch"), project });
const short = (s) => String(s || "").slice(0, 7);
if (r.refused) {
  console.log(`${RED}sync refused${R} · ${r.branch} carries ${r.unharvested.length} commit(s) ${r.target.ref} does not, with no harvest receipt:`);
  for (const c of r.unharvested) console.log(`  ${short(c.sha)}  ${c.subject}`);
  if (r.harvested.length) console.log(`${D}${r.harvested.length} other commit(s) are receipted and would be dropped once these are.${R}`);
  console.log(`${D}Harvest them (trantor harvest <seat-sha> <main-sha> --card N) or park them on another branch first. Receipts: ${receiptsPath(project)}${R}`);
  process.exit(1);
}
if (!r.ok) { console.error(`${RED}sync failed${R}: ${r.reason}`); process.exit(1); }
if (r.noop) { console.log(`${D}${r.branch} already at ${r.target.ref} (${short(r.head)})${R}`); process.exit(0); }
const dropped = r.harvested.map(c => `${short(c.sha)}→${short(c.receipt.main)}`).join(", ");
if (r.dry) {
  console.log(`${Y}[dry]${R} would move ${r.branch} ${short(r.head)} → ${r.target.ref} ${short(r.target.sha)}${dropped ? ` ${D}(receipted: ${dropped})${R}` : ""}`);
  process.exit(0);
}
console.log(`${G}synced${R} ${r.branch} ${short(r.from)} → ${r.target.ref} ${short(r.to)}${dropped ? ` ${D}(receipted: ${dropped})${R}` : ""}`);
