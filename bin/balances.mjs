#!/usr/bin/env node
// trantor balances — show how much credit is left on each prepaid provider (DeepSeek, Kimi, OpenRouter…)
// so you can refill BEFORE a build stalls. Reads keys from the environment, queries each provider's
// balance API, prints them, and pushes the snapshot to the hub so the dashboard + other sessions see it.
//
// Usage: trantor balances [--json] [--no-push]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchBalances, isLow, fmtBalance, DEFAULT_LOW, DEFAULT_LOW_QUOTA_PCT } from "../lib/balances.mjs";
import { loadProfile } from "./profile.mjs";
import { resolveKeys } from "../lib/provider-keys.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const noPush = args.includes("--no-push");

// Only check providers the user configured in `trantor profile` — never stray keys in the ambient env.
const configured = Object.keys(loadProfile().providers || {});

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const c = join(homedir(), ".agent-bus", "config.json"); if (existsSync(c)) { const u = JSON.parse(readFileSync(c, "utf8")).url; if (u) return u; } } catch {}
  return "http://127.0.0.1:4477";
}
let _qpct = DEFAULT_LOW_QUOTA_PCT;
function thresholds() {
  try { const c = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")); if (typeof c.lowQuotaPct === "number") _qpct = c.lowQuotaPct; if (c.lowBalance && typeof c.lowBalance === "object") return { ...DEFAULT_LOW, ...c.lowBalance }; } catch {}
  return DEFAULT_LOW;
}

const balances = await fetchBalances(resolveKeys(process.env), { only: configured });
const low = thresholds();

// push the snapshot to the hub (best-effort) so the dashboard + warning line can use it
if (!noPush) {
  try {
    await fetch(`${relayUrl()}/balances`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ balances, ts: Date.now() }), signal: AbortSignal.timeout(2500) });
  } catch {}
}

if (asJson) { console.log(JSON.stringify({ balances, low: balances.filter((b) => isLow(b, low, _qpct)).map((b) => b.provider) }, null, 2)); process.exit(0); }

if (!balances.length) {
  if (!configured.length) {
    console.log("no quota profile set — Trantor doesn't know which providers you use.");
    console.log("declare them:  trantor profile set claude=max kimi=coding-plan deepseek=api zai=coding-plan");
  } else {
    console.log(`configured providers: ${configured.join(", ")} — but none expose a balance/quota API with a key present.`);
    console.log("(subscriptions like claude/codex/gemini have nothing to refill; prepaid/coding-plan providers need their key in the env.)");
  }
  process.exit(0);
}
console.log("PROVIDER CREDITS\n");
for (const b of balances) {
  const hasNum = b.ok && (b.remaining != null || b.remainingPct != null);
  const flag = isLow(b, low, _qpct) ? "  🔴 REFILL SOON" : (hasNum ? "  🟢" : "");
  console.log("  " + fmtBalance(b) + flag);
}
const lows = balances.filter((b) => isLow(b, low, _qpct));
if (lows.length) console.log(`\n⚠ ${lows.length} provider(s) low — top up / pace: ${lows.map((b) => b.label).join(", ")}`);
