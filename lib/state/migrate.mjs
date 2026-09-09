/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: migration reads objects written by an OLDER schema version off disk — the type of any field is exactly what cannot be assumed, which is why a mismatch is salvaged into notes instead of coerced. */
// Trantor State — migration (TDD §4.3). A field the newer schema does not know is never dropped:
// it is appended to `notes` as `migrated:<path>=<json>`. That is #6528 generalised, and it is the
// single rule that makes the whole scheme safe to version.
import { CAPS, CURRENT_VERSION, ERR, KNOWN_FIELDS, emptyState, stateError } from "./schema.mjs";

/** Append `migrated:` lines to notes, oldest evicted first when the cap bites. */
function noteMigrated(state, lines) {
  if (!lines.length) return state;
  const joined = [state.notes, ...lines].filter(Boolean).join("\n");
  // Truncate to fit CAPS.NOTES by dropping from the front — the newest migrated line is the one
  // most likely to matter, and a mid-line elision is exactly the bug this rule exists to prevent.
  const all = joined.split("\n");
  while (all.length > 1 && Buffer.byteLength(all.join("\n"), "utf8") > CAPS.NOTES) all.shift();
  state.notes = all.join("\n").slice(-CAPS.NOTES);
  return state;
}

/**
 * Sweep every key the v3 schema does not define into `notes`. Returns the swept state.
 */
function absorbUnknown(state) {
  const lines = [];
  for (const key of Object.keys(state)) {
    if (KNOWN_FIELDS.includes(key)) continue;
    lines.push(`migrated:${key}=${JSON.stringify(state[key])}`);
    delete state[key];
  }
  return noteMigrated(state, lines);
}

/** v2 → v3: `rev`, the two compaction counters and FileFact.hash are new; everything else carries
 *  over by name. Unknown v2 keys go to notes rather than being dropped. */
function up2to3(v2) {
  const out = { ...emptyState(0) };
  // A value of the wrong TYPE is not silently coerced to a default — that is field loss wearing a
  // helpful face, and zero-field-loss means zero. It keeps the default and the original value goes
  // to notes, exactly like an unknown key.
  const salvaged = [];
  const carry = (key, value, typeOk) => {
    if (value === undefined) return false;
    if (typeOk) return true;
    salvaged.push(`migrated:${key}=${JSON.stringify(value)}`);
    return false;
  };
  if (carry("card", v2.card, Number.isInteger(v2.card))) out.card = v2.card;
  for (const key of ["task", "notes"]) {
    if (carry(key, v2[key], typeof v2[key] === "string")) out[key] = v2[key];
  }
  for (const list of ["done", "in_flight", "next", "blockers"]) {
    if (Array.isArray(v2[list])) {
      out[list] = v2[list]
        .filter(i => i && typeof i.id === "string" && typeof i.text === "string")
        .map(i => (Array.isArray(i.paths) ? { id: i.id, text: i.text, paths: i.paths } : { id: i.id, text: i.text }));
    }
  }
  if (v2.files && typeof v2.files === "object") {
    for (const [p, f] of Object.entries(v2.files)) {
      if (!f || typeof f !== "object") continue;
      out.files[p] = { touched: f.touched === true, verified: f.verified === true };
      if (Number.isInteger(f.blast_radius)) out.files[p].blast_radius = f.blast_radius;
    }
  }
  if (v2.verify && typeof v2.verify === "object") out.verify = { ...v2.verify };
  if (v2.ext && typeof v2.ext === "object") out.ext = { ...v2.ext };
  if (v2.cursor && typeof v2.cursor === "object") {
    for (const [k, isOk] of [["turn", Number.isInteger(v2.cursor.turn)], ["ts", Number.isInteger(v2.cursor.ts)], ["by", typeof v2.cursor.by === "string"]]) {
      if (carry(`cursor.${k}`, v2.cursor[k], isOk)) out.cursor[k] = v2.cursor[k];
    }
  }
  if (carry("done_count", v2.done_count, Number.isInteger(v2.done_count))) out.done_count = v2.done_count;
  if (carry("files_count", v2.files_count, Number.isInteger(v2.files_count))) out.files_count = v2.files_count;

  // Carry the unknowns across BEFORE absorbing, so they are swept from the v3 object and land in
  // notes rather than vanishing with the v2 shell.
  const carried = { ...out };
  for (const key of Object.keys(v2)) {
    if (KNOWN_FIELDS.includes(key) || key === "schema_version") continue;
    carried[key] = v2[key];
  }
  return noteMigrated(absorbUnknown(carried), salvaged);
}

/** Applied in sequence on read until schema_version matches CURRENT. */
export const MIGRATIONS = { 2: up2to3 };

/**
 * Migrate an object of any known version up to v3.
 * An unmigratable object returns MIGRATE_FAILED; the STORE (P1) is what keeps the original file
 * untouched under `.v<n>.json` rather than half-upgrading it — this function only reports.
 * @returns {{ ok: true, state: object, migrated: boolean } | { ok: false, code: string, at: string, message: string }}
 */
export function migrate(obj) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, code: ERR.MIGRATE_FAILED, at: "state", message: "state must be an object" };
  }
  let cur = structuredClone(obj);
  let steps = 0;
  const from = cur.schema_version;
  if (!Number.isInteger(from) || from < 1 || from > CURRENT_VERSION) {
    return {
      ok: false, code: ERR.MIGRATE_FAILED, at: "schema_version",
      message: `no migration path from schema_version ${JSON.stringify(from)} to ${CURRENT_VERSION}`,
    };
  }
  while (cur.schema_version !== CURRENT_VERSION) {
    const step = MIGRATIONS[cur.schema_version];
    if (!step) {
      return {
        ok: false, code: ERR.MIGRATE_FAILED, at: `v${cur.schema_version}`,
        message: `no migration registered for schema_version ${cur.schema_version}`,
      };
    }
    cur = step(cur);
    cur.schema_version = CURRENT_VERSION;
    if (++steps > CURRENT_VERSION) {
      return { ok: false, code: ERR.MIGRATE_FAILED, at: "migrate", message: "migration did not converge" };
    }
  }
  if (steps === 0) cur = absorbUnknown(cur);
  const why = stateError(cur);
  if (why) {
    return { ok: false, code: ERR.MIGRATE_FAILED, at: "state", message: `migrated object is not schema-valid: ${why}` };
  }
  return { ok: true, state: cur, migrated: steps > 0 };
}
