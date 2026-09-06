#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: config.json is user-editable external input; thresholds validates its optional number/object fields at that I/O boundary. */
// trantor balances — show how much credit is left on each prepaid provider (DeepSeek, Kimi, OpenRouter…)
// so you can refill BEFORE a build stalls. Reads keys from the environment, queries each provider's
// balance API, prints them, and pushes the snapshot to the hub so the dashboard + other sessions see it.
//
// Usage: trantor balances [--json] [--no-push]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchBalances, isLow, fmtBalance, DEFAULT_LOW, DEFAULT_LOW_QUOTA_PCT } from "../lib/balances.mjs";
import { detectedCliBalanceRows } from "../lib/providers.mjs";
import { loadProfile } from "./profile.mjs";
import { resolveKeys } from "../lib/provider-keys.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const noPush = args.includes("--no-push");

// API-key providers stay profile-scoped so ambient keys are never scraped. Claude and Codex are
// machine CLI logins: the registry admits them from binary + credential + live-probe detection.
const configured = Object.keys(loadProfile().providers || {});

// Signed via the shared client (2026-07-31, agent-UX audit): unsigned POST rejected under enforce.
import { signedPost } from "../hooks/lib/api.mjs";
let _qpct = DEFAULT_LOW_QUOTA_PCT;
function thresholds() {
  try { const c = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")); if (typeof c.lowQuotaPct === "number") _qpct = c.lowQuotaPct; if (c.lowBalance && typeof c.lowBalance === "object") return { ...DEFAULT_LOW, ...c.lowBalance }; } catch {}
  return DEFAULT_LOW;
}

const env = resolveKeys(process.env);
const detected = await detectedCliBalanceRows({ env });
const profileScoped = await fetchBalances(env, { only: configured.filter((provider) => provider !== "claude" && provider !== "codex") });
const balances = [...detected, ...profileScoped];
const low = thresholds();

// push the snapshot to the hub (best-effort) so the dashboard + warning line can use it.
// TWO pushes on purpose: the project hub (fleet visibility) AND the LOCAL hub explicitly —
// the desktop app reads balances from 127.0.0.1 because the data is machine-local, and the
// project-resolved push goes to the REMOTE hub for pinned projects. That mismatch left the
// local snapshot 11 days stale on 2026-08-28: the header chips faithfully rendered Aug-16
// numbers, dimmed, while fresh pushes landed on a hub the app never asks.
if (!noPush) {
  const snap = { balances, ts: Date.now() };
  try { await signedPost("/balances", snap, { timeoutMs: 2500 }); } catch {}
  try { await signedPost("http://127.0.0.1:4477/balances", snap, { timeoutMs: 2500 }); } catch {}
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
