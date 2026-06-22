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

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const u = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")).url; if (u) return u; } catch {}
  return "http://127.0.0.1:4477";
}

const project = resolveProject(process.cwd());
const url = `${relayUrl()}/verify-gates?project=${encodeURIComponent(project)}${all ? "&all=1" : ""}`;
let gates = [];
try {
  const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
  gates = (await r.json()).gates || [];
} catch {
  console.error(`could not reach the hub at ${relayUrl()} — is it running? (trantor setup / trantor hub)`);
  process.exit(1);
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
