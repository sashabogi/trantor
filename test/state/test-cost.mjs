// P5 — cost (TDD §4.6, §4.8). The envelope parser and the transcript parser must produce the ONE
// CostStruct the bench compares. The §4.8 rule — stream-json is the cost source, may corroborate
// `touched`, NEVER sets `verified` — is asserted here structurally: the module's entire export
// surface is cost structs, so there is nothing on it that could write state even by accident.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cost from "../../lib/state/cost.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();
const DIR = mkdtempSync(join(tmpdir(), "trantor-state-cost-"));

// ---- fromEnvelope — §0's measured warm-call envelope, verbatim ----
{
  const env = {
    type: "result", subtype: "success", is_error: false,
    total_cost_usd: 0.0945,
    usage: { input_tokens: 46, output_tokens: 1763, cache_read_input_tokens: 212183, cache_creation_input_tokens: 32220 },
    result: "patch applied",
  };
  const c = cost.fromEnvelope(env);
  ok("envelope: parses the §0 measured shape field-for-field",
    c && c.cost_usd === 0.0945 && c.input === 46 && c.output === 1763 && c.cache_read === 212183 && c.cache_creation === 32220,
    JSON.stringify(c));
  ok("envelope: accepts raw stdout text too", (() => { const s = cost.fromEnvelope(JSON.stringify(env)); return s && s.cache_read === 212183; })());
  ok("envelope: missing total_cost_usd leaves cost null, tokens still parsed",
    (() => { const { total_cost_usd, ...rest } = env; const s = cost.fromEnvelope(rest); return s && s.cost_usd === null && s.input === 46; })());
  ok("envelope: missing usage is null (an unknown cost is null, never 0)",
    cost.fromEnvelope({ total_cost_usd: 0.5 }) === null);
  ok("envelope: garbage string is null", cost.fromEnvelope("<html>busy</html>") === null);
  ok("envelope: null/array/number are null", cost.fromEnvelope(null) === null && cost.fromEnvelope([env]) === null && cost.fromEnvelope(7) === null);
  ok("envelope: negative/NaN token fields clamp to 0, not poison",
    (() => { const s = cost.fromEnvelope({ usage: { input_tokens: -3, output_tokens: "many", cache_read_input_tokens: NaN, cache_creation_input_tokens: 5 } }); return s && s.input === 0 && s.output === 0 && s.cache_read === 0 && s.cache_creation === 5; })());
}

// ---- fromTranscript — the baseline source: whole-session sum of assistant usage rows ----
{
  const rows = [
    JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", costUSD: 0.01, message: { model: "claude-x", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 } } }),
    JSON.stringify({ type: "progress", message: { usage: { input_tokens: 9_999_999 } } }),   // wrong type: NEVER counted
    JSON.stringify({ type: "assistant", costUSD: 0.02, message: { model: "claude-x", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } } }),
    "{ this line is truncated JSON from a cut write",
    "",
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 60, cache_creation_input_tokens: 40 } } }),   // no costUSD
  ];
  const p = join(DIR, "transcript.jsonl");
  writeFileSync(p, rows.join("\n") + "\n");
  const c = cost.fromTranscript(p);
  ok("transcript: sums usage rows across the whole session",
    c && c.input === 16 && c.output === 30 && c.cache_read === 360 && c.cache_creation === 140, JSON.stringify(c));
  ok("transcript: per-row costUSD sums where present", c && Math.abs(c.cost_usd - 0.03) < 1e-9);
  ok("transcript: a row without message.usage is skipped, not fatal", (() => {
    const q = join(DIR, "thin.jsonl");
    writeFileSync(q, JSON.stringify({ type: "assistant", message: { role: "assistant" } }) + "\n" + rows[1] + "\n");
    const s = cost.fromTranscript(q);
    return s && s.input === 10;
  })());
  ok("transcript: no costUSD anywhere → cost_usd stays null", (() => {
    const q = join(DIR, "nocost.jsonl");
    writeFileSync(q, rows[6] + "\n");
    const s = cost.fromTranscript(q);
    return s && s.cost_usd === null && s.input === 5;
  })());
  ok("transcript: zero usage rows → null, not a zero struct", (() => {
    const q = join(DIR, "empty.jsonl");
    writeFileSync(q, "{oops\n\n");
    return cost.fromTranscript(q) === null;
  })());
  ok("transcript: missing file → null", cost.fromTranscript(join(DIR, "nope.jsonl")) === null);
}

// ---- the §4.8 boundary, held structurally ----
{
  const names = Object.keys(cost).sort();
  ok("cost.mjs exports ONLY cost parsing — no state writer can hide on this module",
    JSON.stringify(names) === JSON.stringify(["costLine", "fromEnvelope", "fromTranscript"]), names.join(","));
}

// ---- costLine — the runner's one-line turn readout ----
{
  ok("costLine renders dollars and the four token fields",
    cost.costLine({ cost_usd: 0.0945, input: 46, output: 1763, cache_read: 212183, cache_creation: 32220 })
      === "cost $0.0945 · in 46 · out 1763 · cache_read 212183 · cache_creation 32220");
  ok("costLine: null cost renders n/a, not $0.0000",
    cost.costLine({ cost_usd: null, input: 1, output: 2, cache_read: 3, cache_creation: 4 }).startsWith("cost n/a"));
  ok("costLine: no struct is a line, not a crash", cost.costLine(null) === "cost: no envelope");
}

rmSync(DIR, { recursive: true, force: true });
done();
