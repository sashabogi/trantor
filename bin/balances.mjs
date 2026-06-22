#!/usr/bin/env node
// trantor balances — show how much credit is left on each prepaid provider (DeepSeek, Kimi, OpenRouter…)
// so you can refill BEFORE a build stalls. Reads keys from the environment, queries each provider's
// balance API, prints them, and pushes the snapshot to the hub so the dashboard + other sessions see it.
//
// Usage: trantor balances [--json] [--no-push]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchBalances, isLow, fmtBalance, DEFAULT_LOW } from "../lib/balances.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const noPush = args.includes("--no-push");

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const c = join(homedir(), ".agent-bus", "config.json"); if (existsSync(c)) { const u = JSON.parse(readFileSync(c, "utf8")).url; if (u) return u; } } catch {}
  return "http://127.0.0.1:4477";
}
function thresholds() {
  try { const c = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")); if (c.lowBalance && typeof c.lowBalance === "object") return { ...DEFAULT_LOW, ...c.lowBalance }; } catch {}
  return DEFAULT_LOW;
}

const balances = await fetchBalances(process.env);
const low = thresholds();

// push the snapshot to the hub (best-effort) so the dashboard + warning line can use it
if (!noPush) {
  try {
    await fetch(`${relayUrl()}/balances`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ balances, ts: Date.now() }), signal: AbortSignal.timeout(2500) });
  } catch {}
}

if (asJson) { console.log(JSON.stringify({ balances, low: balances.filter((b) => isLow(b, low)).map((b) => b.provider) }, null, 2)); process.exit(0); }

if (!balances.length) {
  console.log("no prepaid providers configured in this environment.");
  console.log("set a key (e.g. DEEPSEEK_API_KEY, OPENROUTER_API_KEY, KIMI_API_KEY) and re-run.");
  process.exit(0);
}
console.log("PROVIDER CREDITS\n");
for (const b of balances) {
  const flag = b.ok && isLow(b, low) ? "  🔴 REFILL SOON" : (b.ok && b.remaining != null ? "  🟢" : "");
  console.log("  " + fmtBalance(b) + flag);
}
const lows = balances.filter((b) => isLow(b, low));
if (lows.length) console.log(`\n⚠ ${lows.length} provider(s) low — refill: ${lows.map((b) => b.label).join(", ")}`);
