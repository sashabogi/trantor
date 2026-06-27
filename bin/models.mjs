#!/usr/bin/env node
// trantor models — browse the live models behind your crew seats (opencode is the adapter).
//
//   trantor models                # every opencode-driven seat + how many live models it serves
//   trantor models <provider>     # list that provider's live models + what the router picks per
//                                 # difficulty (so you can see hard→strong, easy→cheap at a glance)
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildRoster, loadWorld } from "./advise.mjs";

const H = homedir();
const C = { dim: "\x1b[2m", grn: "\x1b[32m", gold: "\x1b[38;5;208m", off: "\x1b[0m" };
const has = (c) => { try { execSync(`command -v ${c}`, { stdio: "ignore", shell: "/bin/sh" }); return true; } catch { return false; } };
const SCROOGE = (() => {
  const bundled = join(dirname(dirname(fileURLToPath(import.meta.url))), "engine", "bin", "scrooge");
  if (existsSync(bundled)) return bundled;
  try { return execSync("command -v scrooge", { encoding: "utf8" }).trim(); } catch { return "scrooge"; }
})();

const liveModels = (providerOc) => {
  try { return execSync(`opencode models ${providerOc} 2>/dev/null`, { encoding: "utf8" }).split("\n").filter(Boolean); }
  catch { return []; }
};

function routePick(candList, diff) {
  try {
    const out = execSync(`python3 ${SCROOGE} route --candidates ${JSON.stringify(candList.join(" "))} -t code -d ${diff} --json 2>/dev/null`, { encoding: "utf8" });
    return JSON.parse(out).qualified || "?";
  } catch { return "?"; }
}

function listAll() {
  const { roster, agents } = loadWorld();
  if (!has("opencode")) { console.log("opencode not on PATH — it's the adapter that serves crew models. Install it, then re-run."); return; }
  console.log("CREW MODELS — opencode-driven seats (● available now)\n");
  for (const [label, s] of Object.entries(roster)) {
    if (s.cli !== "opencode") continue;
    const n = liveModels(s.providerOc).length;
    const dot = agents.includes(label) ? `${C.grn}●${C.off}` : `${C.dim}○${C.off}`;
    console.log(`  ${dot} ${label.padEnd(14)} ${C.dim}${s.providerOc}${C.off}  ${n} live models   ${C.dim}trantor models ${label}${C.off}`);
  }
  console.log(`\n${C.dim}detail + routing preview:${C.off} trantor models <provider>`);
}

function detail(name) {
  const { roster } = loadWorld();
  const seat = roster[name] || Object.values(roster).find(s => s.providerOc === name);
  const providerOc = seat?.providerOc || name;
  const models = liveModels(providerOc);
  if (!models.length) { console.log(`No live models for '${providerOc}' (opencode offline / no key / unknown provider).`); return; }
  console.log(`${C.gold}${providerOc}${C.off} — ${models.length} live models\n`);
  for (const m of models.slice(0, 60)) console.log(`  ${m}`);
  if (models.length > 60) console.log(`  ${C.dim}… +${models.length - 60} more${C.off}`);
  if (existsSync(SCROOGE) || has("scrooge")) {
    console.log(`\n${C.gold}router picks (code task):${C.off}`);
    for (const d of ["easy", "medium", "hard"]) console.log(`  ${d.padEnd(7)} → ${routePick(models, d)}`);
    console.log(`${C.dim}(run scrooge-capabilities to (re)score the catalog for accurate difficulty routing)${C.off}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (!arg) listAll(); else detail(arg.toLowerCase());
}
