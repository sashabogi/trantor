// #9805: the OpenRouter chip showed a key's spending cap ($18.61 of $20) as the account balance.
import { ADAPTERS } from "../../lib/balances.mjs";

let fail = 0; const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };
const adapter = ADAPTERS.find(a => a.provider === "openrouter");
const realFetch = globalThis.fetch;
const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const stub = (routes) => { globalThis.fetch = async (url) => { const r = routes[String(url)]; return r ? r() : reply(404, {}); }; };
const KEY = "https://openrouter.ai/api/v1/key", CREDITS = "https://openrouter.ai/api/v1/credits";

try {
  stub({
    [KEY]: () => reply(200, { data: { limit: 20, limit_remaining: 18.613, usage: 67.59 } }),
    [CREDITS]: () => reply(200, { data: { total_credits: 240, total_usage: 211.06 } }),
  });
  let r = await adapter.fetch("k");
  ok(Math.abs(r.remaining - 28.94) < 0.01, `remaining is the account balance, 240 - 211.06 (got ${r.remaining})`);
  ok(r.source === "account", `source says account (got ${r.source})`);
  ok(Math.abs(r.keyRemaining - 18.613) < 0.001, `the key cap is still reported separately (got ${r.keyRemaining})`);

  stub({
    [KEY]: () => reply(200, { data: { limit: 20, limit_remaining: 18.613, usage: 67.59 } }),
    [CREDITS]: () => reply(403, { error: { message: "forbidden" } }),
  });
  r = await adapter.fetch("k");
  ok(Math.abs(r.remaining - 18.613) < 0.001 && r.source === "key-cap", `credits unreachable falls back to the key cap, labelled key-cap (got ${r.remaining}, ${r.source})`);
} finally {
  globalThis.fetch = realFetch;
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
