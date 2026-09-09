#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the suite asserts the boundary decoder is total, which means feeding it values of the wrong type on purpose. */
// Trantor State P0 — migration (TDD §4.3). v2 → v3 with ZERO field loss: a field the newer schema
// does not know lands in notes under `migrated:`, never on the floor. That is #6528 generalised.
import { CAPS, CURRENT_VERSION, ERR, emptyState, stateError } from "../../lib/state/schema.mjs";
import { migrate, MIGRATIONS } from "../../lib/state/migrate.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();

/** A v2 object: the PRD shape before `rev`, the compaction counters and FileFact.hash existed. */
const v2Fixture = () => ({
  schema_version: 2,
  card: 6895,
  task: "build the pure core",
  done: [{ id: "d1", text: "wrote the TDD", paths: ["docs/TDD-trantor-state.md"] }],
  in_flight: [{ id: "x1", text: "the validator" }],
  next: [], blockers: [],
  files: { "lib/state/validate.mjs": { touched: true, verified: false } },
  verify: { tested: true, exit: 0 },
  notes: "existing note",
  ext: { project_thing: 1 },
  cursor: { turn: 4, ts: 1700000000000, by: "claude:trantor" },
});

console.log("\nv2 → v3");
const r = migrate(v2Fixture());
ok("migrates", r.ok === true, JSON.stringify(r));
ok("and says it migrated", r.migrated === true);
ok("the result is schema-valid v3", stateError(r.state) === "");
ok("schema_version is current", r.state.schema_version === CURRENT_VERSION);
ok("new fields get defaults: rev", r.state.rev === 0);
ok("new fields get defaults: done_count / files_count", r.state.done_count === 0 && r.state.files_count === 0);

console.log("\nzero field loss — every v2 field is findable in the v3 object");
ok("card carries", r.state.card === 6895);
ok("task carries", r.state.task === "build the pure core");
ok("items carry with their ids", r.state.done[0].id === "d1" && r.state.in_flight[0].id === "x1");
ok("item paths carry", r.state.done[0].paths.join() === "docs/TDD-trantor-state.md");
ok("files carry", r.state.files["lib/state/validate.mjs"].touched === true);
ok("verify carries", r.state.verify.tested === true && r.state.verify.exit === 0);
ok("notes carry", r.state.notes.includes("existing note"));
ok("ext carries", r.state.ext.project_thing === 1);
ok("cursor carries", r.state.cursor.turn === 4 && r.state.cursor.by === "claude:trantor");
const v2Keys = Object.keys(v2Fixture()).filter(k => k !== "schema_version");
ok(`all ${v2Keys.length} v2 fields are accounted for`,
  v2Keys.every(k => k in r.state), v2Keys.filter(k => !(k in r.state)).join(", "));

console.log("\nan unknown field is not dropped — it round-trips into notes (#6528)");
const withUnknown = { ...v2Fixture(), mystery_field: { deep: ["a", 2] } };
const u = migrate(withUnknown);
ok("still migrates", u.ok === true);
ok("the unknown field is findable in notes under `migrated:`",
  u.state.notes.includes("migrated:mystery_field"), u.state.notes);
ok("and its VALUE round-trips, not just its name",
  u.state.notes.includes(JSON.stringify({ deep: ["a", 2] })));
ok("it is not left as a live field — the schema stays closed", u.state.mystery_field === undefined);
ok("the migrated object is schema-valid", stateError(u.state) === "");
const roundTripped = JSON.parse(u.state.notes.split("migrated:mystery_field=")[1].split("\n")[0]);
ok("the note is machine-readable, so the field can be recovered by hand",
  JSON.stringify(roundTripped) === JSON.stringify({ deep: ["a", 2] }));

console.log("\nmany unknowns, and the notes cap");
const noisy = { ...v2Fixture(), notes: "n".repeat(CAPS.NOTES - 20) };
for (let i = 0; i < 30; i++) noisy[`unknown_${i}`] = "x".repeat(200);
const n = migrate(noisy);
ok("still migrates", n.ok === true);
ok("notes stays under CAPS.NOTES", Buffer.byteLength(n.state.notes, "utf8") <= CAPS.NOTES);
ok("the NEWEST migrated line survives — oldest evicted first", n.state.notes.includes("migrated:unknown_29"));
ok("the result is schema-valid", stateError(n.state) === "");

console.log("\na v3 object is a no-op, not a re-migration");
const already = emptyState(1, "seat");
const same = migrate(already);
ok("passes through", same.ok === true && same.migrated === false);
ok("byte-identical", JSON.stringify(same.state) === JSON.stringify(already));
const v3Unknown = { ...emptyState(1, "seat"), stowaway: 7 };
const sweep = migrate(v3Unknown);
ok("but an unknown key on a CURRENT object is still swept, not left to break the schema",
  sweep.ok === true && sweep.state.stowaway === undefined && sweep.state.notes.includes("migrated:stowaway"));

console.log("\nunmigratable objects fail loudly (§4.3)");
ok("a future version is MIGRATE_FAILED", migrate({ schema_version: 99 }).code === ERR.MIGRATE_FAILED);
ok("a missing version is MIGRATE_FAILED", migrate({ card: 1 }).code === ERR.MIGRATE_FAILED);
ok("a non-object is MIGRATE_FAILED", migrate("nope").code === ERR.MIGRATE_FAILED);
ok("null is MIGRATE_FAILED", migrate(null).code === ERR.MIGRATE_FAILED);
ok("an unregistered intermediate version is MIGRATE_FAILED", migrate({ schema_version: 1 }).code === ERR.MIGRATE_FAILED);
ok("the failure names where it happened", typeof migrate({ schema_version: 99 }).at === "string");

console.log("\na malformed VALUE is salvaged, not coerced away — coercion is field loss too");
const malformed = migrate({ schema_version: 2, card: "not a number", cursor: { turn: "x" } });
ok("it still migrates rather than failing the whole object", malformed.ok === true);
ok("the field falls back to its default", malformed.state.card === 0);
ok("but the original value is recoverable from notes",
  malformed.state.notes.includes('migrated:card="not a number"'), malformed.state.notes);
ok("nested cursor values are salvaged the same way",
  malformed.state.notes.includes('migrated:cursor.turn="x"'));
ok("and the result is schema-valid", stateError(malformed.state) === "");

console.log("\nmigrate is pure");
const input = v2Fixture();
const snapshot = JSON.stringify(input);
migrate(input);
ok("it does not mutate its argument", JSON.stringify(input) === snapshot);
ok("MIGRATIONS is a table keyed by the version it upgrades FROM", typeof MIGRATIONS[2] === "function");
ok("and there is no migration registered for the current version", MIGRATIONS[CURRENT_VERSION] === undefined);

done();
