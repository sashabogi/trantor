#!/usr/bin/env node
// trantor gates [--all] [--json] — verification gates for THIS project: structured "must verify
// before shipping" claims that survive handoffs and surface to whoever takes over. Open by default;
// --all includes resolved ones. Set/resolve gates from inside a session via the relay_verify_gate tool.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject } from "../lib/project.mjs";

const args = process.argv.slice(2);
const all = args.includes("--all");
const asJson = args.includes("--json");

// Signed read via the shared client (2026-07-31, agent-UX audit): the hand-rolled relayUrl here
// missed the per-project hubs map AND sent unsigned (401 under enforce). relayUrl/signedGet from
// hooks/lib/api.mjs resolve the cwd project's hub and sign as this session.
import { relayUrl, signedGet } from "../hooks/lib/api.mjs";

const project = resolveProject(process.cwd());
let gates = [];
{
  const r = await signedGet(`/verify-gates?project=${encodeURIComponent(project)}${all ? "&all=1" : ""}`, { timeoutMs: 2500 });
  if (!r.ok) {
    console.error(`could not reach the hub at ${relayUrl(project)} (status ${r.status}) — is it running? (trantor setup / trantor hub)`);
    process.exit(1);
  }
  gates = r.json?.gates || [];
}

if (asJson) { process.stdout.write(JSON.stringify(gates, null, 2) + "\n"); process.exit(0); }
if (!gates.length) { console.log(`${project}: no ${all ? "" : "open "}verification gates`); process.exit(0); }

console.log(`${project} — ${gates.length} ${all ? "" : "open "}verification gate(s):`);
for (const g of gates) {
  const badge = g.status === "open" ? "⚠️ OPEN" : `✓ ${g.status}`;
  console.log(`\n#${g.id}  ${badge}  ${g.claim}`);
  if (g.why) console.log(`    why: ${g.why}`);
  if (g.howToVerify) console.log(`    how: ${g.howToVerify}`);
  if (g.status !== "open" && g.resolvedNote) console.log(`    resolved: ${g.resolvedNote}`);
}
