/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: ctx carries harness facts from the driver and set() merges model-supplied values; both are decoded here at the boundary rather than trusted. */
// Trantor State — apply (TDD §4.2, stages 4-5). Validate, then apply to a CLONE, then the runtime
// pass. Pure: `ctx` carries the clock and the harness facts, so this function is a function of its
// arguments and nothing else.
//
// One apply point per turn is the whole crash-safety argument (§4.4): a turn killed mid-flight has
// never partially applied a patch, because the patch is applied to a clone that is only returned
// when every op passed.
import { CAPS, LISTS, COMPACTING_LISTS, RUNTIME_EXT_KEYS, cloneState } from "./schema.mjs";
import { validateTurn } from "./validate.mjs";

/** Deep-merge one level, the `set` semantics of §3.2: null deletes an optional key. */
function setField(state, field, value) {
  const [root, sub] = String(field).split(".");
  if (sub === undefined) {
    if (value === null && root === "ext") { state.ext = {}; return; }
    state[root] = value;
    return;
  }
  if (value === null) { delete state[root][sub]; return; }
  const cur = state[root][sub];
  const mergeable = typeof cur === "object" && cur !== null && !Array.isArray(cur)
    && typeof value === "object" && value !== null && !Array.isArray(value);
  state[root][sub] = mergeable ? { ...cur, ...value } : value;
}

/** Keep `notes` under CAPS.NOTES by evicting whole lines from the FRONT — the tail is the recent
 *  half, and a mid-string elision is #6528, the failure this whole schema exists to prevent. */
function capNotes(notes) {
  if (Buffer.byteLength(notes, "utf8") <= CAPS.NOTES) return notes;
  const lines = notes.split("\n");
  while (lines.length > 1 && Buffer.byteLength(lines.join("\n"), "utf8") > CAPS.NOTES) lines.shift();
  let out = lines.join("\n");
  while (out.length && Buffer.byteLength(out, "utf8") > CAPS.NOTES) out = out.slice(1);
  return out;
}

/**
 * The five-stage pipeline. `turn` is the TurnResult `{ patch, action }` — §4.8's driver snippet
 * calls this slot `patch`, which is the same object under a shorter name.
 *
 * ctx: { now, by, verify, files, gate_attempted, gate }
 *   - `verify` and `files` are harness facts from a gate that actually ran, never testimony.
 *   - `gate_attempted` splits NEEDS_GATE from UNVERIFIED_DONE (§4.8).
 *   - `gate` is the memo record runGate returned, written to ext._gate here so it lands through
 *     the single apply point rather than as a side effect somewhere else.
 *
 * @returns {{ ok: true, state: object, promoted: object[] }
 *          | { ok: false, code: string, at: string, message: string }}
 */
export function applyTurn(state, turn, ctx = {}) {
  const v = validateTurn(state, turn, ctx);
  if (!v.ok) return v;

  // ---- stage 4: apply, in order, on a structural clone ----
  const next = cloneState(state);
  for (const op of v.ops) {
    if (op.set) { setField(next, op.set.field, op.set.value); continue; }
    if (op.add) { next[op.add.list].push(op.add.item); continue; }
    if (op.remove) {
      next[op.remove.list] = next[op.remove.list].filter(i => i.id !== op.remove.id);
      continue;
    }
    const { id, from, to } = op.move;
    const at = next[from].findIndex(i => i.id === id);
    const [item] = next[from].splice(at, 1);
    next[to].push(item);
  }

  // ---- stage 5: the runtime pass. Not model-visible, not model-writable. ----

  // `verify` is REWRITTEN wholesale, never merged: it describes the gate that ran THIS turn, or
  // nothing. That is what makes "evidence at the current rev" enforceable without a rev stamp on
  // every field (§4.2).
  next.verify = ctx.verify && typeof ctx.verify === "object" ? { ...ctx.verify } : {};

  // Harness file facts: tier 1 sets `touched` from git, the gate sets `verified` + `hash`, and
  // tier 1 EXPIRES a credit whose bytes have moved (R12). Setting evidence is the gate's
  // privilege; expiring it belongs to the only thing that runs every turn.
  for (const [path, fact] of Object.entries(ctx.files || {})) {
    const cur = next.files[path] || { touched: false, verified: false };
    const merged = { ...cur };
    if (fact.touched !== undefined) merged.touched = fact.touched;
    if (fact.verified !== undefined) merged.verified = fact.verified;
    if (fact.blast_radius !== undefined) merged.blast_radius = fact.blast_radius;
    if (fact.hash !== undefined) merged.hash = fact.hash;
    if (merged.verified === false) delete merged.hash;
    next.files[path] = merged;
  }

  if (ctx.gate && typeof ctx.gate === "object") next.ext._gate = { ...ctx.gate };
  if (ctx.promoted !== undefined) next.ext._promoted = ctx.promoted;

  // ---- compaction: history compacts, working lists never reach here (they were rejected) ----
  for (const list of COMPACTING_LISTS) {
    if (next[list].length > CAPS.LIST) {
      const overflow = next[list].length - CAPS.LIST;
      next[list] = next[list].slice(overflow);
      if (list === "done") next.done_count += overflow;
    }
  }
  next.done_count = Math.max(next.done_count, 0);
  const paths = Object.keys(next.files);
  if (paths.length > CAPS.FILES) {
    // Drop the least interesting first: untouched and uncredited paths carry no evidence.
    const rank = (p) => (next.files[p].verified ? 2 : next.files[p].touched ? 1 : 0);
    const doomed = paths.sort((a, b) => rank(a) - rank(b)).slice(0, paths.length - CAPS.FILES);
    for (const p of doomed) delete next.files[p];
    next.files_count += doomed.length;
  }

  // ---- cap enforcement on content ----
  next.task = next.task.slice(0, CAPS.TASK);
  next.notes = capNotes(next.notes);
  const extKeys = Object.keys(next.ext).filter(k => !RUNTIME_EXT_KEYS.includes(k));
  for (const k of extKeys.slice(CAPS.EXT_KEYS)) delete next.ext[k];
  let extBytes = Buffer.byteLength(JSON.stringify(
    Object.fromEntries(Object.entries(next.ext).filter(([k]) => !RUNTIME_EXT_KEYS.includes(k))),
  ), "utf8");
  for (const k of extKeys.slice(0, CAPS.EXT_KEYS).reverse()) {
    if (extBytes <= CAPS.EXT_BYTES) break;
    extBytes -= Buffer.byteLength(JSON.stringify({ [k]: next.ext[k] }), "utf8");
    delete next.ext[k];
  }

  next.cursor = {
    turn: state.cursor.turn + 1,
    ts: Number.isInteger(ctx.now) ? ctx.now : state.cursor.ts,
    by: typeof ctx.by === "string" ? ctx.by : state.cursor.by,
  };
  next.rev = state.rev + 1;

  return { ok: true, state: next, promoted: promotionPlan(state, next) };
}

/**
 * The delta the board is allowed to see (TDD §4.7): what shipped, what is blocking, what the
 * evidence says. `in_flight`/`next` are scratch and promote nothing — that churn is #6669's
 * lesson. The promoter (P3) composes these into at most one card note per turn.
 * @returns {{ kind: string, text: string }[]}
 */
export function promotionPlan(before, after) {
  const out = [];
  const wasDone = new Set(before.done.map(i => i.id));
  for (const item of after.done) {
    if (wasDone.has(item.id)) continue;
    const ev = item.paths?.length ? ` (${item.paths.join(", ")})` : "";
    out.push({ kind: "done", text: `${item.text}${ev}` });
  }
  const wasBlocked = new Map(before.blockers.map(i => [i.id, i]));
  for (const item of after.blockers) {
    if (!wasBlocked.has(item.id)) out.push({ kind: "blocker_added", text: item.text });
  }
  const nowBlocked = new Set(after.blockers.map(i => i.id));
  for (const item of before.blockers) {
    if (!nowBlocked.has(item.id)) out.push({ kind: "blocker_cleared", text: item.text });
  }
  for (const field of ["built", "tested", "observed"]) {
    if (after.verify[field] === true && before.verify[field] !== true) {
      const cmd = after.verify.cmd ? ` — ${after.verify.cmd}` : "";
      out.push({ kind: "verify", text: `${field}${cmd}` });
    }
  }
  return out;
}

/** Every id currently in the state, for the "arrays change only by id" property. */
export function allIds(state) {
  return LISTS.flatMap(l => state[l].map(i => i.id));
}
