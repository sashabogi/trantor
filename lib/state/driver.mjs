/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this module decodes what a CLI printed —
   a `claude -p --output-format json` envelope whose shape shifts between releases — and the ctx
   facts a driver hands the pure core. Both are boundaries: a typeof here is the decode, not a
   guess about a value we own. */
// Trantor State P6: the runner-side driver (TDD §4.1, §4.8, §7.3). The runner is not importable,
// so the step logic lives here and the runner keeps the wiring. This file IS the §4.1 ORDER:
// readState → assemble → run CLI → tier 1 → applyTurn → commit (CAS) → promote → execute(action),
// recorded in `trace` so test-runner-state.mjs asserts it. A rejected patch stops at applyTurn.
import { CAPS, ERR, MALFORMED_CODES, LISTS } from "./schema.mjs";
import { applyTurn } from "./apply.mjs";
import { assemble } from "./assemble.mjs";
import { runGate } from "./gate.mjs";
import { promote } from "./promote.mjs";
import { commit, gitTouched, hashPaths, readState, STALE } from "./store.mjs";
import { fromEnvelope } from "./cost.mjs";
// Paths and budgets belong to §7.3/§7.5 and P7 published them in bin/state-bench.mjs. Importing
// upward is the deliberate layering inversion: no number has a second home. Its dispatch is guarded.
import { PATCH_BUDGET, appendJsonl, patchesPath, runPath, seatClass } from "../../bin/state-bench.mjs";

/** The flag. Absent or not "1" = the transcript path, byte for byte (§4.6). */
export const STATE_ENV = "TRANTOR_STATE_ASSEMBLE";

/** §7.3's window: the rolling invalid rate is measured over a seat's last 20 turns. */
export const BREAKER_WINDOW = 20;

// Paths and budgets belong to §7.3/§7.5 and P7 published them in bin/state-bench.mjs: importing
// upward is the deliberate layering inversion, because no number has a second home.
export const TURN_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["patch", "action"],
  properties: {
    patch: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          set: {
            type: "object", additionalProperties: false, required: ["field", "value"],
            properties: { field: { type: "string" }, value: {} },
          },
          add: {
            type: "object", additionalProperties: false, required: ["list", "item"],
            properties: {
              list: { type: "string", enum: [...LISTS] },
              item: {
                type: "object", additionalProperties: false, required: ["id", "text"],
                properties: {
                  id: { type: "string", maxLength: CAPS.ID },
                  text: { type: "string" },
                  paths: { type: "array", maxItems: CAPS.ITEM_PATHS, items: { type: "string", maxLength: CAPS.PATH } },
                },
              },
            },
          },
          remove: {
            type: "object", additionalProperties: false, required: ["list", "id"],
            properties: { list: { type: "string", enum: [...LISTS] }, id: { type: "string", maxLength: CAPS.ID } },
          },
          move: {
            type: "object", additionalProperties: false, required: ["id", "from", "to"],
            properties: {
              id: { type: "string", maxLength: CAPS.ID },
              from: { type: "string", enum: [...LISTS] },
              to: { type: "string", enum: [...LISTS] },
            },
          },
        },
      },
    },
    action: {
      type: "object",
      additionalProperties: false,
      properties: {
        done: { type: "boolean" },
        ask: { type: "string" },
        continue: { type: "boolean" },
      },
    },
  },
};

/**
 * Whether the installed CLI can enforce the grammar (§6: probed, not assumed). No flag = state
 * mode stays OFF. @param {(cmd: string, args: string[]) => {status:number|null, stdout:string}} run
 */
export function hasJsonSchemaFlag(run, bin = "claude") {
  let r;
  try { r = run(bin, ["--help"]); } catch { return false; }
  if (!r || typeof r.stdout !== "string") return false;
  return r.stdout.includes("--json-schema");
}

/**
 * Parse the `--output-format json` envelope into the cost struct and the TurnResult. Anything
 * unreadable is `turn: null` with a reason, never a guessed empty patch.
 */
export function parseEnvelope(text) {
  const out = { envelope: null, cost: null, turn: null, error: "" };
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) { out.error = "the CLI printed nothing on stdout — no envelope to read"; return out; }
  // A CLI may print a line of its own before the JSON; take the last balanced object on the stream.
  const at = raw.indexOf("{");
  let env = null;
  if (at >= 0) { try { env = JSON.parse(raw.slice(at)); } catch { env = null; } }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    out.error = `stdout is not a JSON envelope: ${raw.slice(0, 200)}`;
    return out;
  }
  out.envelope = env;
  out.cost = fromEnvelope(env);
  let result = env.result;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { result = null; }
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    out.error = env.is_error
      ? `the CLI reported an error envelope (subtype ${String(env.subtype || "unknown")})`
      : "the envelope carries no structured result — the schema was not enforced on this run";
    return out;
  }
  out.turn = result;
  return out;
}

/** One line naming what a step asked for, for the runner's window (§4.6's UX mitigation: the
 *  operator sees a sentence instead of a JSON blob). Decoding lives here, at the boundary, so the
 *  runner stays wiring. */
export function describeTurn(turn) {
  if (!turn || typeof turn !== "object") return "no TurnResult";
  const ops = Array.isArray(turn.patch) ? turn.patch.length : 0;
  const act = turn.action && typeof turn.action === "object" && !Array.isArray(turn.action)
    ? (Object.keys(turn.action)[0] || "none") : "none";
  return `${ops} op(s), action ${act}`;
}

/**
 * The card log a state step is read against (§4.1's `tail`), decoded from GET /tasks. Note rows
 * are a string on old records and `{by, text}` on current ones; "" when the card is absent. Pure.
 */
export function renderCardTail(rows, card) {
  const list = Array.isArray(rows) ? rows : [];
  const row = list.find(t => t && Number(t.id) === Number(card));
  if (!row) return "";
  const notes = Array.isArray(row.notes) ? row.notes : [];
  const lines = notes.map((n) => {
    if (typeof n === "string") return n;
    if (!n || typeof n !== "object") return "";
    return `${n.by || "?"}: ${n.text ?? n.note ?? ""}`;
  }).filter(Boolean);
  return [`#${row.id} ${row.title || ""} · ${row.status || ""}`, ...lines].join("\n");
}

/**
 * TIER 1 (§4.8), the live half of R12: `touched` from git, and every credited path RE-HASHED with
 * the credit dropped where the blob moved. Never sets `verified: true`. @returns ctx.files
 */
export function tier1Files(state, cwd, deps = {}) {
  const touch = deps.gitTouched || gitTouched;
  const hash = deps.hashPaths || hashPaths;
  const files = {};
  for (const p of touch(cwd)) {
    if (typeof p !== "string" || !p || p.length > CAPS.PATH) continue;
    files[p] = { touched: true };
  }
  const held = state && state.files && typeof state.files === "object" ? state.files : {};
  const credited = Object.keys(held).filter(p => held[p] && held[p].verified === true);
  if (!credited.length) return files;
  const shas = hash(credited, cwd);
  for (const p of credited) {
    const sha = shas && typeof shas.get === "function" ? (shas.get(p) ?? null) : null;
    if (sha !== null && sha === held[p].hash) continue;
    // `verified:false` is enough — apply.mjs deletes the stale hash with the credit, so the driver
    // never has to name the field it is clearing twice.
    files[p] = { ...(files[p] || {}), verified: false };
  }
  return files;
}

/** Gate facts layered over tier-1 facts. The gate ran after tier 1 with no CLI in between, so the
 *  touched sets agree; where they name the same path the gate is the later and better-informed
 *  writer, and where only tier 1 spoke its expiry survives. */
export function mergeFiles(base, over) {
  const out = { ...(base || {}) };
  for (const [p, fact] of Object.entries(over || {})) out[p] = { ...(out[p] || {}), ...fact };
  return out;
}

/**
 * §7.3's circuit breaker over the recorded patch outcomes. Counts MALFORMED only (UNVERIFIED_DONE
 * and NEEDS_GATE are the system working). The window must be FULL before it can trip.
 */
export function breakerVerdict(records, seat, { window = BREAKER_WINDOW } = {}) {
  const cls = seatClass(seat);
  const budget = PATCH_BUDGET[cls];
  const mine = (records || []).filter(r => r && (r.class ? r.class === cls : seatClass(r.seat) === cls));
  const recent = mine.slice(-window);
  let malformed = 0;
  for (const rec of recent) {
    const final = "retry_code" in rec ? rec.retry_code : rec.code;
    if (MALFORMED_CODES.includes(final)) malformed++;
  }
  const rate = recent.length ? malformed / recent.length : 0;
  const full = recent.length >= window;
  return {
    tripped: full && rate > budget,
    rate, budget, malformed, turns: recent.length, window, class: cls,
    message: full
      ? `${malformed} malformed of the last ${recent.length} turns = ${(rate * 100).toFixed(0)}% against a ${(budget * 100).toFixed(0)}% budget`
      : `${recent.length}/${window} turns recorded — the rolling window is not full, so the breaker cannot speak yet`,
  };
}

/** The observation the NEXT step opens with. A rejection is written for a model to act on, so it is
 *  handed over verbatim; a red gate's tail rides with it, because the useful next step begins with
 *  the failing assertion (§4.8). */
export function rejectionObservation(rejection) {
  if (!rejection) return "";
  const lines = [`Your last patch was REJECTED (${rejection.code} at ${rejection.at}).`, rejection.message];
  if (rejection.gate && typeof rejection.gate === "object" && rejection.gate.tail) {
    lines.push(`\nThe gate ran and came back red (${rejection.gate.cmd || "no cmd"}, exit ${rejection.gate.exit}):\n${rejection.gate.tail}`);
  }
  return lines.join("\n");
}

/**
 * ONE STEP, in the §4.1 order. `deps` lets a test inject every side effect and read `trace` back;
 * deps.executeAction runs LAST, after promote, only on an accepted patch.
 */
export async function runStep({
  seat, card, project, cwd,
  preamble = "", tail = "", observation = "",
  promoted,
  now = Date.now(),
  cut = false,
  disturbed = false,
  deps = {},
}) {
  const D = {
    readState, commit, applyTurn, runGate, promote, assemble,
    gitTouched, hashPaths, appendJsonl,
    callCli: async () => ({ exit: 1, stdout: "" }),
    executeAction: () => undefined,
    ...deps,
  };
  const trace = [];
  const fail = (code, message, extra = {}) => ({
    ok: false, trace, code, message, state: null, action: null,
    observation: message, promoted, step: null, patchRecord: null, ...extra,
  });

  // ---- 1. read (+ migrate + recover) ----
  trace.push("readState");
  const read = D.readState(seat, card, { project, cwd, by: seat, agent: seat });
  if (!read.ok) return fail(read.code, read.message);
  const state = read.state;
  const expectedRev = state.rev;

  // The turn-level ctx facts every applyTurn call in this step shares. `promoted` is last turn's
  // confirmed note hash, carried forward here so it lands through the single apply point (§4.7).
  const baseCtx = { now, by: seat };
  if (promoted !== undefined) baseCtx.promoted = promoted;

  let attempt = 0;
  let obs = observation;
  let accepted = null;
  let acceptedTurn = null;   // the TurnResult that produced `accepted` — the journal and the
                             // STALE re-apply both need the patch itself, and reading it off the
                             // ApplyResult is not possible: applyTurn returns state, not its input.
  let rejection = null;
  let first = null;          // the FIRST attempt's code — §7.3 measures the budget after one retry
  let cost = null;
  let exit = 1;
  let ctx = { ...baseCtx };
  let gateRun = null;
  // Whether the CLI was CUT at the time box. It is the transport that knows, so the transport says
  // so on the way back rather than the caller guessing before the turn has run (§8.7 reads it).
  let stepCut = cut === true;

  // §7.3's fallback ladder: a MALFORMED patch earns exactly one retry, with the rejection message
  // as the observation. An EVIDENCE rejection is not retried in-turn — the code was wrong, not the
  // grammar, and the seat needs a whole step to fix the code (§4.8).
  for (;;) {
    // ---- 2. assemble ----
    trace.push("assemble");
    const prompt = D.assemble({ preamble, state, tail, observation: obs });

    // ---- 3. run the CLI ----
    trace.push("cli");
    const run = await D.callCli(prompt, { attempt });
    exit = run && Number.isInteger(run.exit) ? run.exit : 1;
    if (run && run.cut === true) stepCut = true;
    const parsed = parseEnvelope(run ? run.stdout : "");
    if (parsed.cost) cost = parsed.cost;

    // ---- 4. TIER 1: git touch + credit expiry, EVERY turn, before the apply ----
    trace.push("tier1");
    const files = tier1Files(state, cwd, D);
    ctx = { ...baseCtx, files };

    if (!parsed.turn) {
      // No structured result at all. That is malformed output of the loudest kind, and it takes
      // the same ladder — one retry, then recorded, never a silently empty patch.
      rejection = { ok: false, code: ERR.SCHEMA, at: "envelope", message: parsed.error };
    } else {
      // ---- 5. applyTurn ----
      trace.push("applyTurn");
      let r = D.applyTurn(state, parsed.turn, ctx);

      // ---- 5a. the NEEDS_GATE cure: run the gate ONCE, re-enter with ctx.gate_attempted ----
      // Bounded at one BY CONSTRUCTION: no branch reachable with gate_attempted set returns
      // NEEDS_GATE, so this is an `if`, never a loop.
      if (!r.ok && r.code === ERR.NEEDS_GATE) {
        trace.push("runGate");
        const g = D.runGate(r.gate, { cwd, memo: state.ext ? state.ext._gate : undefined });
        gateRun = g;
        ctx = {
          ...ctx,
          gate_attempted: { cmd: g.cmd, exit: g.exit, tail: g.tail, coverage: g.coverage },
          verify: g.verify,
          files: mergeFiles(files, g.files),
          gate: g.memo,
        };
        trace.push("applyTurn");
        r = D.applyTurn(state, parsed.turn, ctx);
      }

      if (r.ok) { accepted = r; acceptedTurn = parsed.turn; rejection = null; }
      else rejection = r;
    }

    if (attempt === 0) first = rejection ? rejection.code : null;
    if (!rejection) break;
    if (attempt >= 1 || !MALFORMED_CODES.includes(rejection.code)) break;
    attempt++;
    obs = `${observation}\n\n${rejectionObservation(rejection)}`.trim();
  }

  const patchRecord = { ts: now, seat, card, class: seatClass(seat), code: first };
  if (attempt > 0) patchRecord.retry_code = rejection ? rejection.code : null;
  try { D.appendJsonl(patchesPath(project), patchRecord); } catch { /* the ledger is not the turn */ }

  // A rejected patch STOPS HERE. State untouched, nothing committed, nothing promoted, nothing
  // executed — and the rejection becomes the next observation. test-order.mjs holds the pure half
  // of this; `trace` holds the driver's half.
  if (!accepted) {
    const step = recordStep(D, project, card, {
      turn: state.cursor.turn, rev: null, by: seat, ts: now, exit, cost, cut: stepCut, disturbed,
      action: null, verify: gateRun ? gateRun.verify : null,
      verified_paths: [], rejected: rejection,
    });
    return {
      ok: false, trace, code: rejection.code, message: rejection.message,
      state: null, action: null, observation: rejectionObservation(rejection),
      promoted, step, patchRecord,
    };
  }

  // ---- 6. commit (compare-and-swap) ----
  trace.push("commit");
  let next = accepted.state;
  let promotions = accepted.promoted;
  let c = D.commit(next, expectedRev, { seat, card, project, ops: acceptedTurn.patch });

  if (!c.ok && c.code === STALE) {
    // §4.4: re-read, re-run applyTurn ONCE on the fresh state, then record patch_failed. Safe
    // because ops are id-addressed — DUP_ID / NO_SUCH_ID are exactly the failures re-application
    // means, and they are rejections like any other.
    trace.push("stale");
    trace.push("readState");
    const again = D.readState(seat, card, { project, cwd, by: seat, agent: seat });
    let redone = null;
    if (again.ok) { trace.push("applyTurn"); redone = D.applyTurn(again.state, acceptedTurn, ctx); }
    if (redone && redone.ok) {
      trace.push("commit");
      c = D.commit(redone.state, again.state.rev, { seat, card, project, ops: acceptedTurn.patch });
      if (c.ok) { next = redone.state; promotions = redone.promoted; }
    }
    if (!c.ok) {
      const why = redone && !redone.ok ? redone.message : c.message;
      const step = recordStep(D, project, card, {
        turn: state.cursor.turn, rev: null, by: seat, ts: now, exit, cost, cut: stepCut, disturbed,
        action: null, verify: gateRun ? gateRun.verify : null, verified_paths: [],
        rejected: { code: "patch_failed", at: "commit", message: why },
      });
      return {
        ok: false, trace, code: "patch_failed", message: why,
        state: null, action: null,
        observation: `Your patch could not be committed: the state moved under this turn and re-applying it failed. ${why}`,
        promoted, step, patchRecord,
      };
    }
  } else if (!c.ok) {
    const step = recordStep(D, project, card, {
      turn: state.cursor.turn, rev: null, by: seat, ts: now, exit, cost, cut: stepCut, disturbed,
      action: null, verify: gateRun ? gateRun.verify : null, verified_paths: [],
      rejected: { code: "patch_failed", at: "commit", message: c.message },
    });
    return {
      ok: false, trace, code: "patch_failed", message: c.message,
      state: null, action: null, observation: c.message, promoted, step, patchRecord,
    };
  }

  // ---- 7. promote (one deduped card note, non-fatal, never rolls state back) ----
  trace.push("promote");
  let promotedHash = promoted;
  try {
    const p = await D.promote(next, promotions, { by: seat, project });
    // §4.7: the hash advances only on a CONFIRMED post. `sent` is that confirmation; a duplicate
    // skip means the hash we already hold is still the truth.
    if (p && p.ok && p.sent && p.hash) promotedHash = p.hash;
  } catch { /* a promotion failure is never fatal and never rolls state back */ }

  // ---- the run recorder: the rows bin/state-bench.mjs --run reads, so gate 2 can stop saying NO
  const verifiedPaths = Object.keys(next.files).filter(p => next.files[p] && next.files[p].verified === true);
  const step = recordStep(D, project, card, {
    turn: next.cursor.turn, rev: next.rev, by: seat, ts: now, exit, cost, cut: stepCut, disturbed,
    action: acceptedTurn.action || null, verify: next.verify,
    verified_paths: verifiedPaths, rejected: null,
  });

  // ---- 8. execute(action) — LAST, and only on an accepted, committed, promoted turn ----
  trace.push("execute");
  const action = acceptedTurn.action || null;
  await D.executeAction(action, { seat, card, project, state: next });

  return {
    ok: true, trace, code: null, message: "",
    state: next, action, observation: "", promoted: promotedHash, step, patchRecord,
  };
}

/**
 * One run-step row for ~/.agent-bus/state/runs/<project>-<card>.jsonl. The FIELD NAMES ARE A CONTRACT
 * with bin/state-bench.mjs (a wrong name reads as NO_RUN). A cost the envelope lacks stays null, never 0.
 */
export function recordStep(D, project, card, row) {
  const c = row.cost || {};
  const out = {
    turn: row.turn,
    rev: row.rev,
    by: row.by,
    ts: row.ts,
    cost_usd: typeof c.cost_usd === "number" && Number.isFinite(c.cost_usd) ? c.cost_usd : null,
    input: c.input ?? 0,
    output: c.output ?? 0,
    cache_read: c.cache_read ?? 0,
    cache_creation: c.cache_creation ?? 0,
    exit: row.exit,
    action: row.action,
    verify: row.verify || null,
    verified_paths: row.verified_paths || [],
    rejected: row.rejected
      ? { code: row.rejected.code, at: row.rejected.at, message: String(row.rejected.message || "").slice(0, 2000) }
      : null,
  };
  if (row.cut) out.cut = true;
  if (row.disturbed) out.disturbed = true;
  try { D.appendJsonl(runPath(project, card), out); } catch { /* a recorder that throws must not end a turn */ }
  return out;
}
