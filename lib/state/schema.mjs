/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this file IS the I/O boundary decoder. A WorkingState is JSON read off disk and a TurnResult is untrusted model output; stateError/itemError/isAction are the parse step that establishes the contract every other module then relies on, so the typeof checks here are the boundary, not a substitute for one. */
// Trantor State — the wire contract (TDD §3): shapes, caps, write matrix and evidence marker. Facts
// only; validate.mjs and apply.mjs hold behaviour. Nothing here reads the disk or the clock.

/** @typedef {{ id: string, text: string, paths?: string[] }} Item   // id <= CAPS.ID, text <= CAPS.ITEM */
/** @typedef {{ touched: boolean, verified: boolean, hash?: string, blast_radius?: number }} FileFact
 *  // every field harness-written; `hash` = the path's blob sha when the gate credited it (TDD §4.2) */

/** @typedef {{ schema_version: 3, card: number, task: string, done: Item[], in_flight: Item[], next: Item[],
 *   blockers: Item[], done_count: number, files_count: number, files: Record<string, FileFact>,
 *   verify: { built?: boolean, tested?: boolean, observed?: boolean, cmd?: string, exit?: number }, notes: string,
 *   ext: Record<string, unknown>, cursor: { turn: number, ts: number, by: string }, rev: number }} WorkingState */

/** @typedef {{ tool: string, input: object } | { done: true } | { ask: string } | { continue: true }} Action */
/** @typedef {{ patch: Op[], action: Action }} TurnResult */
/** @typedef {{ set: { field: string, value: unknown } } | { add: { list: ListName, item: Item } }
 *          | { remove: { list: ListName, id: string } } | { move: { id: string, from: ListName, to: ListName } }} Op */

/** @typedef {{ kind: "done"|"blocker_added"|"blocker_cleared"|"verify", text: string }} Promotion */

export const CURRENT_VERSION = 3;

/** Caps — one table, one place (TDD §3.1). A driver that wants a cap imports this. */
export const CAPS = {
  ID: 32,           // chars per item id — ids render into the prompt and key every array op
  ITEM: 240,        // chars per item PROSE, after the evidence marker is extracted
  ITEM_PATHS: 8,    // evidence paths per item
  PATH: 400,        // chars per files key
  NOTES: 2048,      // bytes of the notes tail
  LIST: 40,         // items per list; `done` overflow compacts into done_count, the
                    // working lists reject instead (TDD §3.1)
  FILES: 200,       // paths; overflow compacts into files_count
  EXT_KEYS: 8, EXT_BYTES: 4096,
  TAIL_TOKENS: 2000, OBS_TOKENS: 4000,
  TASK: 400,
};

/** The four lists a patch may address. */
export const LISTS = ["done", "in_flight", "next", "blockers"];

/** Append-only history: overflow COMPACTS into a `_count`. Everything else in LISTS is a working
 *  list, where overflow is a CAP rejection — dropping the oldest blocker silently is the worst
 *  thing this object could do (TDD §3.1). */
export const COMPACTING_LISTS = ["done"];

/** The evidence marker, made structural (TDD §3): "wire the promoter @lib/x.mjs,test/test-x.mjs" is
 *  extracted into `paths` BEFORE any cap. This regex lives here and nowhere else. */
export const EVIDENCE_MARKER = /\s+@((?:[\w./-]+)(?:,[\w./-]+)*)\s*$/;

/** Rejection codes the pure core returns (TDD §3.3). `STALE` is deliberately absent: it is the
 *  CAS outcome of the store's commit(), which no branch in here can produce. */
export const ERR = {
  SCHEMA: "SCHEMA",
  READONLY_FIELD: "READONLY_FIELD",
  CAP: "CAP",
  UNKNOWN_LIST: "UNKNOWN_LIST",
  UNKNOWN_FIELD: "UNKNOWN_FIELD",
  DUP_ID: "DUP_ID",
  NO_SUCH_ID: "NO_SUCH_ID",
  UNVERIFIED_DONE: "UNVERIFIED_DONE",
  NEEDS_GATE: "NEEDS_GATE",
  BAD_ACTION: "BAD_ACTION",
  MIGRATE_FAILED: "MIGRATE_FAILED",
};

/** Malformed OUTPUT — the seat failed to speak the grammar. These count against the §7.3 invalid-
 *  patch budget and the circuit breaker. */
export const MALFORMED_CODES = [
  ERR.SCHEMA, ERR.BAD_ACTION, ERR.READONLY_FIELD, ERR.CAP,
  ERR.UNKNOWN_FIELD, ERR.UNKNOWN_LIST, ERR.DUP_ID, ERR.NO_SUCH_ID,
];

/** Well-formed patch, wrong CODE — the system working. Never counted against the budget, or the
 *  breaker trips on the healthiest seat there is: one writing perfect patches against a failing
 *  test (TDD §7.3). */
export const EVIDENCE_CODES = [ERR.UNVERIFIED_DONE, ERR.NEEDS_GATE];

/** Every field a `set` op may write. Anything else that IS a schema field is READONLY_FIELD;
 *  anything the schema does not define at all is UNKNOWN_FIELD (TDD §4.2 stage 3). */
export const SETTABLE_FIELDS = ["task", "notes", "ext"];

/** Harness/runtime fields, never model-writable (TDD §2 / §4.2 write matrix). `files` is listed
 *  whole because every FileFact field — touched, verified, hash, blast_radius — is harness-written:
 *  git is ground truth for the first, the gate for the rest. */
export const READONLY_FIELDS = [
  "verify", "files", "card", "schema_version", "cursor", "done_count", "files_count", "rev",
];

/** Runtime-owned `ext` keys (TDD §4.7, §4.8). Model-unwritable like the rest of the matrix. */
export const RUNTIME_EXT_KEYS = ["_gate", "_promoted"];

/** Every field name the v3 schema defines. A `set` naming anything outside this is UNKNOWN_FIELD:
 *  an unknown field quietly accepted is the write matrix ceasing to be enforceable, because
 *  tomorrow's real field arrives as today's typo. */
export const KNOWN_FIELDS = [
  "schema_version", "card", "task", ...LISTS, "done_count", "files_count",
  "files", "verify", "notes", "ext", "cursor", "rev",
];

/** A blank, schema-valid v3 state. */
export function emptyState(card = 0, by = "") {
  return {
    schema_version: CURRENT_VERSION,
    card,
    task: "",
    done: [], in_flight: [], next: [], blockers: [],
    done_count: 0, files_count: 0,
    files: {},
    verify: {},
    notes: "",
    ext: {},
    cursor: { turn: 0, ts: 0, by },
    rev: 0,
  };
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isInt = (v) => typeof v === "number" && Number.isInteger(v);

/** Shape-check one Item. Returns an error string, or "" when it is well-formed. */
export function itemError(item) {
  if (!isObj(item)) return "item must be an object";
  if (!isStr(item.id) || !item.id) return "item.id must be a non-empty string";
  if (!isStr(item.text)) return "item.text must be a string";
  if (item.paths !== undefined) {
    if (!Array.isArray(item.paths) || !item.paths.every(isStr)) return "item.paths must be string[]";
  }
  for (const k of Object.keys(item)) {
    if (!["id", "text", "paths"].includes(k)) return `item has unknown key "${k}"`;
  }
  return "";
}

/** Shape-check a whole WorkingState. Deliberately total: never throws, returns the first problem as a
 *  string, "" means valid. */
export function stateError(s) {
  if (!isObj(s)) return "state must be an object";
  if (s.schema_version !== CURRENT_VERSION) return `schema_version must be ${CURRENT_VERSION}`;
  if (!isInt(s.card)) return "card must be an integer";
  if (!isStr(s.task)) return "task must be a string";
  if (s.task.length > CAPS.TASK) return "task exceeds CAPS.TASK";
  for (const list of LISTS) {
    if (!Array.isArray(s[list])) return `${list} must be an array`;
    if (s[list].length > CAPS.LIST) return `${list} exceeds CAPS.LIST`;
    for (const item of s[list]) {
      const e = itemError(item);
      if (e) return `${list}: ${e}`;
      if (item.id.length > CAPS.ID) return `${list}: item.id exceeds CAPS.ID`;
      if (item.text.length > CAPS.ITEM) return `${list}: item.text exceeds CAPS.ITEM`;
      if (item.paths && item.paths.length > CAPS.ITEM_PATHS) return `${list}: item.paths exceeds CAPS.ITEM_PATHS`;
    }
  }
  if (!isInt(s.done_count) || s.done_count < 0) return "done_count must be a non-negative integer";
  if (!isInt(s.files_count) || s.files_count < 0) return "files_count must be a non-negative integer";
  if (!isObj(s.files)) return "files must be an object";
  if (Object.keys(s.files).length > CAPS.FILES) return "files exceeds CAPS.FILES";
  for (const [p, f] of Object.entries(s.files)) {
    if (p.length > CAPS.PATH) return `files["${p}"] key exceeds CAPS.PATH`;
    if (!isObj(f)) return `files["${p}"] must be an object`;
    if (typeof f.touched !== "boolean") return `files["${p}"].touched must be a boolean`;
    if (typeof f.verified !== "boolean") return `files["${p}"].verified must be a boolean`;
    if (f.hash !== undefined && !isStr(f.hash)) return `files["${p}"].hash must be a string`;
    if (f.blast_radius !== undefined && !isInt(f.blast_radius)) return `files["${p}"].blast_radius must be an integer`;
  }
  if (!isObj(s.verify)) return "verify must be an object";
  if (!isStr(s.notes)) return "notes must be a string";
  if (Buffer.byteLength(s.notes, "utf8") > CAPS.NOTES) return "notes exceeds CAPS.NOTES";
  if (!isObj(s.ext)) return "ext must be an object";
  if (Object.keys(s.ext).filter(k => !RUNTIME_EXT_KEYS.includes(k)).length > CAPS.EXT_KEYS) return "ext exceeds CAPS.EXT_KEYS";
  if (!isObj(s.cursor)) return "cursor must be an object";
  if (!isInt(s.cursor.turn)) return "cursor.turn must be an integer";
  if (!isInt(s.cursor.ts)) return "cursor.ts must be an integer";
  if (!isStr(s.cursor.by)) return "cursor.by must be a string";
  if (!isInt(s.rev) || s.rev < 0) return "rev must be a non-negative integer";
  for (const k of Object.keys(s)) {
    if (!KNOWN_FIELDS.includes(k)) return `state has unknown key "${k}"`;
  }
  return "";
}

/** The one Action shape check. Missing or unrecognised → BAD_ACTION at the caller (TDD §4.2). */
export function isAction(a) {
  if (!isObj(a)) return false;
  if (a.done === true) return Object.keys(a).length === 1;
  if (a.continue === true) return Object.keys(a).length === 1;
  if (isStr(a.ask)) return Object.keys(a).length === 1;
  if (isStr(a.tool)) return isObj(a.input) && Object.keys(a).length === 2;
  return false;
}

/** Structural clone, so an aborted patch can never leave a half-applied state behind. */
export function cloneState(s) {
  return structuredClone(s);
}
