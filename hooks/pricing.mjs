// trantor — Anthropic API pricing, the single source of truth for the NOTIONAL dollar cost of a
// Claude Code sub-agent's token usage (it's "notional" because on a Pro/Max plan those tokens are
// plan-covered, not billed — we still want the number). $/MTok. Re-confirm before trusting old reports.
export const PRICING_AS_OF = "2026-09";

// in/out = input/output; cw5m/cw1h = cache-WRITE at the 5-minute / 1-hour TTL; cr = cache-READ.
// (cache write 5m = 1.25× input, 1h = 2× input, read = 0.1× input — encoded directly here.)
export const ANTHROPIC_PRICING = {
  opus:        { in: 5,  out: 25, cw5m: 6.25,  cw1h: 10, cr: 0.5 },   // Opus 5 / 4.8 / 4.7 / 4.6
  "opus-5-5":  { in: 4,  out: 20, cw5m: 5,     cw1h: 8,  cr: 0.2 },   // cheaper than Opus 5, and its cache read is 0.05× input, not 0.1×
  sonnet:      { in: 2,  out: 10, cw5m: 2.5,   cw1h: 4,  cr: 0.2 },   // Sonnet 5
  "sonnet-4":  { in: 3,  out: 15, cw5m: 3.75,  cw1h: 6,  cr: 0.3 },   // Sonnet 4 / 4.5 / 4.6
  haiku:       { in: 1,  out: 5,  cw5m: 1.25,  cw1h: 2,  cr: 0.1 },
  fable:       { in: 10, out: 50, cw5m: 12.5,  cw1h: 20, cr: 0.25 },  // Fable 5 / 5.1, cache read 0.025× input
  "opus-4-1":  { in: 15, out: 75, cw5m: 18.75, cw1h: 30, cr: 1.5 },   // legacy numbering — far pricier
};

// Map a transcript model id ("claude-opus-4-8", "claude-sonnet-4-6", …) to a price tier, or null.
// MOST SPECIFIC FIRST: a generic includes("opus") priced the default Opus 5.5 off the Opus 5 tier (#8443).
// An unrecognised version stays null — costUsd:null has a reporting path, a wrong dollar figure does not.
export function tierFor(model) {
  const m = String(model || "").toLowerCase();
  if (/opus-4-1\b|opus-4\.1/.test(m)) return "opus-4-1";
  if (/opus-5-5\b|opus-5\.5/.test(m)) return "opus-5-5";
  if (/opus-(5|4-8|4-7|4-6|4-5)\b/.test(m)) return "opus";
  if (/sonnet-4(-[0-9]+)?\b/.test(m)) return "sonnet-4";
  if (/sonnet-5\b/.test(m)) return "sonnet";
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("haiku")) return "haiku";
  return null; // unknown → caller emits costUsd:null + a costNote rather than guessing
}

// Notional USD for one turn's usage. Sub-agents always start a COLD cache (5m TTL) even on a
// subscription, so cache writes default to the 5m rate. Returns null when the model isn't priced.
export function costOfTurn({ model, input = 0, output = 0, cacheWrite = 0, cacheRead = 0 }, ttl = "5m") {
  const p = ANTHROPIC_PRICING[tierFor(model)];
  if (!p) return null;
  const cw = ttl === "1h" ? p.cw1h : p.cw5m;
  return (input * p.in + output * p.out + cacheWrite * cw + cacheRead * p.cr) / 1e6;
}

// Sum a list of usage rows → { usd, tokens, unpriced, model }. usd is null only if NOTHING was priced.
export function notionalCost(rows, ttl = "5m") {
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let usd = 0, priced = 0, unpriced = 0, model = "";
  for (const r of rows) {
    tokens.input += r.input || 0; tokens.output += r.output || 0;
    tokens.cacheWrite += r.cacheWrite || 0; tokens.cacheRead += r.cacheRead || 0;
    if (r.model) model = r.model;
    const c = costOfTurn(r, ttl);
    if (c == null) unpriced++; else { usd += c; priced++; }
  }
  return { usd: priced ? usd : null, tokens, unpriced, priced, model };
}
