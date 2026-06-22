// trantor provider balances — read-only credit checks for the PREPAID providers the crew uses, so you
// know when to refill BEFORE a build stalls. Keys come from the environment (no new secret storage):
// each adapter names the env var(s) it reads. Subscriptions (Claude Max, Codex Plus, GLM coding-plan)
// have nothing to refill → they're not balances and aren't fetched here. Every call is short-timeout
// and fail-soft: a provider that errors is reported {ok:false,error}, never throws out of fetchBalances.
//
// ARCHITECTURE NOTE: the hub runs under launchd with a minimal env (no keys), so it can't fetch these
// itself. The env-having clients fetch + POST /balances; the hub caches + serves the dashboard.

const TIMEOUT = 8000;

async function getJSON(url, key, extraHeaders = {}) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", ...extraHeaders },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = null; }
  if (!r.ok) throw new Error(`HTTP ${r.status}${body?.error?.message ? " — " + body.error.message : ""}`);
  return body ?? {};
}

// Each adapter: { provider, label, kind, envKeys:[...], async fetch(key) -> { remaining, currency, ... } }
// `remaining` is the headline number (null = unlimited/unknown). Keep adapters tiny + independent.
export const ADAPTERS = [
  {
    provider: "openrouter", label: "OpenRouter", kind: "prepaid", envKeys: ["OPENROUTER_API_KEY"],
    async fetch(key) {
      const j = await getJSON("https://openrouter.ai/api/v1/key", key);
      const d = j.data || {};
      // limit_remaining is OpenRouter's authoritative "credits left on this key" (accounts for top-ups);
      // limit−usage is unreliable (usage is lifetime). null limit_remaining + null limit ⇒ unlimited key.
      const unlimited = d.limit_remaining == null && d.limit == null;
      const remaining = d.limit_remaining != null ? Number(d.limit_remaining)
        : (d.limit != null ? Math.max(0, d.limit - (d.usage || 0)) : null);
      return { remaining, currency: "USD", usage: d.usage ?? null, limit: d.limit ?? null, unlimited };
    },
  },
  {
    provider: "deepseek", label: "DeepSeek", kind: "prepaid", envKeys: ["DEEPSEEK_API_KEY"],
    async fetch(key) {
      const j = await getJSON("https://api.deepseek.com/user/balance", key);
      const info = (j.balance_infos || [])[0] || {};
      return { remaining: info.total_balance != null ? Number(info.total_balance) : null,
        currency: info.currency || "USD", available: !!j.is_available, granted: info.granted_balance, toppedUp: info.topped_up_balance };
    },
  },
  {
    provider: "moonshot", label: "Kimi (Moonshot)", kind: "prepaid", envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    async fetch(key) {
      // account region differs — try .cn then the international .ai
      let lastErr;
      for (const host of ["api.moonshot.cn", "api.moonshot.ai"]) {
        try {
          const j = await getJSON(`https://${host}/v1/users/me/balance`, key);
          const d = j.data || j;
          return { remaining: d.available_balance != null ? Number(d.available_balance) : null,
            currency: "CNY", cash: d.cash_balance, voucher: d.voucher_balance };
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("no moonshot host responded");
    },
  },
];

// default refill thresholds per currency (configurable via config.json `lowBalance`)
export const DEFAULT_LOW = { USD: 5, CNY: 35, EUR: 5 };

export function isLow(entry, thresholds = DEFAULT_LOW) {
  if (!entry || !entry.ok || entry.remaining == null) return false;
  const t = thresholds[entry.currency] ?? thresholds.USD ?? 5;
  return entry.remaining < t;
}

// fetch balances for every adapter whose key is present in `env`. Adapters with no configured key are
// skipped (not an error — that provider just isn't set up here). Returns a normalized array.
export async function fetchBalances(env = process.env) {
  const jobs = ADAPTERS.map(async (a) => {
    const envKey = a.envKeys.find((k) => env[k]);
    if (!envKey) return null; // not configured in this env
    const base = { provider: a.provider, label: a.label, kind: a.kind, via: envKey };
    try { return { ...base, ok: true, ...(await a.fetch(env[envKey])) }; }
    catch (e) { return { ...base, ok: false, error: String(e?.message || e) }; }
  });
  return (await Promise.all(jobs)).filter(Boolean);
}

// human one-liner for a balance entry (CLI + warning line)
export function fmtBalance(e) {
  const sym = e.currency === "CNY" ? "¥" : e.currency === "EUR" ? "€" : "$";
  if (!e.ok) return `${e.label}: ⚠ ${e.error}`;
  if (e.unlimited || e.remaining == null) return `${e.label}: ${e.kind === "prepaid" ? "no limit / unknown" : e.kind}`;
  return `${e.label}: ${sym}${e.remaining.toFixed(2)} ${e.currency} left`;
}
