/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this module decodes untrusted CLI output — a `claude -p --output-format json` envelope and CC transcript JSONL written by whatever CLI version produced them. Every typeof here is the boundary parse that keeps a format shift from becoming a crash or a poisoned cost figure. */
// Trantor State P5 — cost (TDD §4.6, §4.8). The one place stream-json is legitimate.
//
// §4.8 rejected the seat's stream output as an EVIDENCE source on principle — reading `verified`
// off tool calls the seat chose to make makes the seat the judge of its own work — and kept the
// stream as the COST source. This module is that keep, and it is structured so the rule holds
// mechanically, not on honor: it imports no state, owns no writes, and its only exports return
// plain cost structs. Corroboration of `touched` may ride the stream too; setting `verified`
// cannot, from here, ever.
//
// Two sources, one struct, one comparison (§4.6):
//   • fromEnvelope  — the `--output-format json` result object: total_cost_usd +
//                     usage.{input,output,cache_read_input,cache_creation_input}_tokens.
//   • fromTranscript — the baseline path (no JSON output format): the same shape summed from the
//                     CC transcript's assistant usage rows, the rows
//                     hooks/lib/handoff.mjs:contextUsage() already reads — except cost wants the
//                     WHOLE session, so this reads the full file where contextUsage tails it.
import { readFileSync } from "node:fs";

/** @typedef {{ cost_usd: number|null, input: number, output: number, cache_read: number, cache_creation: number }} CostStruct */

/** A number, or 0 — transcript usage fields are absent on some CLI releases and a missing field
 *  must sum as zero, not NaN its way into every later comparison. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0) ? v : 0;

/**
 * Parse one `claude -p --output-format json` envelope (§0's measured shape) into a CostStruct.
 * Accepts the parsed object or the raw stdout text. Anything without a usage object — a truncated
 * read, a format shift, an error blob — returns null: an unknown cost is null, never 0, because
 * a fake 0 would flatter the ≥5× gate.
 * @param {object|string|null} envelope
 * @returns {CostStruct|null}
 */
export function fromEnvelope(envelope) {
  let e = envelope;
  if (typeof e === "string") {
    try { e = JSON.parse(e); } catch { return null; }
  }
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const u = e.usage && typeof e.usage === "object" && !Array.isArray(e.usage) ? e.usage : null;
  if (!u) return null;
  return {
    cost_usd: typeof e.total_cost_usd === "number" && Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : null,
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cache_read: num(u.cache_read_input_tokens),
    cache_creation: num(u.cache_creation_input_tokens),
  };
}

/**
 * Sum a CC transcript's usage rows (JSONL, `type:"assistant"`, `message.usage`) into the same
 * CostStruct. Per-turn `costUSD` is summed when rows carry it; older formats without it leave
 * `cost_usd` null rather than inventing a price from tokens. A missing or unreadable file, or a
 * transcript with no usage rows, is null — same rule as the envelope.
 * @param {string} path
 * @returns {CostStruct|null}
 */
export function fromTranscript(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  let costUSD = null;
  const sum = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  let rows = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }   // partial trailing write, carry on
    if (!r || typeof r !== "object" || r.type !== "assistant") continue;
    const u = r.message && typeof r.message === "object" ? r.message.usage : null;
    if (!u || typeof u !== "object") continue;
    rows++;
    sum.input += num(u.input_tokens);
    sum.output += num(u.output_tokens);
    sum.cache_read += num(u.cache_read_input_tokens);
    sum.cache_creation += num(u.cache_creation_input_tokens);
    if (typeof r.costUSD === "number" && Number.isFinite(r.costUSD)) costUSD = (costUSD ?? 0) + r.costUSD;
  }
  if (!rows) return null;
  return { cost_usd: costUSD, ...sum };
}

/** The one-line cost readout the runner prints at a turn boundary (the P6 formatter's raw material,
 *  §4.6). Null-safe: no envelope is a line, not a crash. */
export function costLine(c) {
  if (!c) return "cost: no envelope";
  const usd = c.cost_usd == null ? "n/a" : `$${c.cost_usd.toFixed(4)}`;
  return `cost ${usd} · in ${c.input} · out ${c.output} · cache_read ${c.cache_read} · cache_creation ${c.cache_creation}`;
}
