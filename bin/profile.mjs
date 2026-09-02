#!/usr/bin/env node
// trantor quota profile — declare what plan each provider runs on, once.
// The Advisor uses this to pick execution modes (plans can't be detected reliably).
//
//   node bin/profile.mjs                       # show current profile
//   node bin/profile.mjs set claude=max codex=plus gemini=tier kimi=coding-plan deepseek=api
//   node bin/profile.mjs set claude=pro        # update one provider
//
// Plan vocabulary (free-form, but these mean something to the Advisor):
//   api          — pay per token (offload aggressively; every orchestrator token is money)
//   pro | plus | tier | coding-plan — a capped subscription (~$20-ish: crew is the only path
//                  for real builds; the plan's quota is a scarce budget)
//   max | max-5x | max-20x | ultra — high-tier subscription (cost moot; context horizon decides)
//   none         — provider not available on this machine
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const FILE = join(homedir(), ".agent-bus", "profile.json");
const KNOWN = ["claude", "codex", "gemini", "kimi", "deepseek", "opencode"];
const TIER = (plan) => {
  const p = String(plan || "none").toLowerCase();
  if (p === "api") return "api";
  if (/^(max|ultra)/.test(p)) return "high-sub";
  if (p === "none") return "none";
  return "capped-sub";                                  // pro/plus/tier/coding-plan/anything else
};

export function loadProfile() {
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return { providers: {} }; }
}
export function tierOf(profile, provider) { return TIER(profile?.providers?.[provider]?.plan); }

const [, , cmd, ...args] = process.argv;
// is-main guard: compare against a PROPERLY ENCODED file URL. A hand-built `file://${argv[1]}` is raw
// text, but import.meta.url is percent-encoded — so any URL-reserved char in the install path (most
// commonly a SPACE, e.g. ".../Application Support/...") made this false and silently skipped main (exit 0,
// no write). pathToFileURL is the canonical Node idiom. See regression in test-handoff.mjs / test.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prof = loadProfile();
  prof.providers ||= {};
  if (cmd === "set") {
    for (const a of args) {
      const [prov, plan] = a.split("=");
      // A flag in the provider position (`set --help=api`) is a usage mistake, not a provider —
      // die before the write, or profile.json grows a '--help' entry (#5998). 'help' likewise.
      if (!prov || !plan || prov.startsWith("--") || prov === "help") {
        console.error(`bad arg '${a}' — use provider=plan`);
        process.exit(1);
      }
      prof.providers[prov.toLowerCase()] = { plan: plan.toLowerCase(), tier: TIER(plan) };
    }
    prof.updated = new Date().toISOString().slice(0, 10);
    mkdirSync(dirname(FILE), { recursive: true });   // `set` creates its own ~/.agent-bus if absent
    writeFileSync(FILE, JSON.stringify(prof, null, 2) + "\n");
    console.log("profile saved →", FILE);
  } else if (cmd && cmd !== "show") {
    console.error("usage: profile.mjs [show] | set provider=plan …"); process.exit(1);
  }
  const p = loadProfile();
  console.log("QUOTA PROFILE" + (existsSync(FILE) ? "" : "  (not set — Advisor will assume api billing everywhere)"));
  for (const k of new Set([...KNOWN, ...Object.keys(p.providers || {})])) {
    const e = (p.providers || {})[k];
    console.log(`  ${k.padEnd(9)} ${e ? `${e.plan.padEnd(12)} → ${e.tier}` : "(unset)"}`);
  }
}
