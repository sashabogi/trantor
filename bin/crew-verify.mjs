#!/usr/bin/env node
// crew-verify — prove that spawned crew agents ACTUALLY joined the bus (don't trust the spawn).
//
//   node crew-verify.mjs <project> <agent...> [--timeout 30]
//
// An agent counts as UP when its session (<agent>:<project>) has registered with a lastSeen
// AFTER this verifier started. Prints one line per agent; exits non-zero listing failures —
// the launcher retries those, and the orchestrator gets the truth instead of a green lie.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const ti = args.indexOf("--timeout");
const TIMEOUT = ti >= 0 ? Number(args.splice(ti, 2)[1]) : 30;
const [PROJ, ...AGENTS] = args;
if (!PROJ || !AGENTS.length) { console.error("usage: crew-verify.mjs <project> <agent...> [--timeout 30]"); process.exit(2); }

function hubUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const u = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")).url; if (u) return u; } catch {}
  return "http://127.0.0.1:4477";
}
const HUB = hubUrl();
const START = Date.now();

(async () => {
  const want = new Set(AGENTS.map(a => `${a}:${PROJ}`));
  const up = new Set();
  while (Date.now() - START < TIMEOUT * 1000 && up.size < want.size) {
    try {
      const { peers } = await (await fetch(`${HUB}/peers`)).json();
      for (const p of peers) if (want.has(p.session) && p.lastSeen >= START) up.add(p.session);
    } catch {}
    if (up.size < want.size) await new Promise(s => setTimeout(s, 1500));
  }
  const failed = [...want].filter(s => !up.has(s));
  for (const s of want) console.log(`${up.has(s) ? "✓" : "✗"} ${s} ${up.has(s) ? "on the bus" : `NOT on the bus after ${TIMEOUT}s`}`);
  if (failed.length) { console.log(`FAILED:${failed.map(s => s.split(":")[0]).join(",")}`); process.exit(1); }
})();
