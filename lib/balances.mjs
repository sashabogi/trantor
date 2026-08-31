// trantor provider credit — read-only "how much is left before I stall" across the providers the crew
// uses. Keys come from the ENVIRONMENT (no new secret storage); each adapter names the env var(s) it
// reads. Two kinds of "left":
//   • prepaid  — a $ balance you top up (OpenRouter, DeepSeek, Moonshot platform). `remaining` = money.
//   • quota    — a recurring token/usage window that RESETS (Kimi Code, Z.ai GLM coding plans).
//                `remainingPct` (0-100) + `resetTime`; nothing to "refill", but you can run dry mid-build.
// Chinese providers split CN vs international endpoints — we use the INTERNATIONAL ones (api.moonshot.ai,
// api.kimi.com, api.z.ai, api.deepseek.com). Every call is short-timeout + fail-soft: a provider that
// errors is reported {ok:false,error}, never throws out of fetchBalances.
//
// ARCHITECTURE NOTE: the hub runs under launchd with a minimal env (no keys), so it can't fetch these
// itself. The env-having clients fetch + POST /balances; the hub caches + serves the dashboard.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TIMEOUT = 8000;

async function getJSON(url, key, extraHeaders = {}) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", Accept: "application/json", ...extraHeaders },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = null; }
  if (!r.ok) throw new Error(`HTTP ${r.status}${body?.error?.message ? " — " + body.error.message : ""}`);
  return body ?? {};
}

const num = (v) => (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);

// Each adapter: { provider, label, kind, match:[profile names], envKeys:[...], async fetch(key) }.
// `match` = the `trantor profile` provider name(s) this adapter serves — balances are ONLY queried for
// providers the user actually configured in their profile, NOT every key that happens to be in the
// ambient environment (a dev's shell/.env may hold keys for many unrelated projects). prepaid →
// { remaining, currency, unlimited? }   quota → { remainingPct, plan?, resetTime?, detail? }
export const ADAPTERS = [
  {
    // The Claude subscription's REAL windows — the same numbers the claude.ai usage page shows.
    // Auth is the operator's own Claude Code OAuth token (credentials file, then the macOS
    // keychain entry Claude Code itself writes). Read-only, machine-local; only the resulting
    // percentages ever leave this process (the hub snapshot) — the token never does.
    provider: "claude", label: "Claude", kind: "windows", match: ["claude", "anthropic"], envKeys: [],
    keyless: true,
    async fetch() {
      // USAGE v2: the statusline sidechannel (hooks/statusline.mjs) keeps a live local cache —
      // Claude Code pipes rate_limits to the statusLine every turn, free. When the OAuth
      // endpoint fails (it 429s under polling — Orca's lesson, docs/RESEARCH-orca-usage.md
      // §1.1), a fresh live capture answers instead of an error row. OAuth stays primary
      // because only it carries the model-scoped (Fable) window.
      const live = (() => {
        try {
          const l = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "usage-claude-live.json"), "utf8"));
          return l && Date.now() - (l.ts || 0) < 15 * 60 * 1000 ? l : null;
        } catch { return null; }
      })();
      const liveWin = (w, name) => (w && (w.used_percentage ?? w.utilization) != null)
        ? { name, usedPct: Math.round(Number(w.used_percentage ?? w.utilization)), resetsAt: w.resets_at || null, locked: null }
        : null;
      const liveWindows = () => [liveWin(live?.fiveHour, "5h"), liveWin(live?.sevenDay, "7d")].filter(Boolean);
      const tok = await claudeOAuthToken();
      if (!tok) {
        if (live && liveWindows().length) return { windows: liveWindows(), live: true };
        throw new Error("no Claude Code OAuth token found");
      }
      let r;
      try {
        r = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: { authorization: `Bearer ${tok}`, "anthropic-beta": "oauth-2025-04-20" },
          signal: AbortSignal.timeout(8000),
        });
      } catch (e) {
        if (live && liveWindows().length) return { windows: liveWindows(), live: true };
        throw e;
      }
      if (!r.ok) {
        if (live && liveWindows().length) return { windows: liveWindows(), live: true };
        throw new Error(`usage endpoint ${r.status}`);
      }
      const d = await r.json();
      const win = (w, name) => (w && w.utilization != null)
        ? { name, usedPct: Math.round(w.utilization), resetsAt: w.resets_at || null, locked: w.locked_reason || null }
        : null;
      // Model-scoped weekly limits ride limits[] (kind "weekly_scoped", scope.model.display_name
      // e.g. "Fable") — Orca shows these as their own segment ("36% used Fable") and so do we.
      // Captured live 2026-08-30: session/weekly_all in limits[] duplicate five_hour/seven_day,
      // so only the scoped entries add information.
      const scoped = (Array.isArray(d.limits) ? d.limits : [])
        .filter((l) => l && l.kind === "weekly_scoped" && l.percent != null && l.scope?.model?.display_name)
        .map((l) => ({ name: String(l.scope.model.display_name), usedPct: Math.round(l.percent),
                       resetsAt: l.resets_at || null, locked: null, scoped: true }));
      return { windows: [win(d.five_hour, "5h"), win(d.seven_day, "7d"), ...scoped].filter(Boolean) };
    },
  },

  {
    provider: "openrouter", label: "OpenRouter", kind: "prepaid", match: ["openrouter"], envKeys: ["OPENROUTER_API_KEY"],
    async fetch(key) {
      const d = (await getJSON("https://openrouter.ai/api/v1/key", key)).data || {};
      // limit_remaining is OpenRouter's authoritative credits-left (accounts for top-ups); limit−usage
      // is unreliable (usage is lifetime). null limit_remaining + null limit ⇒ unlimited key.
      const unlimited = d.limit_remaining == null && d.limit == null;
      const remaining = num(d.limit_remaining) != null ? num(d.limit_remaining)
        : (num(d.limit) != null ? Math.max(0, num(d.limit) - (num(d.usage) || 0)) : null);
      return { remaining, currency: "USD", usage: num(d.usage), limit: num(d.limit), unlimited };
    },
  },
  {
    provider: "deepseek", label: "DeepSeek", kind: "prepaid", match: ["deepseek"], envKeys: ["DEEPSEEK_API_KEY"],
    async fetch(key) {
      const j = await getJSON("https://api.deepseek.com/user/balance", key);   // global endpoint (no CN/intl split)
      const info = (j.balance_infos || [])[0] || {};
      return { remaining: num(info.total_balance), currency: info.currency || "USD", available: !!j.is_available };
    },
  },
  {
    provider: "moonshot", label: "Moonshot", kind: "prepaid", match: ["moonshot"], envKeys: ["MOONSHOT_API_KEY"],
    async fetch(key) {
      // international platform; china is api.moonshot.cn. (Distinct from Kimi Code sk-kim keys below.)
      const j = await getJSON("https://api.moonshot.ai/v1/users/me/balance", key);
      const d = j.data || j;
      return { remaining: num(d.available_balance), currency: "CNY", cash: num(d.cash_balance), voucher: num(d.voucher_balance) };
    },
  },
  {
    provider: "kimi", label: "Kimi Code", kind: "quota", match: ["kimi"], envKeys: ["KIMI_API_KEY"],
    async fetch(key) {
      // international Kimi Code; the sk-kim API key works as a bearer here (region REGION_OVERSEA).
      const j = await getJSON("https://api.kimi.com/coding/v1/usages", key);
      const tq = j.totalQuota || {};
      const remainingPct = (num(tq.limit) && num(tq.remaining) != null) ? Math.round(num(tq.remaining) / num(tq.limit) * 100)
        : (j.usage && num(j.usage.remaining) != null ? num(j.usage.remaining) : null);
      const w = (j.limits || [])[0];
      const detail = w?.detail ? `${Math.round(num(w.detail.remaining) / num(w.detail.limit) * 100)}% in ${Math.round((w.window?.duration || 0) / 60)}h window` : "";
      const plan = (j.user?.membership?.level || "").replace("LEVEL_", "").toLowerCase() || "coding";
      return { remainingPct, plan, resetTime: j.usage?.resetTime || w?.detail?.resetTime || null, detail };
    },
  },
  {
    provider: "zai", label: "Z.ai (GLM)", kind: "quota", match: ["zai", "glm", "zhipu"], envKeys: ["ZAI_API_KEY", "GLM_API_KEY"],
    async fetch(key) {
      // international Z.ai; coding-plan quota lives at undocumented monitor endpoints (used by their own UI).
      const j = await getJSON("https://api.z.ai/api/monitor/usage/quota/limit", key);
      const limits = j.data?.limits || [];
      const tokens = limits.filter(l => l.type === "TOKENS_LIMIT");
      // headline = the most-consumed token window (lowest remaining %)
      const head = [...tokens].sort((a, b) => (b.percentage || 0) - (a.percentage || 0))[0] || tokens[0];
      const remainingPct = head ? Math.max(0, 100 - (num(head.percentage) || 0)) : null;
      let plan = j.data?.level ? `GLM ${String(j.data.level).toUpperCase()}` : "GLM coding";
      try { const sub = await getJSON("https://api.z.ai/api/biz/subscription/list", key); const p = (sub.data || []).find(x => x.status === "VALID") || (sub.data || [])[0]; if (p?.productName) plan = p.productName; } catch {}
      return { remainingPct, plan, resetTime: head?.nextResetTime || null, detail: "" };
    },
  },
];

// thresholds: prepaid by currency, quota by percent-remaining. Override via config.json `lowBalance`
// (currency keys) and `lowQuotaPct`.
export const DEFAULT_LOW = { USD: 5, CNY: 35, EUR: 5 };
export const DEFAULT_LOW_QUOTA_PCT = 15;

export function isLow(entry, thresholds = DEFAULT_LOW, quotaPct = DEFAULT_LOW_QUOTA_PCT) {
  if (!entry || !entry.ok) return false;
  if (entry.kind === "quota") return entry.remainingPct != null && entry.remainingPct < quotaPct;
  // A usage window is LOW when what remains of it dips under the same quota threshold — 90% used
  // on the 5h window is exactly the moment to know before firing a crew.
  if (entry.kind === "windows") return (entry.windows || []).some((w) => w.usedPct != null && (100 - w.usedPct) < quotaPct || w.locked);
  if (entry.remaining == null) return false;   // prepaid unlimited/unknown
  const t = thresholds[entry.currency] ?? thresholds.USD ?? 5;
  return entry.remaining < t;
}

// Fetch credit ONLY for the providers the user configured in `trantor profile` (opts.only = the set of
// profile provider names). An adapter runs only if it serves a configured provider AND its key is in the
// env — so a stray OPENROUTER_API_KEY in a dev's .env is NOT reported unless they actually run OpenRouter
// through Trantor. If `only` is omitted (no profile yet), nothing is fetched — better empty than wrong.

// The operator's own Claude Code OAuth token: the credentials file first, then the keychain item
// Claude Code writes on macOS. Used ONLY to read the subscription's usage windows.
async function claudeOAuthToken() {
  try {
    const { readFileSync: rf, existsSync: ex } = await import("node:fs");
    const { join: j } = await import("node:path");
    const { homedir: h } = await import("node:os");
    const p = j(h(), ".claude", ".credentials.json");
    if (ex(p)) {
      const t = JSON.parse(rf(p, "utf8"))?.claudeAiOauth?.accessToken;
      if (t) return t;
    }
  } catch {}
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 4000 }).trim();
    return JSON.parse(out)?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

export async function fetchBalances(env = process.env, opts = {}) {
  const only = Array.isArray(opts.only) ? new Set(opts.only.map((s) => String(s).toLowerCase())) : null;
  const jobs = ADAPTERS.map(async (a) => {
    const names = (a.match || [a.provider]).map((s) => s.toLowerCase());
    if (!only || !names.some((n) => only.has(n))) return null;   // not a Trantor-configured provider → skip
    const envKey = a.envKeys.find((k) => env[k]);
    if (!envKey && !a.keyless) return null;                      // configured but no key in env → can't query
    const base = { provider: a.provider, label: a.label, kind: a.kind, via: envKey || "oauth" };
    try { return { ...base, ok: true, ...(await a.fetch(envKey ? env[envKey] : undefined)) }; }
    catch (e) { return { ...base, ok: false, error: String(e?.message || e) }; }
  });
  const rows = (await Promise.all(jobs)).filter(Boolean);
  // Codex: OpenAI publishes no public balance API, but the Codex CLI's OWN token can read the
  // ChatGPT backend's usage windows — the same source Orca's footer reads (#5570; verified live
  // 2026-08-30: plan_type + primary/secondary_window {used_percent, reset_at}). Evidence of
  // configuration is the login artifact (~/.codex/auth.json), not an env key. The token never
  // leaves the process; only percentages are reported. If the endpoint is unreachable, fall
  // back to the honest subscription row this used to be — never an error row for a seat that
  // bills flat.
  // Same profile gate as every adapter (latent bug from the v6 static row, surfaced 2026-08-30:
  // `!only ||` made a codex row appear with NO profile at all — "better empty than wrong").
  if (only && (only.has("codex") || only.has("openai"))) {
    try {
      const { existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const authPath = join(homedir(), ".codex", "auth.json");
      if (existsSync(authPath)) {
        const base = { provider: "codex", label: "Codex", via: "codex login", ok: true };
        try {
          const tok = JSON.parse(readFileSync(authPath, "utf8"))?.tokens || {};
          if (!tok.access_token) throw new Error("no codex token");
          const r = await fetch("https://chatgpt.com/backend-api/wham/usage", {
            headers: {
              authorization: `Bearer ${tok.access_token}`,
              "ChatGPT-Account-Id": tok.account_id || "",
              "User-Agent": "codex-cli", "OpenAI-Beta": "codex-1", originator: "Codex Desktop",
            },
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) throw new Error(`wham/usage ${r.status}`);
          const d = await r.json();
          const win = (w, fallbackName) => {
            if (!w || w.used_percent == null) return null;
            const secs = Number(w.limit_window_seconds) || 0;
            const name = secs === 604800 ? "7d" : secs > 0 && secs <= 21600 ? "5h"
              : secs > 0 ? `${Math.round(secs / 3600)}h` : fallbackName;
            return { name, usedPct: Math.round(w.used_percent),
                     resetsAt: w.reset_at ? Number(w.reset_at) * 1000 : null, locked: null };
          };
          const windows = [win(d.rate_limit?.primary_window, "5h"), win(d.rate_limit?.secondary_window, "7d")].filter(Boolean);
          if (!windows.length) throw new Error("no usage windows in response");
          rows.push({ ...base, kind: "windows", plan: d.plan_type ? `ChatGPT ${d.plan_type}` : "OpenAI subscription", windows });
        } catch {
          rows.push({ ...base, kind: "subscription",
            plan: "OpenAI subscription", note: "usage endpoint unreachable — flat subscription" });
        }
      }
    } catch { /* no fs access → no row, never an error */ }
  }
  return rows;
}

// human one-liner for a credit entry (CLI + warning line)
export function fmtBalance(e) {
  if (!e.ok) return `${e.label}: ⚠ ${e.error}`;
  if (e.kind === "quota") {
    if (e.remainingPct == null) return `${e.label}${e.plan ? " (" + e.plan + ")" : ""}: quota unknown`;
    const reset = e.resetTime ? ` · resets ${fmtReset(e.resetTime)}` : "";
    return `${e.label}${e.plan ? " (" + e.plan + ")" : ""}: ${e.remainingPct}% left${reset}`;
  }
  if (e.kind === "windows") {
    const parts = (e.windows || []).map((w) => `${w.name} ${w.usedPct}% used${w.resetsAt ? " · resets " + fmtReset(w.resetsAt) : ""}${w.locked ? " · LOCKED" : ""}`);
    return `${e.label}: ${parts.join("  ·  ") || "windows unknown"}`;
  }
  if (e.kind === "subscription") return `${e.label}: ${e.plan || "subscription"} (${e.note || "no balance API"})`;
  const sym = e.currency === "CNY" ? "¥" : e.currency === "EUR" ? "€" : "$";
  if (e.unlimited || e.remaining == null) return `${e.label}: ${e.kind === "prepaid" ? "no limit / unknown" : e.kind}`;
  const amt = e.remaining.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${e.label}: ${sym}${amt} ${e.currency} left`;
}

function fmtReset(t) {
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (!ms || isNaN(ms)) return "";
  const hrs = (ms - Date.now()) / 3600e3;
  if (hrs < 0) return "soon";
  if (hrs < 48) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)}d`;
}
