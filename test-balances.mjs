// trantor balance feature tests — pure helpers (isLow/fmtBalance/fetchBalances skip) + hub POST/GET
// round-trip with low-flagging and profile→subscription merge. Hermetic: temp data dir, no network
// for the hub tests (adapters are verified live separately).
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { isLow, fmtBalance, fetchBalances, qwenResetFromMessage, DEFAULT_LOW } from "./lib/balances.mjs";
import { detectedCliBalanceRows } from "./lib/providers.mjs";
import { drillEnv } from "./drill-env.mjs";

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

// --- #6131: Qwen token-plan probe — the reset-time parser, then the adapter live against a mock
// gateway (its own base URL is overridable via env.QWEN_BASE_URL, no real network) ---
{
  const now = Date.parse("2026-09-03T00:00:00Z");
  ok(qwenResetFromMessage("The quota will reset at 09-09 14:32:00 UTC.", now) === Date.UTC(2026, 8, 9, 14, 32, 0),
    "qwenResetFromMessage: MM-DD HH:MM:SS UTC parsed with the current year assumed");
  const rolled = qwenResetFromMessage("reset at 01-01 00:00 UTC", now);
  ok(rolled === Date.UTC(2027, 0, 1, 0, 0, 0), "qwenResetFromMessage: a date already past this year rolls to next year");
  ok(qwenResetFromMessage("no reset time in here") === null, "qwenResetFromMessage: no match → null, never a guess");

  // mock gateway: /models answers auth, /chat/completions answers the quota gate
  let mode = "exhausted";
  const gw = http.createServer((req, res) => {
    if (req.url.startsWith("/models")) {
      if (req.headers.authorization !== "Bearer good-key") { res.writeHead(401); return res.end(JSON.stringify({ error: { code: "invalid_api_key" } })); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "qwen-max" }] }));
    }
    if (req.url.startsWith("/chat/completions")) {
      if (mode === "exhausted") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" });
        return res.end(JSON.stringify({ error: { code: "insufficient_quota", message: "reset at 09-09 10:32:00 UTC" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  const QWEN_BASE_URL = `http://127.0.0.1:${gw.address().port}`;

  mode = "exhausted";
  const spent = await fetchBalances({ QWEN_API_KEY: "good-key", QWEN_BASE_URL }, { only: ["qwen"] });
  const qRow = spent.find((r) => r.provider === "qwen");
  ok(qRow?.ok === true && qRow.remainingPct === 0, `fetchBalances: qwen 429 insufficient_quota → remainingPct 0 (got ${JSON.stringify(qRow)})`);
  ok(qRow?.resetTime > Date.now(), "fetchBalances: qwen exhausted row carries a future resetTime (from retry-after)");
  ok(isLow(qRow) === true, "isLow: qwen row at 0% → low, same as Kimi Code's quota shape");
  ok(fmtBalance(qRow).includes("Qwen") && fmtBalance(qRow).includes("0% left"), "fmtBalance: qwen row reads like Kimi Code's");

  mode = "active";
  const active = await fetchBalances({ QWEN_API_KEY: "good-key", QWEN_BASE_URL }, { only: ["qwen"] });
  const aRow = active.find((r) => r.provider === "qwen");
  ok(aRow?.ok === true && aRow.remainingPct === null, "fetchBalances: qwen gate passed → remainingPct unknown (console-only), not a guess");
  ok(isLow(aRow) === false, "isLow: unknown qwen % → never low");

  const bad = await fetchBalances({ QWEN_API_KEY: "wrong-key", QWEN_BASE_URL }, { only: ["qwen"] });
  const bRow = bad.find((r) => r.provider === "qwen");
  // The /models auth check runs first and fails soft the same as any adapter's HTTP error — never a crash.
  ok(bRow?.ok === false && /401/.test(bRow.error), `fetchBalances: qwen bad key → errored row, not a crash (got ${JSON.stringify(bRow)})`);

  gw.close();
}

// --- windows rows (#5570: Claude scoped limits + Codex real windows, Orca parity) ---
// Shapes captured LIVE 2026-08-30: oauth/usage limits[] weekly_scoped → a named scoped window;
// wham/usage primary/secondary → 5h/7d with unix-second resets (normalized to ms upstream).
const claudeWin = { ok: true, label: "Claude", kind: "windows", windows: [
  { name: "5h", usedPct: 8, resetsAt: new Date(Date.now() + 5 * 3600e3).toISOString() },
  { name: "7d", usedPct: 30, resetsAt: new Date(Date.now() + 3 * 86400e3).toISOString() },
  { name: "Fable", usedPct: 37, resetsAt: new Date(Date.now() + 3 * 86400e3).toISOString(), scoped: true },
] };
const cw = fmtBalance(claudeWin);
ok(cw.includes("5h 8% used") && cw.includes("Fable 37% used"), "fmtBalance: windows row spells the scoped Fable segment");
const codexWin = { ok: true, label: "Codex", kind: "windows", windows: [
  { name: "5h", usedPct: 61, resetsAt: Date.now() + 12 * 60e3 },
  { name: "7d", usedPct: 25, resetsAt: Date.now() + 5.8 * 86400e3 },
] };
ok(fmtBalance(codexWin).includes("5h 61% used"), "fmtBalance: codex windows row reads like claude's");
ok(isLow(codexWin) === false, "isLow: 61%/25% used → not low");
ok(isLow({ ok: true, kind: "windows", windows: [{ name: "5h", usedPct: 91 }] }) === true, "isLow: 91% used window (9% left < 15%) → low");

// --- fetchBalances is scoped to the configured profile, NOT ambient env keys ---
const noProfile = await fetchBalances({ OPENROUTER_API_KEY: "x", KIMI_API_KEY: "y" });
ok(Array.isArray(noProfile) && noProfile.length === 0, "fetchBalances: no `only` (no profile) → empty even with keys present (no scraping, no network)");
const notConfigured = await fetchBalances({ OPENROUTER_API_KEY: "x" }, { only: ["deepseek", "claude"] });
// Assert the INTENT (no .env scraping), not a row count: claude is in the profile and its
// keyless OAuth adapter may legitimately produce a row on a machine with Claude Code installed
// (latent since 0.18.15 — this suite hadn't run between that adapter landing and 2026-08-30).
ok(!notConfigured.find(e => e.provider === "openrouter"), "fetchBalances: OpenRouter key in env but NOT in profile → skipped (the .env-scraping bug fix)");
ok(!notConfigured.find(e => e.provider === "deepseek"), "fetchBalances: deepseek configured but no key → still skipped");
const noKey = await fetchBalances({}, { only: ["deepseek"] });
ok(noKey.length === 0, "fetchBalances: provider configured but no key in env → skipped (no network)");

// Claude/Codex are registry-detected machine logins, independent of the optional quota profile.
// Fake binary + auth + probe prove all three gates without touching the operator or the network.
const detectedHome = mkdtempSync(join(tmpdir(), "trantor-bal-detected-"));
const detectedBin = join(detectedHome, "bin");
mkdirSync(join(detectedHome, ".codex"), { recursive: true });
mkdirSync(detectedBin, { recursive: true });
writeFileSync(join(detectedBin, "codex"), "#!/bin/sh\nexit 0\n");
chmodSync(join(detectedBin, "codex"), 0o755);
writeFileSync(join(detectedHome, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "fake-token" } }));
const detectedRows = await detectedCliBalanceRows({
  home: detectedHome,
  path: `${detectedBin}:/usr/bin:/bin`,
  env: {},
  probe: async (provider) => provider === "codex"
    ? { provider: "codex", label: "Codex", kind: "windows", ok: true, windows: [{ name: "5h", usedPct: 12 }] }
    : null,
});
ok(!existsSync(join(detectedHome, ".agent-bus", "profile.json")), "registry balance detection: fixture has no quota profile entry");
ok(detectedRows.some((entry) => entry.provider === "codex" && entry.ok),
  "registry balance detection: logged-in Codex produces a row without a profile entry");

// --- hub POST/GET /balances round-trip ---
const dir = mkdtempSync(join(tmpdir(), "trantor-bal-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
// Seed a profile: API providers under test must be here. Claude is deliberately declared but has no
// snapshot row, proving a profile entry alone cannot manufacture a CLI-login balance row.
writeFileSync(join(dir, ".agent-bus", "profile.json"), JSON.stringify({ providers: {
  claude: { plan: "max", tier: "capped-sub" }, kimi: { plan: "coding-plan", tier: "capped-sub" },
  openrouter: { plan: "api", tier: "api" }, deepseek: { plan: "api", tier: "api" }, zai: { plan: "coding-plan", tier: "capped-sub" },
} }));
const PORT = 47713;
const hub = spawn("node", ["hub.mjs"], { env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(PORT), PORT: String(PORT) }, stdio: ["ignore", "ignore", "pipe"] });
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
  { provider: "codex", label: "Codex", kind: "windows", ok: true, windows: [{ name: "5h", usedPct: 12 }] },
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
ok(!claude, "hub: Claude profile entry alone does not manufacture a CLI-login row");
const codex = g.entries.find(e => e.provider === "codex");
ok(codex?.kind === "windows", "hub: detected Codex row survives without a quota profile entry");
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
