// trantor provider credit: read-only "how much is left before I stall". Keys come from the env;
// prepaid = money remaining, quota = percent remaining + reset time. International endpoints.
// Every call is short-timeout + fail-soft ({ok:false,error}, never a throw). The hub runs under
// launchd with no keys, so env-having clients fetch and POST /balances. docs/CONTRACT-lib.md.

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

// Each adapter: { provider, label, kind, match:[profile names], envKeys, async fetch(key) }.
// Balances are queried ONLY for providers in the operator's profile, never every ambient key.
// prepaid → { remaining, currency, unlimited? }   quota → { remainingPct, plan?, resetTime?, detail? }
export const ADAPTERS = [
  {
    // The Claude subscription's REAL windows — the same numbers the claude.ai usage page shows.
    // Auth is the operator's own Claude Code OAuth token (credentials file, then the macOS
    // keychain entry Claude Code itself writes). Read-only, machine-local; only the resulting
    // percentages ever leave this process (the hub snapshot) — the token never does.
    provider: "claude", label: "Claude", kind: "windows", match: ["claude", "anthropic"], envKeys: [],
    keyless: true,
    async fetch() {
      // USAGE v2: the statusline sidechannel keeps a live local cache; when OAuth 429s under polling
      // (docs/RESEARCH-orca-usage.md §1.1) it answers instead of an error row. OAuth stays primary
      // because only it carries the model-scoped window.
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
      // Model-scoped weekly limits ride limits[] (kind "weekly_scoped"); session/weekly_all there
      // duplicate five_hour/seven_day, so only the scoped entries add information.
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
  {
    // #6131: the graded remaining-% is cookie-only, so this reads the WALL: a zero-token probe
    // (`messages: []` trips the quota gate before validation) answers 429 insufficient_quota with
    // the reset time once the plan is spent. Otherwise "unknown", never an invented percentage.
    provider: "qwen", label: "Qwen", kind: "quota", match: ["qwen"], envKeys: ["QWEN_API_KEY"],
    async fetch(key, env = {}) {
      const base = String(env.QWEN_BASE_URL || "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
      // Ask the plan which models it has rather than hard-coding an id that a rename would break
      // (and this doubles as the auth check: a rejected key 401s here, before the probe).
      const model = ((await getJSON(`${base}/models`, key)).data || [])[0]?.id;
      if (!model) throw new Error("token plan lists no models");
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ model, messages: [] }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      let body; try { body = JSON.parse(await r.text()); } catch { body = null; }
      const err = body?.error || {};
      if (r.status === 401 || err.code === "invalid_api_key") throw new Error("invalid API key");
      if (r.status === 429 || err.code === "insufficient_quota") {
        // retry-after is authoritative (seconds, exact); the message carries the same instant as
        // "MM-DD HH:MM:SS UTC" with no year, so it is only the fallback.
        const secs = num(r.headers.get("retry-after"));
        const resetTime = secs > 0 ? Date.now() + secs * 1000 : qwenResetFromMessage(err.message);
        return { remainingPct: 0, plan: "token plan", resetTime, detail: "7-day token plan exhausted" };
      }
      // The gate let the request through, so the plan still has room — but how much is console-only.
      return { remainingPct: null, plan: "token plan", resetTime: null, detail: "plan active (remaining % is console-only)" };
    },
  },
];

/// "The quota will reset at 09-09 14:32:00 UTC." — Qwen omits the year, so assume the current one
/// and roll forward when that lands in the past (the plan resets ahead of now, never behind it).
export function qwenResetFromMessage(msg, now = Date.now()) {
  const m = /reset at (\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))? UTC/i.exec(String(msg || ""));
  if (!m) return null;
  const [, mo, d, h, mi, s] = m;
  const at = (year) => Date.UTC(year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  const year = new Date(now).getUTCFullYear();
  const t = at(year);
  return Number.isFinite(t) ? (t >= now ? t : at(year + 1)) : null;
}

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
    // `env` rides along for adapters that read more than a key (Qwen's base URL); the rest ignore it.
    try { return { ...base, ok: true, ...(await a.fetch(envKey ? env[envKey] : undefined, env)) }; }
    catch (e) { return { ...base, ok: false, error: String(e?.message || e) }; }
  });
  const rows = (await Promise.all(jobs)).filter(Boolean);
  // Codex: no public balance API, but the CLI's own token reads the ChatGPT usage windows (#5570).
  // Configuration evidence is ~/.codex/auth.json; only percentages leave the process; an
  // unreachable endpoint falls back to the subscription row. Same profile gate as every adapter.
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

// exported for the provider registry (#6390): state reasons append the same reset short-form
// the balances rows print, so status and balances can never disagree about a reset date.
export function fmtReset(t) {
  const ms = Number.isFinite(t) ? t : Date.parse(t);
  if (!ms || isNaN(ms)) return "";
  const hrs = (ms - Date.now()) / 3600e3;
  if (hrs < 0) return "soon";
  if (hrs < 48) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)}d`;
}
