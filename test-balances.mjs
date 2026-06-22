// trantor balance feature tests — pure helpers (isLow/fmtBalance/fetchBalances skip) + hub POST/GET
// round-trip with low-flagging and profile→subscription merge. Hermetic: temp data dir, no network
// for the hub tests (adapters are verified live separately).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLow, fmtBalance, fetchBalances, DEFAULT_LOW } from "./lib/balances.mjs";

let fail = 0; const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };

// --- pure helpers ---
ok(isLow({ ok: true, remaining: 2, currency: "USD" }) === true, "isLow: $2 USD < $5 default → low");
ok(isLow({ ok: true, remaining: 9, currency: "USD" }) === false, "isLow: $9 USD ≥ $5 → not low");
ok(isLow({ ok: true, remaining: 10, currency: "CNY" }) === true, "isLow: ¥10 < ¥35 default → low");
ok(isLow({ ok: false, error: "x" }) === false, "isLow: errored entry → never low");
ok(isLow({ ok: true, remaining: null }) === false, "isLow: unlimited (null) → never low");
ok(isLow({ ok: true, remaining: 1, currency: "USD" }, { USD: 0.5 }) === false, "isLow: respects custom threshold");
ok(fmtBalance({ ok: true, label: "DeepSeek", remaining: 3.5, currency: "CNY", kind: "prepaid" }).includes("¥3.50"), "fmtBalance: CNY symbol + 2dp");
ok(fmtBalance({ ok: false, label: "Kimi", error: "401" }).includes("⚠"), "fmtBalance: errored shows warning");
ok(fmtBalance({ ok: true, label: "Sub", kind: "subscription", remaining: null }).includes("subscription"), "fmtBalance: subscription label");
// quota kind
ok(isLow({ ok: true, kind: "quota", remainingPct: 8 }) === true, "isLow: quota 8% < 15% default → low");
ok(isLow({ ok: true, kind: "quota", remainingPct: 99 }) === false, "isLow: quota 99% → not low");
ok(isLow({ ok: true, kind: "quota", remainingPct: 40 }, DEFAULT_LOW, 50) === true, "isLow: quota respects custom pct (40<50)");
ok(isLow({ ok: true, kind: "quota", remainingPct: null }) === false, "isLow: quota unknown% → never low");
ok(fmtBalance({ ok: true, kind: "quota", label: "Kimi Code", plan: "intermediate", remainingPct: 99 }).includes("99% left"), "fmtBalance: quota shows % left + plan");

// --- fetchBalances is scoped to the configured profile, NOT ambient env keys ---
const noProfile = await fetchBalances({ OPENROUTER_API_KEY: "x", KIMI_API_KEY: "y" });
ok(Array.isArray(noProfile) && noProfile.length === 0, "fetchBalances: no `only` (no profile) → empty even with keys present (no scraping, no network)");
const notConfigured = await fetchBalances({ OPENROUTER_API_KEY: "x" }, { only: ["deepseek", "claude"] });
ok(notConfigured.length === 0, "fetchBalances: OpenRouter key in env but NOT in profile → skipped (the .env-scraping bug fix)");
const noKey = await fetchBalances({}, { only: ["deepseek"] });
ok(noKey.length === 0, "fetchBalances: provider configured but no key in env → skipped (no network)");

// --- hub POST/GET /balances round-trip ---
const dir = mkdtempSync(join(tmpdir(), "trantor-bal-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
// seed a profile: providers under test must be here (the hub filters /balances to the profile), plus a
// pure-subscription (claude) to exercise the subscription merge.
writeFileSync(join(dir, ".agent-bus", "profile.json"), JSON.stringify({ providers: {
  claude: { plan: "max", tier: "capped-sub" }, kimi: { plan: "coding-plan", tier: "capped-sub" },
  openrouter: { plan: "api", tier: "api" }, deepseek: { plan: "api", tier: "api" }, zai: { plan: "coding-plan", tier: "capped-sub" },
} }));
const PORT = 47713;
const hub = spawn("node", ["hub.mjs"], { env: { ...process.env, RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(PORT), PORT: String(PORT) }, stdio: ["ignore", "ignore", "pipe"] });
let err = ""; hub.stderr.on("data", d => err += d);
await new Promise(r => setTimeout(r, 800));
const base = `http://127.0.0.1:${PORT}`;
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());

await post("/balances", { ts: 1000, by: "old:trantor", balances: [{ provider: "openrouter", label: "OpenRouter", kind: "prepaid", ok: true, remaining: 99, currency: "USD" }] });
await post("/balances", { ts: 2000, by: "new:trantor", balances: [
  { provider: "openrouter", label: "OpenRouter", kind: "prepaid", ok: true, remaining: 11.68, currency: "USD" },
  { provider: "deepseek", label: "DeepSeek", kind: "prepaid", ok: true, remaining: 2.10, currency: "USD" },
  { provider: "zai", label: "Z.ai (GLM)", kind: "quota", ok: true, remainingPct: 6, plan: "GLM Coding Max" },
  { provider: "moonshot", label: "Kimi (Moonshot)", kind: "prepaid", ok: false, error: "HTTP 401" },
  { provider: "xai", label: "xAI", kind: "prepaid", ok: true, remaining: 99, currency: "USD" },   // NOT in profile
] });
const g = await get("/balances");
ok(!g.entries.find(e => e.provider === "xai"), "hub: xAI NOT in profile → filtered out of /balances (no .env scraping)");
ok(g.by === "new:trantor", "hub: newer snapshot wins (latest writer)");
const or = g.entries.find(e => e.provider === "openrouter");
const ds = g.entries.find(e => e.provider === "deepseek");
ok(or && or.remaining === 11.68 && or.low === false, "hub: OpenRouter $11.68 not low");
ok(ds && ds.low === true, "hub: DeepSeek $2.10 flagged low");
const zai = g.entries.find(e => e.provider === "zai");
ok(zai && zai.kind === "quota" && zai.low === true, "hub: Z.ai quota 6% flagged low");
ok(g.lowCount === 2, `hub: lowCount=2 (DeepSeek + Z.ai) (got ${g.lowCount})`);
const kimi = g.entries.find(e => e.provider === "moonshot");
ok(kimi && kimi.kind === "subscription", "hub: errored Kimi reconciled to subscription (profile kimi=coding-plan)");
const claude = g.entries.find(e => e.provider === "claude");
ok(claude && claude.kind === "subscription", "hub: claude (max) listed as subscription from profile");
ok(g.entries.filter(e => e.provider === "moonshot" || e.provider === "kimi").length === 1, "hub: no duplicate Kimi/Moonshot entry");

// older snapshot must not clobber newer
await post("/balances", { ts: 500, balances: [{ provider: "openrouter", label: "OpenRouter", kind: "prepaid", ok: true, remaining: 0.01, currency: "USD" }] });
const g2 = await get("/balances");
ok(g2.entries.find(e => e.provider === "openrouter").remaining === 11.68, "hub: stale snapshot rejected (kept newer)");

// --- hub guard: an old/buggy client can't inject an inflated cc-subagent cost (v0.17.37) ---
const bogus = await post("/task", { project: "guardp", title: "subagent: recall memory", status: "done",
  source: "cc-subagent", costKind: "subagent-notional", costUsd: 46554, tokens: { cacheRead: 65953e6, input: 0, output: 0, cacheWrite: 0 }, by: "x:guardp" });
ok(bogus.task && bogus.task.costUsd === null && bogus.task.tokens === null, "hub: implausible cc-subagent cost ($46k/66B cache-read) rejected → null");
const fine = await post("/task", { project: "guardp", title: "general-purpose: build feature", status: "done",
  source: "cc-subagent", costKind: "subagent-notional", costUsd: 12.5, tokens: { cacheRead: 20e6, input: 1e6, output: 5e5, cacheWrite: 0 }, by: "x:guardp" });
ok(fine.task && fine.task.costUsd === 12.5, "hub: plausible cc-subagent cost ($12.50/20M) kept");

hub.kill();
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
