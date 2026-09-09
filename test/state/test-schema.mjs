#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the suite asserts the boundary decoder is total, which means feeding it values of the wrong type on purpose. */
// Trantor State P0 — the wire contract itself (TDD §3): caps table, the evidence marker regex,
// the action shape, and the state shape-checker the property test leans on.
import {
  CAPS, CURRENT_VERSION, LISTS, COMPACTING_LISTS, ERR, EVIDENCE_MARKER, MALFORMED_CODES,
  EVIDENCE_CODES, READONLY_FIELDS, RUNTIME_EXT_KEYS, SETTABLE_FIELDS, KNOWN_FIELDS,
  emptyState, stateError, itemError, isAction, cloneState,
} from "../../lib/state/schema.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();

console.log("\ncaps + constants");
ok("CAPS.ID is present and bounds the one field the table forgot", CAPS.ID === 32);
ok("every cap is a positive integer", Object.values(CAPS).every(v => Number.isInteger(v) && v > 0));
ok("CURRENT_VERSION is 3", CURRENT_VERSION === 3);
ok("the four lists are the PRD's four", LISTS.join() === "done,in_flight,next,blockers");
ok("only `done` compacts — the working lists reject instead (§3.1)", COMPACTING_LISTS.join() === "done");
ok("STALE is NOT an ErrCode: it is the store's CAS outcome (§3.3)", !("STALE" in ERR));
ok("MIGRATE_FAILED is", ERR.MIGRATE_FAILED === "MIGRATE_FAILED");
ok("malformed and evidence codes are disjoint (§7.3)",
  MALFORMED_CODES.every(c => !EVIDENCE_CODES.includes(c)) && EVIDENCE_CODES.length === 2);
ok("every ErrCode is classified as one or the other",
  Object.values(ERR).filter(c => c !== ERR.MIGRATE_FAILED)
    .every(c => MALFORMED_CODES.includes(c) || EVIDENCE_CODES.includes(c)));
ok("nothing settable is also readonly",
  SETTABLE_FIELDS.every(f => !READONLY_FIELDS.includes(f)));
ok("settable and readonly are all known fields",
  [...SETTABLE_FIELDS, ...READONLY_FIELDS].every(f => KNOWN_FIELDS.includes(f)));
ok("the runtime ext keys are named", RUNTIME_EXT_KEYS.join() === "_gate,_promoted");

console.log("\nthe evidence marker — one regex, this file, nowhere else");
const m1 = EVIDENCE_MARKER.exec("wire the promoter @lib/state/promote.mjs,test/state/test-promote.mjs");
ok("extracts a comma list", m1?.[1] === "lib/state/promote.mjs,test/state/test-promote.mjs");
ok("prose before the marker is untouched",
  "wire the promoter @a.mjs".slice(0, EVIDENCE_MARKER.exec("wire the promoter @a.mjs").index) === "wire the promoter");
ok("no marker on plain prose", EVIDENCE_MARKER.exec("just some text") === null);
ok("an email-ish mid-string @ is not a marker", EVIDENCE_MARKER.exec("ask me@example.com about it") === null);
ok("trailing whitespace after the marker still matches", EVIDENCE_MARKER.exec("text @a/b.mjs  ")?.[1] === "a/b.mjs");

console.log("\naction shapes (§3.2) — every turn must act, finish, or ask");
ok("tool action", isAction({ tool: "Bash", input: { command: "ls" } }));
ok("done action", isAction({ done: true }));
ok("ask action", isAction({ ask: "which branch?" }));
ok("continue action — the honest name for mid-card work (§4.6)", isAction({ continue: true }));
ok("missing action is not an action", !isAction(undefined) && !isAction(null));
ok("two variants at once is not an action", !isAction({ done: true, ask: "x" }));
ok("tool without input is not an action", !isAction({ tool: "Bash" }));
ok("done:false is not an action", !isAction({ done: false }));

console.log("\nstate shape");
ok("a blank state is schema-valid", stateError(emptyState(1, "seat")) === "");
const bad = emptyState();
bad.rev = -1;
ok("a negative rev is caught", stateError(bad).includes("rev"));
const unknown = emptyState();
unknown.wat = 1;
ok("an unknown top-level key is caught", stateError(unknown).includes("unknown key"));
const longId = emptyState();
longId.in_flight = [{ id: "z".repeat(CAPS.ID + 1), text: "t" }];
ok("an over-long id is caught by the shape check", stateError(longId).includes("CAPS.ID"));
ok("shape-check is total: it returns a string on garbage, never throws",
  typeof stateError(42) === "string" && typeof stateError(null) === "string");
ok("item shape rejects a stray key", itemError({ id: "a", text: "b", nope: 1 }).includes("unknown key"));
ok("item shape accepts paths", itemError({ id: "a", text: "b", paths: ["x.mjs"] }) === "");

console.log("\nclone");
const orig = emptyState(7, "s");
orig.in_flight = [{ id: "a", text: "t" }];
const copy = cloneState(orig);
copy.in_flight[0].text = "mutated";
ok("cloneState is structural, not shallow", orig.in_flight[0].text === "t");

done();
