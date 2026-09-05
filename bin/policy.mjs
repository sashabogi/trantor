#!/usr/bin/env node
// trantor policy — the autonomy ladder's admin surface (PRD §6): show levels + links,
// set a project's level, declare that two projects are codependent.
//   trantor policy show | set <project> <1-4> | link <a> <b> --reason "<why>" | unlink <a> <b>
//   trantor policy check <a> <b>   — exit 0 (prints "yes") if linked or identical, else exit 1 ("no")
// Drafted by scrooge (deepseek-v4-flash), integrated by the orchestrator.
// `check` is what bin/crew.mjs's cross-project guard (#6228) shells out to: the CLI belt needs to
// know whether the operator already linked the two projects before it refuses `trantor up`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";

const BUS_DIR = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
let config;
try { config = JSON.parse(readFileSync(join(BUS_DIR, "config.json"), "utf8")); } catch { config = {}; }

const OWNER = config.ownerIdentity || "admin";
const ownerId = loadOrCreate(OWNER, "human");
const hubs = new Set([config.url || "http://127.0.0.1:4477", ...Object.values(config.hubs || {})]);

const get = async (hub) => {
  const res = await sfetchJson(`${hub}/policy`, { method: "GET", identity: ownerId, signal: AbortSignal.timeout(8000) });
  return res.json();
};
const post = async (hub, payload) => {
  const res = await sfetchJson(`${hub}/policy`, { method: "POST", identity: ownerId, payload, signal: AbortSignal.timeout(8000) });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

const legend = { 1: "1 observe", 2: "2 warn", 3: "3 gate", 4: "4 auto" };
function usage() {
  console.log('usage: trantor policy show | set <project> <1-4> | link <a> <b> --reason "<why>" | unlink <a> <b> | check <a> <b>');
  process.exit(1);
}

const [,, cmd, arg1, arg2] = process.argv;

if (cmd === "show" || !cmd) {
  for (const hub of hubs) {
    try {
      const data = await get(hub);
      console.log(hub);
      console.log("  autonomy:");
      for (const [proj, level] of Object.entries(data.autonomy || {})) console.log(`    ${proj}: ${legend[level] || level}`);
      console.log("  links:");
      for (const l of data.links || []) console.log(`    ${l.projects.join(" ↔ ")} — ${l.reason} (by ${l.declaredBy})`);
      if (!(data.links || []).length) console.log("    (none)");
    } catch (err) { console.warn(`  ⚠ ${hub}: ${err.message}`); }
  }
  process.exit(0);
}

if (cmd === "set") {
  if (!arg1 || !["1", "2", "3", "4"].includes(arg2)) usage();
  for (const hub of hubs) {
    try { await post(hub, { autonomy: { [arg1]: Number(arg2) } }); console.log(`✓ ${arg1} → ${legend[Number(arg2)]} on ${hub}`); }
    catch (err) { console.warn(`⚠ ${hub}: ${err.message}`); }
  }
  process.exit(0);
}

if (cmd === "link") {
  const reasonIdx = process.argv.indexOf("--reason");
  const reason = reasonIdx >= 0 ? process.argv[reasonIdx + 1] : null;
  if (!arg1 || !arg2 || !reason) usage();
  for (const hub of hubs) {
    try { await post(hub, { link: { projects: [arg1, arg2], reason } }); console.log(`✓ ${arg1} ↔ ${arg2} on ${hub}`); }
    catch (err) { console.warn(`⚠ ${hub}: ${err.message}`); }
  }
  process.exit(0);
}

if (cmd === "unlink") {
  if (!arg1 || !arg2) usage();
  for (const hub of hubs) {
    try { await post(hub, { unlink: { projects: [arg1, arg2] } }); console.log(`✓ ${arg1} ↮ ${arg2} on ${hub}`); }
    catch (err) { console.warn(`⚠ ${hub}: ${err.message}`); }
  }
  process.exit(0);
}

if (cmd === "check") {
  if (!arg1 || !arg2) usage();
  if (arg1 === arg2) { console.log("yes"); process.exit(0); }
  let linked = false;
  for (const hub of hubs) {
    try {
      const data = await get(hub);
      if ((data.links || []).some((l) => {
        const ps = (l.projects || []).map((p) => String(p).toLowerCase());
        return ps.includes(arg1.toLowerCase()) && ps.includes(arg2.toLowerCase());
      })) { linked = true; break; }
    } catch { /* unreachable hub: fails closed, not linked */ }
  }
  console.log(linked ? "yes" : "no");
  process.exit(linked ? 0 : 1);
}

usage();
