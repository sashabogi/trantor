/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the validator's whole job is decoding an untrusted TurnResult at the boundary — a model may emit any JSON at all, and every typeof here is that parse, returning a named rejection rather than narrowing a value that was never established. */
// Trantor State — the validator (TDD §4.2, stages 1-3). Pure and total: same arguments, same
// answer, no disk, no clock, no throw. Rejection is a first-class RETURN, not an exception,
// because the rejection text is fed back to the seat as its next observation.
import {
  CAPS, LISTS, COMPACTING_LISTS, ERR, EVIDENCE_MARKER, SETTABLE_FIELDS, READONLY_FIELDS,
  RUNTIME_EXT_KEYS, KNOWN_FIELDS, itemError, isAction,
} from "./schema.mjs";

const reject = (code, at, message) => ({ ok: false, code, at, message });

/** Which top-level field a `set` path addresses: "ext.foo" → "ext". */
const rootOf = (field) => String(field).split(".")[0];

/**
 * Pull the evidence marker out BEFORE any cap and merge it with the patch's `paths` (TDD §3):
 * extract, then cap, so a long text can never truncate away route (b)'s paths.
 */
export function extractEvidence(item) {
  const marked = EVIDENCE_MARKER.exec(item.text);
  const fromMarker = marked ? marked[1].split(",").filter(Boolean) : [];
  const prose = marked ? item.text.slice(0, marked.index) : item.text;
  const paths = [...new Set([...(item.paths || []), ...fromMarker])];

  // A malformed marker is rejected naming the marker, never accepted-and-trimmed into silence.
  if (paths.length > CAPS.ITEM_PATHS) {
    return { ok: false, reason: `evidence marker carries ${paths.length} paths, CAPS.ITEM_PATHS is ${CAPS.ITEM_PATHS}` };
  }
  for (const p of paths) {
    if (p.length > CAPS.PATH) return { ok: false, reason: `evidence path exceeds CAPS.PATH (${CAPS.PATH}): "${p.slice(0, 60)}…"` };
    if (p.startsWith("/") || p.split("/").includes("..")) {
      return { ok: false, reason: `evidence path escapes the worktree: "${p}"` };
    }
  }

  const out = { id: item.id, text: prose.slice(0, CAPS.ITEM) };
  if (paths.length) out.paths = paths;
  return { ok: true, item: out };
}

/**
 * Does this item have the evidence a `move → done` needs (TDD §4.2)? Route (a): green gate this
 * turn; route (b): every named path credited. Reads `ctx` FIRST with stage 5's precedence (#6969).
 */
export function hasEvidence(state, item, ctx = {}) {
  const verify = ctx.verify && typeof ctx.verify === "object" && !Array.isArray(ctx.verify)
    ? ctx.verify : state.verify;
  if (verify.tested === true && verify.exit === 0) return true;
  const paths = item.paths || [];
  if (!paths.length) return false;
  const ctxFiles = ctx.files && typeof ctx.files === "object" && !Array.isArray(ctx.files) ? ctx.files : {};
  return paths.every(p => ({ ...(state.files[p] || {}), ...(ctxFiles[p] || {}) }).verified === true);
}

/**
 * Stages 1-3: normalised ops on success, the seat's rejection on failure. `ctx.gate_attempted`
 * splits NEEDS_GATE from UNVERIFIED_DONE; without it §4.8's one-retry bound is false.
 */
export function validateTurn(state, turn, ctx = {}) {
  // ---- stage 1: shape ----
  if (typeof turn !== "object" || turn === null || Array.isArray(turn)) {
    return reject(ERR.SCHEMA, "turn", "TurnResult must be an object with { patch, action }");
  }
  if (!Array.isArray(turn.patch)) {
    return reject(ERR.SCHEMA, "turn.patch", "TurnResult.patch must be an array of ops");
  }
  if (!isAction(turn.action)) {
    return reject(ERR.BAD_ACTION, "turn.action",
      "every turn must act, finish, or ask: one of { tool, input } | { done: true } | { ask } | { continue: true }");
  }

  const OPERATORS = ["set", "add", "remove", "move"];
  const normalised = [];

  // Lengths are simulated as we go, so an `add` that would overflow a working list is caught
  // before anything is applied — all-or-nothing is what makes "no valid patch corrupts state"
  // testable in the first place.
  const lengths = Object.fromEntries(LISTS.map(l => [l, state[l].length]));
  // id → which list holds it, and id → the item itself. Both are simulated forward through the
  // patch so ops later in the same patch see what the earlier ones did.
  const listOf = new Map();
  const itemOf = new Map();
  for (const l of LISTS) for (const it of state[l]) { listOf.set(it.id, l); itemOf.set(it.id, it); }
  let taskSet = state.task !== "";

  for (let n = 0; n < turn.patch.length; n++) {
    const op = turn.patch[n];
    if (typeof op !== "object" || op === null || Array.isArray(op)) {
      return reject(ERR.SCHEMA, `patch[${n}]`, "each op must be an object");
    }
    const keys = Object.keys(op).filter(k => OPERATORS.includes(k));
    if (keys.length !== 1 || Object.keys(op).length !== 1) {
      return reject(ERR.SCHEMA, `patch[${n}]`,
        `each op has exactly one operator key (${OPERATORS.join(" | ")}); got [${Object.keys(op).join(", ")}]`);
    }
    const kind = keys[0];
    const body = op[kind];
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reject(ERR.SCHEMA, `patch[${n}].${kind}`, `${kind} takes an object`);
    }

    if (kind === "set") {
      const { field, value } = body;
      if (typeof field !== "string" || !field) {
        return reject(ERR.SCHEMA, `patch[${n}].set`, "set.field must be a non-empty string");
      }
      const root = rootOf(field);
      // ---- stage 2: the write matrix. One table lookup, and it is the whole "a seat marks its
      // own work verified" hole.
      if (READONLY_FIELDS.includes(root)) {
        return reject(ERR.READONLY_FIELD, `set:${field}`,
          `${field} is harness-written and never model-writable. Evidence comes from a gate that ran, not from the patch.`);
      }
      if (root === "ext" && RUNTIME_EXT_KEYS.includes(field.split(".")[1])) {
        return reject(ERR.READONLY_FIELD, `set:${field}`, `ext.${field.split(".")[1]} is runtime-owned`);
      }
      if (LISTS.includes(root)) {
        return reject(ERR.READONLY_FIELD, `set:${field}`,
          `${root} changes by add/remove/move only, never by set — arrays change only by id`);
      }
      if (!KNOWN_FIELDS.includes(root)) {
        return reject(ERR.UNKNOWN_FIELD, `set:${field}`,
          `the schema defines no field "${root}". An unknown field is a rejection, never a silently created key.`);
      }
      if (!SETTABLE_FIELDS.includes(root)) {
        return reject(ERR.READONLY_FIELD, `set:${field}`, `${field} is not settable`);
      }
      if (root === "task") {
        if (field !== "task") return reject(ERR.UNKNOWN_FIELD, `set:${field}`, "task is a scalar; set it whole");
        if (typeof value !== "string") return reject(ERR.SCHEMA, `set:${field}`, "task must be a string");
        if (taskSet) return reject(ERR.READONLY_FIELD, "set:task", "task is set-once: it is writable only while empty");
        if (value.length > CAPS.TASK) return reject(ERR.CAP, "set:task", `task exceeds CAPS.TASK (${CAPS.TASK})`);
        taskSet = value !== "";
      }
      if (root === "notes") {
        if (typeof value !== "string") return reject(ERR.SCHEMA, `set:${field}`, "notes must be a string");
      }
      normalised.push({ set: { field, value } });
      continue;
    }

    if (kind === "add") {
      const { list, item } = body;
      if (!LISTS.includes(list)) {
        return reject(ERR.UNKNOWN_LIST, `patch[${n}].add`, `no list "${list}"; one of ${LISTS.join(", ")}`);
      }
      const why = itemError(item);
      if (why) return reject(ERR.SCHEMA, `add:${list}`, why);
      if (item.id.length > CAPS.ID) {
        return reject(ERR.CAP, `add:${item.id.slice(0, 16)}…`,
          `item.id exceeds CAPS.ID (${CAPS.ID}). Over-long ids are rejected, not trimmed — a trimmed id no longer addresses the item the next op names.`);
      }
      if (listOf.has(item.id)) return reject(ERR.DUP_ID, `add:${item.id}`, `id "${item.id}" already exists`);
      const ev = extractEvidence(item);
      if (!ev.ok) return reject(ERR.CAP, `add:${item.id}`, ev.reason);
      if (lengths[list] + 1 > CAPS.LIST) {
        if (!COMPACTING_LISTS.includes(list)) {
          return reject(ERR.CAP, `add:${list}`,
            `${list} is at CAPS.LIST (${CAPS.LIST}) and is a working list: overflow is a rejection, not a silent drop`);
        }
      }
      listOf.set(item.id, list);
      itemOf.set(item.id, ev.item);
      lengths[list]++;
      normalised.push({ add: { list, item: ev.item } });
      continue;
    }

    if (kind === "remove") {
      const { list, id } = body;
      if (!LISTS.includes(list)) {
        return reject(ERR.UNKNOWN_LIST, `patch[${n}].remove`, `no list "${list}"; one of ${LISTS.join(", ")}`);
      }
      if (typeof id !== "string" || !id) return reject(ERR.SCHEMA, `patch[${n}].remove`, "remove.id must be a non-empty string");
      if (listOf.get(id) !== list) {
        return reject(ERR.NO_SUCH_ID, `remove:${id}`,
          listOf.has(id) ? `item "${id}" is in ${listOf.get(id)}, not ${list}` : `no item "${id}" to remove`);
      }
      listOf.delete(id);
      itemOf.delete(id);
      lengths[list]--;
      normalised.push({ remove: { list, id } });
      continue;
    }

    // move
    const { id, from, to } = body;
    if (!LISTS.includes(from) || !LISTS.includes(to)) {
      return reject(ERR.UNKNOWN_LIST, `patch[${n}].move`, `move needs two known lists; got "${from}" → "${to}"`);
    }
    if (typeof id !== "string" || !id) return reject(ERR.SCHEMA, `patch[${n}].move`, "move.id must be a non-empty string");
    if (listOf.get(id) !== from) {
      return reject(ERR.NO_SUCH_ID, `move:${id}`,
        listOf.has(id) ? `item "${id}" is in ${listOf.get(id)}, not ${from}` : `no item "${id}" to move`);
    }
    if (lengths[to] + 1 > CAPS.LIST && !COMPACTING_LISTS.includes(to)) {
      return reject(ERR.CAP, `move:${id}`, `${to} is at CAPS.LIST (${CAPS.LIST})`);
    }
    if (to === "done") {
      const item = itemOf.get(id);
      if (item && !hasEvidence(state, item, ctx)) {
        // The split that makes §4.8's one-retry bound a fact: a gate that ran and failed looks
        // exactly like a gate that never ran, unless the driver says which happened.
        if (ctx.gate_attempted) {
          const g = ctx.gate_attempted;
          return {
            ...reject(ERR.UNVERIFIED_DONE, `move:${id}`,
              `move ${id} → done rejected: the gate ran and did not pass (${g.cmd || "gate"}, exit ${g.exit}). ` +
              `Fix the failure, then move it.`),
            gate: { cmd: g.cmd, exit: g.exit, tail: g.tail },
          };
        }
        return {
          ...reject(ERR.NEEDS_GATE, `move:${id}`,
            `move ${id} → done needs evidence: no gate has run at this state. Run it, then re-apply.`),
          gate: { items: [id], paths: item.paths || [] },
        };
      }
    }
    listOf.set(id, to);
    lengths[from]--;
    lengths[to]++;
    normalised.push({ move: { id, from, to } });
  }

  return { ok: true, ops: normalised };
}
