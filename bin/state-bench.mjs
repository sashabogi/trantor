#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: every decode in this file reads bytes some
   OTHER process wrote — a CC transcript JSONL, a `claude -p --output-format json` envelope, a run
   log appended by the runner, a handoff record. A measurement tool that crashes on a format shift
   reports nothing; one that coerces silently reports a number that is not true. Both are worse
   than a typeof at the boundary. */
// Trantor State P7 — the bench (TDD §8 Phase 2a, §7.5, §7.3).
//
// This is the only file in the project whose job is to say NO. Every other package makes the
// harness work; this one is the thing that can tell us it does not, and so it is built on three
// rules that are easy to write down and easy to violate by accident:
//
//   1. AN UNKNOWN IS NEVER A PASS. Every gate has three outcomes — pass, fail, and "could not be
//      evaluated" — and the third exits non-zero like the second. A missing baseline, a run log
//      that was never written, fewer than the required turns: each of those is a NO, not a shrug.
//      A tool that reports green when it measured nothing is worse than no tool.
//   2. NOTHING IS FABRICATED. There is no default, no estimate and no fallback number anywhere in
//      here. A cost that the envelope did not carry is `null` and voids the ratio; it is never 0,
//      because a 0 flatters the ≥5× gate.
//   3. THE BASELINE IS A PRE-CONDITION, NOT A STEP. `requireBaseline()` runs before any
//      measurement and checks the artifact is in the COMMITTED tree (`git cat-file -e HEAD:…`),
//      not merely on disk. A 5× claim measured against a baseline captured afterwards is
//      unfalsifiable, and a file that exists on disk is a file that could have been written after
//      the run. Being in HEAD is the part that cannot be back-dated by the measurement.
//
//   node bin/state-bench.mjs --baseline --card <id> --transcript <path>   capture the baseline
//   node bin/state-bench.mjs --run --card <id>            the Phase-2a gate, all seven checks
//   node bin/state-bench.mjs --disturb --card <id> --file <p>   inject the §8.5 disturbance
//   node bin/state-bench.mjs --patches [--from <jsonl>]   §7.3 malformed vs evidence, separately
//   node bin/state-bench.mjs --handoffs 10                §8 Phase-1 field-drop gate
//   node bin/state-bench.mjs --turns                      §8.7 turns-per-card, median over n≥3
//   node bin/state-bench.mjs --report --card <id>         the comparison table
//
// Everything above the dispatch is pure and exported, so test/state/test-bench.mjs measures the
// measurements rather than restating them.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { busDir, handoffDir, resolveProject } from "../lib/project.mjs";
import { EVIDENCE_CODES, MALFORMED_CODES, stateError } from "../lib/state/schema.mjs";
import { readJournal, readState, statePath } from "../lib/state/store.mjs";
import { deriveState } from "../lib/state/derive.mjs";

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** §8.4 wants the per-turn cost curve flat against turn index. "Flat" needs a number: the fitted
 *  rise across the WHOLE run, as a fraction of the run's mean turn cost. At 0.5 the last turn of
 *  an eight-turn run may cost 1.5× the mean and still pass; anything steeper is a curve, not a
 *  line, and the O(T) claim is not supported by the measurement. */
export const SLOPE_TOLERANCE = 0.5;
/** §8.4: total cost must be this many times below the recorded baseline. */
export const COST_FACTOR = 5;
/** §8.4: a slope fitted over fewer turns than this is noise wearing a gate's clothes. */
export const MIN_TURNS = 8;
/**
 * Relative token prices, base input = 1: the published Anthropic multipliers (cache read 0.1×,
 * 5-minute cache write 1.25×, output 5× on the Opus/Sonnet ladder).
 *
 * These are an ASSUMPTION, not a measurement, which is why nothing reaches for them by default.
 * They exist because the alternative on an unpriced transcript is worse in a way that is easy to
 * miss: `input + output` is not a cost proxy when the prose path pays almost everything through
 * cache_read (card 6909: input 216, cache_read 14,535,924), so an unweighted token ratio comes out
 * near 1× and reads as "the design does nothing" for reasons that have nothing to do with the
 * design. Every report that uses these says `basis: weighted` and names them.
 */
export const TOKEN_WEIGHTS = { input: 1, cache_read: 0.1, cache_creation: 1.25, output: 5 };
/** §8.5: the step after a disturbance may read more input than the run's median — state changed —
 *  but a RE-READ BURST is a multiple, not a margin. Above this the seat re-oriented. */
export const DISTURB_INPUT_FACTOR = 2;
/** §8.5: and the shape of a re-orientation is a read tool call. Acting on current state means
 *  acting; going back to the filesystem to find out where it is means the state did not carry. */
export const READ_TOOLS = ["Read", "Grep", "Glob", "NotebookRead", "LS"];
/** §8.7: one card is an anecdote. Below this the gate carries forward rather than passing. */
export const MIN_CARDS = 3;
/** §7.3 invalid-patch budgets, by what the seat's CLI can enforce. */
export const PATCH_BUDGET = { enforced: 0.02, prompt: 0.10 };

// ── paths ─────────────────────────────────────────────────────────────────────────────────────

/** Per-turn baseline rows for one card, on the CURRENT (transcript) path. */
export function baselinePath(project, card) {
  return join(busDir(), "state", "baselines", `${project}-${card}.jsonl`);
}
/** The COMMITTED half of the artifact (§7.5) — the one gate 1 reads out of HEAD. */
export function baselineDoc(card, repo = REPO) {
  return join(repo, "docs", `state-baseline-${card}.md`);
}
/** Per-turn step records the state-mode driver appends. P6 writes these; this file only reads. */
export function runPath(project, card) {
  return join(busDir(), "state", "runs", `${project}-${card}.jsonl`);
}
/** Turn-result outcomes for the §7.3 budget: one line per turn, per seat. */
export function patchesPath(project) {
  return join(busDir(), "state", "patches", `${project}.jsonl`);
}

// ── jsonl, and the numbers inside it ──────────────────────────────────────────────────────────

/** Read a JSONL file into rows. A missing file is `null` — DISTINCT from an empty one (`[]`), so
 *  a caller can tell "never recorded" from "recorded nothing". Every gate here needs that
 *  difference: the first is an unknown, the second is a measurement. */
export function readJsonl(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn tail is an artefact, not a fault */ }
  }
  return rows;
}

/** Append one row. Used by --baseline and --disturb here, and by P6's driver for run steps. */
export function appendJsonl(path, row) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return path;
}

/** A finite number, or null. Never 0 — see rule 2 at the top of this file. */
export function finite(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** A token count: absent means the CLI release did not carry the field, which sums as zero. */
const tokens = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function median(values) {
  const xs = values.filter(v => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Least-squares slope of `values` against their own index. Fewer than two points has no slope —
 *  null, not 0, because 0 would read as "measured flat". */
export function fitSlope(values) {
  const ys = values.filter(v => typeof v === "number" && Number.isFinite(v));
  if (ys.length < 2) return null;
  const n = ys.length;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - meanX) * (ys[i] - meanY); den += (i - meanX) ** 2; }
  return den === 0 ? null : num / den;
}

// ── the baseline: capture, and the pre-condition ──────────────────────────────────────────────

/**
 * Decompose a CC transcript into per-turn rows.
 *
 * THE UNIT IS THE THING THIS FUNCTION CAN GET WRONG, so it is chosen out loud. §8.4 fits a slope
 * against turn index to ask whether context grows with the work. On the state path one turn is one
 * `claude -p` invocation — one model call carrying the assembled prefix. The comparable unit on
 * the prose path is therefore ONE MODEL CALL, i.e. one assistant row with usage, because that is
 * where the growing conversation is re-sent and re-read.
 *
 * The tempting alternative — group by user prompt — is wrong for a crew seat and wrong in the
 * flattering direction: a seat wakes twice and works for two hours, so grouping by prompt collapses
 * 108 model calls into 2 rows, erases the curve entirely, and hands the baseline a per-"turn"
 * figure that no state-path step will ever be compared against honestly. Measured on card 6909:
 * 2 rows by prompt, 108 by call. `--unit prompt` keeps the other reading available for a session
 * that really is prompt-driven; it is never the default.
 *
 * @returns {{turn:number, ts:number, cost_usd:number|null, input:number, output:number,
 *            cache_read:number, cache_creation:number, assistant_rows:number}[]|null}
 */
export function perTurnFromTranscript(path, { unit = "call" } = {}) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  const turns = [];
  let cur = null;
  const open = (ts) => ({ turn: turns.length + 1, ts, cost_usd: null, input: 0, output: 0, cache_read: 0, cache_creation: 0, assistant_rows: 0 });
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== "object") continue;
    const ts = Date.parse(r.timestamp || "") || 0;
    if (unit === "prompt" && r.type === "user" && !isToolResult(r)) {
      if (cur && cur.assistant_rows) turns.push(cur);
      cur = open(ts);
      continue;
    }
    if (r.type !== "assistant") continue;
    const u = r.message && typeof r.message === "object" ? r.message.usage : null;
    if (!u || typeof u !== "object") continue;
    if (unit === "call") { if (cur && cur.assistant_rows) turns.push(cur); cur = open(ts); }
    else if (!cur) cur = open(ts);
    cur.assistant_rows++;
    cur.input += tokens(u.input_tokens);
    cur.output += tokens(u.output_tokens);
    cur.cache_read += tokens(u.cache_read_input_tokens);
    cur.cache_creation += tokens(u.cache_creation_input_tokens);
    const c = finite(r.costUSD);
    if (c !== null) cur.cost_usd = (cur.cost_usd ?? 0) + c;
  }
  if (cur && cur.assistant_rows) turns.push(cur);
  return turns.map((t, i) => ({ ...t, turn: i + 1 }));
}

/** A `user` row that is really a tool result coming back, not a person (or a runner) speaking. */
function isToolResult(row) {
  const c = row.message && typeof row.message === "object" ? row.message.content : null;
  if (!Array.isArray(c)) return false;
  return c.some(part => part && typeof part === "object" && part.type === "tool_result");
}

/** Sum rows into the totals the ratio is computed from. `cost_usd` stays null unless EVERY row
 *  carried one: a partial sum compared against a full one is a fake ratio. */
export function totals(rows) {
  const out = { turns: rows.length, cost_usd: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  let priced = 0;
  for (const r of rows) {
    out.input += tokens(r.input); out.output += tokens(r.output);
    out.cache_read += tokens(r.cache_read); out.cache_creation += tokens(r.cache_creation);
    const c = finite(r.cost_usd);
    if (c !== null) { out.cost_usd += c; priced++; }
  }
  if (!rows.length || priced !== rows.length) out.cost_usd = null;
  return out;
}

/**
 * GATE 1 (§8, Phase 2a) — the pre-condition, checked before a single measurement runs.
 *
 * Existence on disk is not the test. The artifact has to be in the committed tree, because the
 * whole point of §7.5 is that the baseline cannot have been produced to fit the result. A file in
 * the working tree could have been written thirty seconds ago by the run it is judging; a blob
 * reachable from HEAD could not.
 */
export function requireBaseline({ project, card, repo = REPO }) {
  const doc = baselineDoc(card, repo);
  const rel = doc.startsWith(`${repo}/`) ? doc.slice(repo.length + 1) : doc;
  let committed = false;
  try {
    execFileSync("git", ["cat-file", "-e", `HEAD:${rel}`], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
    committed = true;
  } catch { committed = false; }
  if (!committed) {
    return {
      ok: false, code: "NO_BASELINE", doc: rel,
      message: `no committed baseline artifact at ${rel} (HEAD). §7.5: the Phase-2a gate cannot be evaluated and the phase does not open. Capture it first:\n  node bin/state-bench.mjs --baseline --card ${card} --transcript <cc-transcript.jsonl>\nthen commit ${rel}.`,
    };
  }
  const rows = readJsonl(baselinePath(project, card));
  if (!rows || !rows.length) {
    return {
      ok: false, code: "NO_BASELINE_ROWS", doc: rel,
      message: `${rel} is committed but its per-turn rows are missing at ${baselinePath(project, card)} — the table without the measurements behind it is a claim, not a baseline. Re-run --baseline.`,
    };
  }
  return { ok: true, doc: rel, rows, totals: totals(rows) };
}

/** The committed half of the artifact: the summary table a person reads and git records. */
export function baselineMarkdown({ project, card, transcript, rows, capturedAt, unit = "call" }) {
  const t = totals(rows);
  const L = [];
  L.push(`# State baseline — ${project} card ${card}`);
  L.push("");
  L.push(`Captured ${new Date(capturedAt).toISOString()} from \`${transcript}\` on the CURRENT (prose/transcript) path — no sidecar, no assembly. One row is one **${unit === "call" ? "model call" : "wake"}**, the unit §8.4 compares a state-path step against. This file is the §7.5 pre-condition: the Phase-2a gate in §8 refuses to run until it is in HEAD, so that the ≥${COST_FACTOR}× claim is measured against a number recorded BEFORE the thing it judges.`);
  L.push("");
  L.push("| turn | cost usd | input | output | cache read | cache creation |");
  L.push("|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    L.push(`| ${r.turn} | ${r.cost_usd == null ? "n/a" : r.cost_usd.toFixed(4)} | ${r.input} | ${r.output} | ${r.cache_read} | ${r.cache_creation} |`);
  }
  L.push(`| **total** | **${t.cost_usd == null ? "n/a" : t.cost_usd.toFixed(4)}** | **${t.input}** | **${t.output}** | **${t.cache_read}** | **${t.cache_creation}** |`);
  L.push("");
  L.push(`Turns: ${t.turns}. Per-turn rows: \`${baselinePath(project, card)}\`.`);

  // The number this file exists to be compared against: how the context a turn carries grows with
  // the turn index. On the prose path it grows; that growth is the whole premise of the design,
  // and a baseline that recorded only totals could not falsify it either way.
  const ctx = rows.map(r => tokens(r.input) + tokens(r.cache_read) + tokens(r.cache_creation));
  const slope = fitSlope(ctx);
  L.push("");
  L.push("## Context carried per turn");
  L.push("");
  L.push(`| first | median | last | fitted slope per turn |`);
  L.push(`|---:|---:|---:|---:|`);
  L.push(`| ${ctx[0]} | ${median(ctx)} | ${ctx[ctx.length - 1]} | ${slope === null ? "n/a" : slope.toFixed(1)} |`);
  L.push("");
  L.push(`Measured, not modelled: the prose path carries ${slope === null ? "an unmeasurable" : slope > 0 ? "a growing" : "a flat"} context, ${ctx[0]} tokens at the first call and ${ctx[ctx.length - 1]} at the last. The state path is supposed to hold this flat; §8.4 is where that is checked, against these numbers.`);
  if (t.cost_usd == null) {
    L.push("");
    L.push("`cost usd` is **n/a**: this transcript release records `usage` but no `costUSD` on its assistant rows. That is not papered over — with no price on either side, `--run` returns `NO_COST` and the §8.4 ratio does not resolve. `--basis weighted` computes it from `TOKEN_WEIGHTS` (the published cache/output multipliers) and labels every line with the assumption, because an unweighted `input + output` reading of these rows would come out near 1× purely because this path pays through `cache_read`.");
  }
  return `${L.join("\n")}\n`;
}

// ── gate 3: the cache actually hit ────────────────────────────────────────────────────────────

/**
 * GATE 3 (§8) — `cache_read_input_tokens > 0` on every step after the first.
 *
 * This is the check that catches the §0 assumption breaking silently. A zero here means the
 * assembled preamble drifted between turns, prefix caching never engaged, and the cost claim is
 * void even when the totals happen to look fine — which they can, on a short run, for entirely
 * unrelated reasons. The first step is exempt because there is nothing before it to have cached.
 */
export function checkCache(steps) {
  if (!Array.isArray(steps) || steps.length < 2) {
    return { ok: false, code: "TOO_FEW_STEPS", checked: steps?.length ?? 0, violations: [], message: "fewer than two steps: the cache property has no second turn to hold on and was not observed" };
  }
  const violations = [];
  for (let i = 1; i < steps.length; i++) {
    const read = tokens(steps[i].cache_read);
    if (read <= 0) violations.push({ turn: steps[i].turn ?? i + 1, cache_read: read });
  }
  return {
    ok: violations.length === 0, code: violations.length ? "CACHE_MISS" : null,
    checked: steps.length - 1, violations,
    message: violations.length
      ? `${violations.length} of ${steps.length - 1} steps read 0 cached tokens — the preamble drifted, prefix caching never engaged, and the ≥${COST_FACTOR}× claim is VOID regardless of the totals`
      : `all ${steps.length - 1} steps after the first read cached prefix tokens`,
  };
}

// ── gate 4: the cost curve ────────────────────────────────────────────────────────────────────

/**
 * GATE 4 (§8) — per-turn cost flat against turn index, total ≥COST_FACTOR× below the baseline.
 *
 * Reports the ratio it MEASURES. If that comes out at 2×, 2× is the answer and the design has a
 * problem worth knowing about; a bench that only knows how to agree is not a gate. When no row
 * carries a price the ratio is computed on total tokens and says so in `basis`, because tokens are
 * a real measurement and a price derived from a rate card we did not record is not.
 */
export function costGate(steps, baselineRows, opts = {}) {
  const factor = opts.factor ?? COST_FACTOR;
  const minTurns = opts.minTurns ?? MIN_TURNS;
  const run = totals(steps || []);
  const base = totals(baselineRows || []);
  const out = { ok: false, code: null, run, base, turns: run.turns, slope: null, slope_ratio: null, ratio: null, basis: null, message: "" };

  if (run.turns < minTurns) {
    out.code = "TOO_FEW_TURNS";
    out.message = `${run.turns} turns on the state path; §8.4 fits the slope over ≥${minTurns}. A slope over ${run.turns} points is noise, and noise must not pass a gate.`;
    return out;
  }

  const priced = run.cost_usd !== null && base.cost_usd !== null;
  const weights = opts.weights || null;
  if (!priced && !weights) {
    // Rule 1: an unknown is not a pass. No price on either side and no stated weighting means the
    // ratio cannot be computed from anything that was measured, so gate 4 says NO and says why.
    out.code = "NO_COST";
    out.message = `neither the run nor the baseline carries a per-turn price (this CC transcript release records usage but no costUSD), so the ≥${factor}× ratio has no measured basis. Re-run with an explicit weighting (--basis weighted, TOKEN_WEIGHTS) and the report will name the assumption.`;
    return out;
  }
  out.basis = priced ? "cost_usd" : "weighted";
  const weigh = (r) => tokens(r.input) * weights.input + tokens(r.cache_read) * weights.cache_read
    + tokens(r.cache_creation) * weights.cache_creation + tokens(r.output) * weights.output;
  const perTurn = steps.map(s => (priced ? finite(s.cost_usd) : weigh(s)));
  out.slope = fitSlope(perTurn);
  const mean = perTurn.reduce((a, b) => a + (b ?? 0), 0) / perTurn.length;
  out.slope_ratio = out.slope === null || mean === 0 ? null : Math.abs(out.slope) * (perTurn.length - 1) / mean;

  const runTotal = priced ? run.cost_usd : steps.reduce((a, r) => a + weigh(r), 0);
  const baseTotal = priced ? base.cost_usd : (baselineRows || []).reduce((a, r) => a + weigh(r), 0);
  out.ratio = runTotal > 0 ? baseTotal / runTotal : null;

  const slopeOk = out.slope_ratio !== null && out.slope_ratio <= (opts.slopeTolerance ?? SLOPE_TOLERANCE);
  const ratioOk = out.ratio !== null && out.ratio >= factor;
  out.ok = slopeOk && ratioOk;
  if (!slopeOk) out.code = "COST_CURVE";
  else if (!ratioOk) out.code = "COST_RATIO";
  out.message = `basis ${out.basis} · per-turn slope ${out.slope === null ? "n/a" : out.slope.toFixed(4)} (rise ${out.slope_ratio === null ? "n/a" : `${(out.slope_ratio * 100).toFixed(0)}%`} of the mean turn, tolerance ${(opts.slopeTolerance ?? SLOPE_TOLERANCE) * 100}%) · total ${out.ratio === null ? "n/a" : `${out.ratio.toFixed(2)}×`} below baseline (gate ≥${factor}×)`;
  return out;
}

// ── gate 5: the disturbance ───────────────────────────────────────────────────────────────────

/**
 * GATE 5 (§8) — after the card and a file are mutated mid-run, the NEXT step acts on current
 * state: no re-read burst, no invented recovery step.
 *
 * Two assertions, because either alone is cheatable. The token bound catches the burst (a seat
 * that quietly re-read half the worktree), and the action check catches the cheaper failure the
 * bound cannot see: one small `Read` that says the state block did not carry, so the seat went
 * back to the filesystem to find out where it was.
 */
export function disturbanceCheck(steps, opts = {}) {
  const marks = (steps || []).map((s, i) => (s.disturbed ? i : -1)).filter(i => i >= 0);
  if (!marks.length) {
    return { ok: false, code: "NO_DISTURBANCE", cases: [], message: "no step is marked `disturbed` — §8.5 was never exercised on this run, so it did not pass it" };
  }
  const factor = opts.factor ?? DISTURB_INPUT_FACTOR;
  const cases = [];
  for (const i of marks) {
    const next = steps[i + 1];
    if (!next) { cases.push({ at: steps[i].turn ?? i + 1, ok: false, code: "NO_NEXT_STEP", detail: "the run ended at the disturbance — the recovery step was never taken" }); continue; }
    const priorMedian = median(steps.slice(0, i + 1).map(s => tokens(s.input)));
    const bound = priorMedian === null ? null : priorMedian * factor;
    const input = tokens(next.input);
    const tool = next.action && typeof next.action === "object" ? next.action.tool : null;
    const reorient = typeof tool === "string" && READ_TOOLS.includes(tool);
    const burst = bound !== null && input > bound;
    cases.push({
      at: next.turn ?? i + 2, ok: !burst && !reorient && bound !== null,
      code: bound === null ? "NO_BASELINE_INPUT" : burst ? "REREAD_BURST" : reorient ? "REORIENTED" : null,
      input, bound, action: tool || (next.action?.done ? "done" : next.action?.ask ? "ask" : "continue"),
      detail: burst ? `input ${input} > ${factor}× the run's median ${priorMedian}` : reorient ? `next action is a ${tool} — a re-orientation read, which is what "acts on current state" means it must not be` : `input ${input} ≤ bound ${bound}, action ${tool || "not a read"}`,
    });
  }
  const bad = cases.filter(c => !c.ok);
  return { ok: bad.length === 0, code: bad.length ? bad[0].code : null, cases, message: bad.length ? `${bad.length} of ${cases.length} disturbance(s) provoked a re-orientation` : `${cases.length} disturbance(s), each followed by a step that acted on current state` };
}

// ── gate 6: the evidence pipeline, live ───────────────────────────────────────────────────────

/**
 * item → rev, BY REPLAYING THE OPS JOURNAL (§4.4, §8.6).
 *
 * Items carry no `rev` and must not gain one: the journal is one accepted patch per line, in
 * order, each with the rev it produced, which is exactly the information a rev field would have
 * duplicated. Replaying it costs a loop and adds nothing to the schema.
 *
 * An item that leaves `done` loses its rev — it did not land — and one that returns takes the new
 * one, because the evidence that matters is the evidence at the rev it landed on THIS time.
 * @returns {Map<string, number>} id → the rev at which it entered `done`
 */
export function itemRevsFromJournal(journal) {
  const landed = new Map();
  for (const entry of journal || []) {
    const rev = Number.isInteger(entry?.rev) ? entry.rev : null;
    for (const op of Array.isArray(entry?.ops) ? entry.ops : []) {
      if (op?.add?.item?.id !== undefined) {
        if (op.add.list === "done" && rev !== null) landed.set(String(op.add.item.id), rev);
        continue;
      }
      if (op?.remove?.id !== undefined) { landed.delete(String(op.remove.id)); continue; }
      if (op?.move?.id !== undefined) {
        const id = String(op.move.id);
        if (op.move.to === "done" && rev !== null) landed.set(id, rev);
        else landed.delete(id);
      }
    }
  }
  return landed;
}

/**
 * GATE 6 (§8) — the evidence pipeline is live, not theoretical.
 *
 * Three claims, and the third is the one that matters: at least one real gate ran with a
 * `verify.cmd` recorded; every item in `done` has green evidence at the rev it landed on; and at
 * least one `move → done` was REJECTED with a failure tail. A run where nothing was ever rejected
 * has not tested the rule — it has only shown that a green path stays green.
 */
export function evidenceAudit({ state, journal, steps }) {
  const revs = itemRevsFromJournal(journal);
  const byRev = new Map();
  for (const s of steps || []) if (Number.isInteger(s.rev)) byRev.set(s.rev, s);

  const items = [];
  for (const item of state?.done || []) {
    const rev = revs.get(String(item.id));
    if (rev === undefined) { items.push({ id: item.id, ok: false, code: "NO_REV", detail: "no accepted patch in the journal ring puts this item in `done` — its landing cannot be audited, and an unaudited done is not a pass" }); continue; }
    const step = byRev.get(rev);
    if (!step) { items.push({ id: item.id, ok: false, code: "NO_STEP", rev, detail: `journal says rev ${rev}, but no run step recorded that rev` }); continue; }
    const exit = finite(step.verify?.exit);
    if (!step.verify?.cmd || exit !== 0) { items.push({ id: item.id, ok: false, code: "NO_GREEN_GATE", rev, detail: `rev ${rev} carries ${step.verify?.cmd ? `exit ${exit}` : "no verify.cmd"}` }); continue; }
    const credited = new Set(step.verified_paths || []);
    const missing = (item.paths || []).filter(p => !credited.has(p));
    items.push(missing.length
      ? { id: item.id, ok: false, code: "UNCREDITED_PATH", rev, detail: `rev ${rev} verified ${[...credited].join(",") || "nothing"}; the item cites ${missing.join(",")}` }
      : { id: item.id, ok: true, rev });
  }

  const gatesRan = (steps || []).filter(s => s.verify?.cmd).length;
  const rejections = (steps || []).filter(s => EVIDENCE_CODES.includes(s.rejected?.code));
  const bad = items.filter(i => !i.ok);
  const ok = gatesRan > 0 && rejections.length > 0 && bad.length === 0;
  return {
    ok, items, gates_ran: gatesRan, rejections: rejections.length,
    code: gatesRan === 0 ? "NO_GATE_RAN" : rejections.length === 0 ? "NEVER_REJECTED" : bad.length ? bad[0].code : null,
    message: gatesRan === 0 ? "no step recorded a verify.cmd — the gate never ran, so nothing here was verified"
      : rejections.length === 0 ? "nothing was ever rejected: the negative half of §8.6 was not exercised, and a rule that never said no has not been tested"
      : bad.length ? `${bad.length} of ${items.length} done items lack green evidence at the rev they landed on`
      : `${items.length} done items each verified at their landing rev · ${gatesRan} gate runs · ${rejections.length} evidence rejections`,
  };
}

// ── §7.3: malformed output vs a red gate ──────────────────────────────────────────────────────

/** Which budget a seat is held to: what its CLI can enforce, not how good we think it is. */
export function seatClass(seat) {
  return /(^|[:/-])claude\b/.test(String(seat || "")) ? "enforced" : "prompt";
}

/**
 * §7.3 / §8 — the invalid-patch budget, with the two classes reported SEPARATELY.
 *
 * `UNVERIFIED_DONE` and `NEEDS_GATE` are not malformed output: the patch was well-formed and the
 * CODE was wrong, which is the system working. Counting them would trip the circuit breaker on the
 * healthiest seat there is — one writing perfect patches against a failing test — and drop it back
 * to the transcript path precisely when the evidence loop is doing its job. Hence two columns.
 *
 * A record is `{seat, code, retry_code, class?}`; the budget is measured AFTER one retry, so a
 * record that failed once and passed on the retry is not an invalid patch.
 */
export function classifyPatches(records) {
  const classes = { enforced: null, prompt: null };
  for (const rec of records || []) {
    const cls = rec.class === "enforced" || rec.class === "prompt" ? rec.class : seatClass(rec.seat);
    const c = classes[cls] ||= { class: cls, turns: 0, malformed: 0, evidence: 0, recovered: 0, by_code: {}, budget: PATCH_BUDGET[cls] };
    c.turns++;
    const final = "retry_code" in rec ? rec.retry_code : rec.code;
    const first = rec.code ?? null;
    if (EVIDENCE_CODES.includes(final)) { c.evidence++; c.by_code[final] = (c.by_code[final] || 0) + 1; continue; }
    if (MALFORMED_CODES.includes(final)) { c.malformed++; c.by_code[final] = (c.by_code[final] || 0) + 1; continue; }
    if (MALFORMED_CODES.includes(first)) c.recovered++;   // malformed once, well-formed on the retry
  }
  const out = [];
  for (const c of Object.values(classes)) {
    if (!c) continue;
    c.rate = c.turns ? c.malformed / c.turns : 0;
    c.ok = c.rate <= c.budget;
    out.push(c);
  }
  return { classes: out, ok: out.length > 0 && out.every(c => c.ok), code: out.length ? (out.every(c => c.ok) ? null : "OVER_BUDGET") : "NO_RECORDS" };
}

// ── Phase 1: the handoff field-drop gate ──────────────────────────────────────────────────────

/**
 * The set of FIELDS an object carries, as dotted paths. Dynamic key spaces (`files`, `ext`) can
 * collapse to a `*` segment: when the comparison object has to be re-derived at audit time, git
 * has moved since the handoff and a literal path diff would report every changed file as a
 * "dropped field", which is noise dressed as a failure. The shape is what #6528 threatened and
 * what this gate is for.
 */
export function fieldPaths(obj, { collapse = [], prefix = "" } = {}) {
  const out = new Set();
  const walk = (node, path) => {
    if (node === null || typeof node !== "object") { out.add(path); return; }
    if (Array.isArray(node)) { out.add(path); for (const el of node) walk(el, `${path}[]`); return; }
    for (const [k, v] of Object.entries(node)) {
      const seg = collapse.includes(path) ? "*" : k;
      walk(v, path ? `${path}.${seg}` : seg);
    }
  };
  walk(obj, prefix);
  out.delete("");
  return out;
}

/**
 * §8 Phase 1 — 10 real handoffs carry a schema-valid STATE with 0 dropped fields.
 *
 * Two ways to fail, and one deliberate STRICTNESS. §8 says exit non-zero on a null `state` where
 * the seat had a card and a dirty worktree; the record does not store its card, so this checks
 * `gitStatus` alone — a dirty worktree with no state fails. That is stricter than §8, which is the
 * safe direction for a falsification tool: it can accuse a clean case, never excuse a real drop.
 */
export function handoffAudit(records, { readSource } = {}) {
  const results = [];
  for (const rec of records || []) {
    const id = rec?.id || "(unnamed)";
    if (!rec || rec.state === undefined) { results.push({ id, ok: false, code: "NO_STATE_FIELD", detail: "record predates the §4.5 field, or was written with TRANTOR_STATE_HANDOFF off" }); continue; }
    if (rec.state === null) {
      const dirty = Boolean(String(rec.gitStatus || "").trim());
      results.push(dirty
        ? { id, ok: false, code: "STATE_NULL_DIRTY", detail: "state is null while the worktree was dirty at handoff — there was work to carry and none of it was carried" }
        : { id, ok: true, code: "STATE_NULL_CLEAN", detail: "state is null on a clean worktree — nothing to carry" });
      continue;
    }
    const why = stateError(rec.state);
    if (why) { results.push({ id, ok: false, code: "SCHEMA", detail: why }); continue; }
    const src = readSource ? readSource(rec) : null;
    if (!src || !src.state) { results.push({ id, ok: true, code: "NO_SOURCE", detail: "state validates; the writer's object could not be reconstructed, so no field diff was possible" }); continue; }
    const collapse = src.derived ? ["files", "ext"] : [];
    const want = fieldPaths(src.state, { collapse });
    const got = fieldPaths(rec.state, { collapse });
    const dropped = [...want].filter(p => !got.has(p));
    results.push(dropped.length
      ? { id, ok: false, code: "FIELD_DROP", dropped, detail: `${dropped.length} field(s) in the ${src.derived ? "derived" : "sidecar"} object are absent from rec.state: ${dropped.slice(0, 8).join(", ")}` }
      : { id, ok: true, code: null, detail: `field set matches the ${src.derived ? "derived" : "sidecar"} object${src.derived ? " (dynamic keys collapsed — see fieldPaths)" : ""}` });
  }
  const bad = results.filter(r => !r.ok);
  return { ok: results.length > 0 && bad.length === 0, checked: results.length, failed: bad.length, results, code: results.length ? (bad.length ? bad[0].code : null) : "NO_RECORDS" };
}

// ── §8.7: turns per card before a forced cut ──────────────────────────────────────────────────

/** Turns up to the FIRST forced cut. No cut means the card ran to its own end, which counts as the
 *  full length — the metric is "how far does a card get", and getting all the way is the best
 *  possible score, not a missing measurement. */
export function turnsBeforeCut(rows) {
  const cut = (rows || []).findIndex(r => r?.cut === true);
  return cut >= 0 ? cut : (rows || []).length;
}

/**
 * §8.7 — median turns-per-card on the state path vs the baseline path, over n ≥ MIN_CARDS.
 *
 * With fewer cards the gate CARRIES FORWARD: the number is recorded and the gate stays open into
 * the next phase. It does not pass. One card is an anecdote, and a metric that can be satisfied by
 * an anecdote is not a gate — so "not enough data" exits non-zero like any other unknown.
 */
export function turnsGate(pairs, { minCards = MIN_CARDS } = {}) {
  const usable = (pairs || []).filter(p => p.state?.length && p.baseline?.length)
    .map(p => ({ card: p.card, state: turnsBeforeCut(p.state), baseline: turnsBeforeCut(p.baseline) }));
  const out = { cards: usable, n: usable.length, state_median: median(usable.map(u => u.state)), baseline_median: median(usable.map(u => u.baseline)), ok: false, code: null, message: "" };
  if (usable.length < minCards) {
    out.code = "CARRY_FORWARD";
    out.message = `n=${usable.length} card(s) with both paths recorded; §8.7 wants ≥${minCards}. The medians are recorded on the card and this gate CARRIES FORWARD to the next phase — it is not waived.`;
    return out;
  }
  out.ok = out.state_median >= out.baseline_median;
  out.code = out.ok ? null : "FEWER_TURNS";
  out.message = `median turns before a forced cut — state ${out.state_median} vs baseline ${out.baseline_median} over n=${usable.length}`;
  return out;
}

// ── the Phase-2a verdict ──────────────────────────────────────────────────────────────────────

/** Every §8 Phase-2a check, in order, over what is actually recorded. Gate 1 first and fatal. */
export function evaluateRun({ project, card, repo = REPO, ...opts }) {
  const gates = [];
  const base = requireBaseline({ project, card, repo });
  gates.push({ n: 1, name: "baseline committed (§7.5)", ok: base.ok, code: base.code ?? null, message: base.ok ? `${base.doc} in HEAD · ${base.rows.length} baseline turns` : base.message });
  if (!base.ok) return { ok: false, gates, halted: "gate 1", project, card };

  const steps = readJsonl(runPath(project, card));
  if (!steps || !steps.length) {
    gates.push({ n: 2, name: "state-mode run recorded", ok: false, code: "NO_RUN", message: `no run steps at ${runPath(project, card)} — the state-mode driver (P6) has not recorded a run for this card, so there is nothing to measure. This is an UNKNOWN, and an unknown is not a pass.` });
    return { ok: false, gates, halted: "no run", project, card, baseline: base };
  }
  gates.push({ n: 2, name: "state-mode run recorded", ok: true, code: null, message: `${steps.length} steps at ${runPath(project, card)}` });

  const cache = checkCache(steps);
  gates.push({ n: 3, name: "cache read > 0 after the first step (§8.3)", ok: cache.ok, code: cache.code, message: cache.message });

  const cost = costGate(steps, base.rows, { weights: opts.weights || null });
  gates.push({ n: 4, name: `cost: flat curve, ≥${COST_FACTOR}× below baseline (§8.4)`, ok: cost.ok, code: cost.code, message: cost.message, numbers: cost });

  const dist = disturbanceCheck(steps);
  gates.push({ n: 5, name: "zero recovery after a mid-run disturbance (§8.5)", ok: dist.ok, code: dist.code, message: dist.message, cases: dist.cases });

  const seat = steps.find(s => s.by)?.by || "";
  const state = readState(seat, card, { project, recover: false });
  const ev = state.ok
    ? evidenceAudit({ state: state.state, journal: readJournal(seat, card, project), steps })
    : { ok: false, code: "NO_SIDECAR", message: `no readable sidecar for ${seat || "(unknown seat)"} on card ${card}: ${state.message || "the run recorded no seat"}` };
  gates.push({ n: 6, name: "evidence pipeline live (§8.6)", ok: ev.ok, code: ev.code, message: ev.message, items: ev.items });

  // §8.4's "at equal-or-better task success": the cache claim can hold while the card gets less far.
  const turns = turnsGate(collectTurnPairs(project));
  gates.push({ n: 7, name: `turns per card, median over n≥${MIN_CARDS} (§8.7)`, ok: turns.ok, code: turns.code, message: turns.message, numbers: turns });

  return { ok: gates.every(g => g.ok), gates, project, card, baseline: base, steps: steps.length };
}

/** Every card with a recorded run, paired with its baseline, for §8.7. */
export function collectTurnPairs(project) {
  const dir = join(busDir(), "state", "runs");
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const pairs = [];
  for (const n of names) {
    const m = new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.jsonl$`).exec(n);
    if (!m) continue;
    const card = Number(m[1]);
    pairs.push({ card, state: readJsonl(join(dir, n)) || [], baseline: readJsonl(baselinePath(project, card)) || [] });
  }
  return pairs;
}

// ── the report ────────────────────────────────────────────────────────────────────────────────

export function renderReport(verdict) {
  const L = [];
  L.push(`# State bench — ${verdict.project} card ${verdict.card}`);
  L.push("");
  L.push(`${new Date().toISOString()} · verdict **${verdict.ok ? "PASS" : "NO"}**${verdict.halted ? ` (halted at ${verdict.halted})` : ""}`);
  L.push("");
  L.push("| # | gate | verdict | what was measured |");
  L.push("|---:|---|---|---|");
  for (const g of verdict.gates) {
    L.push(`| ${g.n} | ${g.name} | ${g.ok ? "pass" : `**NO** (${g.code || "fail"})`} | ${String(g.message).replace(/\n/g, " ").replace(/\|/g, "\\|")} |`);
  }
  const cost = verdict.gates.find(g => g.n === 4)?.numbers;
  if (cost) {
    L.push("");
    L.push("| | turns | cost usd | input | output | cache read | cache creation |");
    L.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const [label, t] of [["baseline", cost.base], ["state", cost.run]]) {
      L.push(`| ${label} | ${t.turns} | ${t.cost_usd == null ? "n/a" : t.cost_usd.toFixed(4)} | ${t.input} | ${t.output} | ${t.cache_read} | ${t.cache_creation} |`);
    }
    L.push("");
    L.push(`Ratio measured on **${cost.basis}**: ${cost.ratio === null ? "n/a" : `${cost.ratio.toFixed(2)}×`} below baseline (gate ≥${COST_FACTOR}×).`);
  }
  L.push("");
  L.push("Numbers as measured. A gate reading NO is this file doing its job.");
  return `${L.join("\n")}\n`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (...f) => f.some(x => argv.includes(x));
const val = (...f) => { for (const x of f) { const i = argv.indexOf(x); if (i >= 0) return argv[i + 1]; } return undefined; };

const die = (msg, code = 1) => { process.stderr.write(`${msg}\n`); process.exit(code); };
const out = (s) => process.stdout.write(`${s}\n`);

function requireCard() {
  const raw = val("--card");
  const card = Number(raw);
  if (!Number.isInteger(card) || card < 0) die(`--card <id> is required and must be a non-negative integer, got ${JSON.stringify(raw)}`, 2);
  return card;
}

function cmdBaseline(project, repo) {
  const card = requireCard();
  const transcript = val("--transcript");
  if (!transcript) die("--baseline needs --transcript <cc-transcript.jsonl>: the baseline is MEASURED off the current path, never estimated", 2);
  const unit = val("--unit") || "call";
  if (!["call", "prompt"].includes(unit)) die(`--unit is call (one model call, the default and the unit §8.4 compares against) or prompt (one wake), got ${JSON.stringify(unit)}`, 2);
  const rows = perTurnFromTranscript(resolve(transcript), { unit });
  if (rows === null) die(`cannot read the transcript at ${transcript}`, 1);
  if (!rows.length) die(`${transcript} has no assistant usage rows — nothing to measure, and an empty baseline would make every later ratio infinite`, 1);
  const jsonl = baselinePath(project, card);
  mkdirSync(dirname(jsonl), { recursive: true, mode: 0o700 });
  writeFileSync(jsonl, rows.map(r => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  const doc = baselineDoc(card, repo);
  mkdirSync(dirname(doc), { recursive: true });
  writeFileSync(doc, baselineMarkdown({ project, card, transcript: resolve(transcript), rows, capturedAt: Date.now(), unit }));
  const t = totals(rows);
  out(`baseline captured for ${project} card ${card}`);
  out(`  ${rows.length} turns (unit: one ${unit === "call" ? "model call" : "wake"}) · cost ${t.cost_usd == null ? "n/a (no costUSD rows)" : `$${t.cost_usd.toFixed(4)}`} · in ${t.input} · out ${t.output} · cache_read ${t.cache_read}`);
  out(`  rows: ${jsonl}`);
  out(`  table: ${doc}`);
  out(`\nCOMMIT ${doc.startsWith(`${repo}/`) ? doc.slice(repo.length + 1) : doc} — until it is in HEAD, --run refuses to measure anything (§7.5).`);
}

async function cmdDisturb(project) {
  const card = requireCard();
  const file = val("--file");
  if (!file) die("--disturb needs --file <path>: it mutates a real file under the seat, and inventing which one is not the bench's call", 2);
  const target = resolve(file);
  if (!existsSync(target)) die(`no file at ${target} — refusing to create one, the disturbance is a MUTATION of live work`, 2);
  const path = runPath(project, card);
  const steps = readJsonl(path);
  if (!steps || !steps.length) die(`no run in progress at ${path} — a disturbance with nothing to disturb measures nothing`, 1);

  const stamp = `\n// state-bench disturbance ${new Date().toISOString()} (§8.5) — this line is the mutation\n`;
  appendFileSync(target, stamp);
  const { signedPost } = await import("../hooks/lib/api.mjs");
  const note = `state-bench: §8.5 disturbance injected at turn ${steps.length} — the card moved under the run on purpose.`;
  const r = await signedPost("/task/update", { id: card, project, note }, { project, timeoutMs: 8000 }).catch(e => ({ ok: false, status: 0, error: e.message }));
  appendJsonl(path, { turn: steps.length + 1, ts: Date.now(), disturbed: true, note: "marker only — the driver overwrites this row's measurements on the next real step", file: target, card_note_posted: Boolean(r.ok) });
  out(`disturbance injected at turn ${steps.length}:`);
  out(`  file  ${target} (one appended line)`);
  out(`  card  ${r.ok ? `note posted to #${card}` : `note NOT posted (hub ${r.status ?? 0}) — the file half stands, the card half did not`}`);
  out(`  mark  ${path}`);
  if (!r.ok) process.exit(1);
}

function cmdPatches(project) {
  const from = val("--from") ? resolve(val("--from")) : patchesPath(project);
  const records = readJsonl(from);
  if (records === null) die(`no turn-result records at ${from} — the §7.3 budget is a MEASUREMENT and there is nothing to measure yet`, 1);
  const r = classifyPatches(records);
  out(`§7.3 invalid-patch budget · ${records.length} turn results · ${from}\n`);
  for (const c of r.classes) {
    out(`  ${c.class} seats — ${c.turns} turns`);
    out(`    malformed after one retry : ${c.malformed}  (${(c.rate * 100).toFixed(1)}% · budget ${(c.budget * 100).toFixed(0)}%)  ${c.ok ? "within budget" : "OVER BUDGET"}`);
    out(`    recovered on the retry    : ${c.recovered}`);
    out(`    red gate, well-formed     : ${c.evidence}  (UNVERIFIED_DONE / NEEDS_GATE — NOT counted, §7.3: the code was wrong, the grammar was not)`);
    const codes = Object.entries(c.by_code).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" · ");
    if (codes) out(`    by code                   : ${codes}`);
    out("");
  }
  process.exit(r.ok ? 0 : 1);
}

function cmdHandoffs(project) {
  const n = Number(val("--handoffs")) || 10;
  const dir = handoffDir();
  const files = (existsSync(dir) ? readdirSync(dir) : []).filter(f => f.endsWith(".json"))
    .map(f => ({ f, p: join(dir, f) }))
    .sort((a, b) => b.f.localeCompare(a.f)).slice(0, n);
  const records = [];
  for (const { p } of files) {
    try { records.push(JSON.parse(readFileSync(p, "utf8"))); } catch { /* an unreadable record is not a state drop */ }
  }
  if (!records.length) die(`no handoff records under ${dir} — nothing to audit`, 1);

  const r = handoffAudit(records, {
    readSource: (rec) => {
      const name = rec.projectName || project;
      const seat = rec.state?.cursor?.by || "";
      const card = Number.isInteger(rec.state?.card) ? rec.state.card : 0;
      if (!seat) return null;
      const sidecar = statePath(seat, card, name);
      if (sidecar && existsSync(sidecar)) {
        const s = readState(seat, card, { project: name, recover: false });
        return s.ok ? { state: s.state, derived: false } : null;
      }
      const derived = deriveState({ project: name, seat, card, worktree: rec.project || "", handoffText: rec.summary || "" });
      return derived ? { state: derived, derived: true } : null;
    },
  });
  out(`Phase-1 handoff audit · ${r.checked} records · ${dir}\n`);
  for (const res of r.results) out(`  ${res.ok ? "ok  " : "DROP"}  ${res.id}\n          ${res.code || "clean"}: ${res.detail}`);
  out(`\n${r.checked} checked, ${r.failed} failed`);
  process.exit(r.ok ? 0 : 1);
}

function cmdTurns(project) {
  const r = turnsGate(collectTurnPairs(project));
  out(`§8.7 turns per card before a forced cut · ${project}\n`);
  for (const c of r.cards) out(`  card ${c.card}  state ${c.state}  baseline ${c.baseline}`);
  out(`\n${r.message}`);
  process.exit(r.ok ? 0 : 1);
}

function cmdRun(project, repo, { report = false } = {}) {
  const card = requireCard();
  const basis = val("--basis");
  if (basis && basis !== "weighted") die(`--basis takes only "weighted" — the measured price is used whenever the rows carry one, and nothing else is invented`, 2);
  const verdict = evaluateRun({ project, card, repo, weights: basis === "weighted" ? TOKEN_WEIGHTS : null });
  for (const g of verdict.gates) {
    out(`  ${g.ok ? "pass" : " NO "}  ${g.n}. ${g.name}`);
    out(`          ${g.message}`);
  }
  out(`\n${project} card ${card}: ${verdict.ok ? "Phase-2a gate PASSES" : `Phase-2a gate says NO${verdict.halted ? ` — halted at ${verdict.halted}` : ""}`}`);
  if (report) {
    const dir = join(repo, ".agent-bus-out");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `state-bench-${card}.md`);
    const md = renderReport(verdict);
    writeFileSync(path, md);
    out(`\n${md}`);
    out(`written: ${path}`);
  }
  process.exit(verdict.ok ? 0 : 1);
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; } catch { return false; } })();

if (isMain) {
  const project = val("--project") || resolveProject(process.cwd());
  // Where the COMMITTED artifact lives and whose HEAD gate 1 reads. Defaults to this checkout; a
  // test drives the pre-condition against a temp repo through it, which is the only way to prove
  // the refusal without committing a fixture into the real history.
  const repo = val("--repo") ? resolve(val("--repo")) : REPO;
  if (has("--baseline")) cmdBaseline(project, repo);
  else if (has("--report")) cmdRun(project, repo, { report: true });
  else if (has("--run")) cmdRun(project, repo);
  else if (has("--disturb")) await cmdDisturb(project);
  else if (has("--patches")) cmdPatches(project);
  else if (has("--handoffs")) cmdHandoffs(project);
  else if (has("--turns")) cmdTurns(project);
  else {
    out(`trantor state-bench — the measurements that make the ≥${COST_FACTOR}× claim falsifiable (project: ${project})

  --baseline --card <id> --transcript <p>   measure the CURRENT path and write the committed artifact
  --run --card <id>                         the §8 Phase-2a gate, in order, gate 1 fatal
  --report --card <id>                      the same, plus the comparison table into .agent-bus-out/
  --disturb --card <id> --file <p>          inject the §8.5 mid-run disturbance and mark the run
  --patches [--from <jsonl>]                §7.3 budget: malformed output vs a red gate, separately
  --handoffs <n>                            Phase-1: n handoffs carry a schema-valid, undropped state
  --turns                                   §8.7 median turns per card before a forced cut

  --project <name>   measure another project (default: the cwd's)
  --repo <dir>       the checkout whose HEAD carries the baseline artifact (default: this one)
  --unit call|prompt one baseline row = one model call (default) or one wake
  --basis weighted   when no row carries a price, weight tokens by TOKEN_WEIGHTS and SAY SO;
                     without it an unpriced comparison is NO_COST, not a number

Every gate has three outcomes: pass, fail, and could-not-be-evaluated — and the third exits
non-zero like the second. Nothing here estimates a number it did not measure.`);
    process.exit(argv.length ? 2 : 0);
  }
}
