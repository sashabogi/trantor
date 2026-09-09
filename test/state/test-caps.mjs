#!/usr/bin/env node
// Trantor State P0 — caps hold on counts AND content (TDD §3.1). One case per key of CAPS,
// the asymmetry between history (compacts) and working lists (reject), and the rule the review
// bought: the evidence marker survives capping.
import { CAPS, ERR, emptyState, stateError } from "../../lib/state/schema.mjs";
import { validateTurn } from "../../lib/state/validate.mjs";
import { applyTurn } from "../../lib/state/apply.mjs";
import { harness, turn } from "./_helpers.mjs";

const { ok, done } = harness();
const covered = new Set();
const cover = (key, name, cond, detail) => { covered.add(key); ok(name, cond, detail); };

const fresh = (over = {}) => ({ ...emptyState(1, "seat"), ...over });
const fill = (list, n, prefix = "f") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, text: `item ${i}` }));

console.log("\nID — the one field the cap table forgot");
cover("ID", "an over-long id is a CAP rejection, never a trim",
  validateTurn(fresh(), turn([{ add: { list: "next", item: { id: "z".repeat(CAPS.ID + 1), text: "t" } } }])).code === ERR.CAP);
cover("ID", "an id exactly at the cap is fine",
  validateTurn(fresh(), turn([{ add: { list: "next", item: { id: "z".repeat(CAPS.ID), text: "t" } } }])).ok === true);
ok("a trimmed id would no longer address the item, which is why it rejects",
  validateTurn(fresh(), turn([{ add: { list: "next", item: { id: "z".repeat(CAPS.ID + 1), text: "t" } } }]))
    .message.includes("trimmed"));

console.log("\nITEM / ITEM_PATHS / PATH — the evidence marker survives capping (§3)");
const marked = applyTurn(fresh(), turn([{
  add: { list: "next", item: { id: "a", text: `${"p".repeat(CAPS.ITEM + 100)} @lib/state/apply.mjs,lib/state/validate.mjs` } },
}]));
cover("ITEM", "prose is truncated to CAPS.ITEM", marked.state.next[0].text.length === CAPS.ITEM);
cover("ITEM_PATHS", "and EVERY path survives the truncation",
  marked.state.next[0].paths.join() === "lib/state/apply.mjs,lib/state/validate.mjs");
cover("ITEM_PATHS", "more paths than CAPS.ITEM_PATHS is CAP, not a silent drop",
  validateTurn(fresh(), turn([{ add: { list: "next", item: { id: "a", text: `x @${Array.from({ length: CAPS.ITEM_PATHS + 1 }, (_, i) => `f${i}.mjs`).join(",")}` } } }])).code === ERR.CAP);
cover("PATH", "a path over CAPS.PATH is CAP",
  validateTurn(fresh(), turn([{ add: { list: "next", item: { id: "a", text: `x @${"p".repeat(CAPS.PATH + 1)}` } } }])).code === ERR.CAP);
ok("a malformed marker is rejected, never accepted-and-trimmed",
  validateTurn(fresh(), turn([{ add: { list: "next", item: { id: "a", text: "x @../escape.mjs" } } }])).code === ERR.CAP);

console.log("\nLIST — history compacts, working lists reject (the asymmetry is deliberate)");
const fullDone = fresh({ done: fill("done", CAPS.LIST, "d") });
const overflowed = applyTurn(fullDone, turn([{ add: { list: "done", item: { id: "extra", text: "one more", paths: [] } } }]),
  { verify: { tested: true, exit: 0 } });
cover("LIST", "done overflow COMPACTS into done_count",
  overflowed.ok && overflowed.state.done.length === CAPS.LIST && overflowed.state.done_count === 1,
  JSON.stringify({ len: overflowed.state?.done.length, count: overflowed.state?.done_count }));
ok("the compacted state is still schema-valid", stateError(overflowed.state) === "");
for (const list of ["in_flight", "next", "blockers"]) {
  const full = fresh({ [list]: fill(list, CAPS.LIST, "w") });
  const r = validateTurn(full, turn([{ add: { list, item: { id: "extra", text: "one more" } } }]));
  cover("LIST", `${list} overflow is a CAP rejection naming the list`,
    r.code === ERR.CAP && r.message.includes(list), JSON.stringify(r));
}
ok("nothing is dropped on that rejection — a silently dropped blocker is the worst outcome",
  applyTurn(fresh({ blockers: fill("blockers", CAPS.LIST, "w") }),
    turn([{ add: { list: "blockers", item: { id: "extra", text: "x" } } }])).ok === false);
ok("no _count field exists for the working lists",
  ["in_flight_count", "next_count", "blockers_count"].every(k => !(k in emptyState())));

console.log("\nFILES — overflow compacts into files_count, evidence-carrying paths last");
const manyFiles = fresh();
for (let i = 0; i < CAPS.FILES; i++) manyFiles.files[`lib/f${i}.mjs`] = { touched: false, verified: false };
manyFiles.files["lib/credited.mjs"] = { touched: true, verified: true, hash: "sha" };
const trimmed = applyTurn(manyFiles, turn([]), { files: { "lib/new.mjs": { touched: true } } });
cover("FILES", "files is held at CAPS.FILES", Object.keys(trimmed.state.files).length === CAPS.FILES);
cover("FILES", "and files_count records what went", trimmed.state.files_count > 0);
ok("a credited path is the LAST to go — it is the only one carrying evidence",
  trimmed.state.files["lib/credited.mjs"]?.verified === true);

console.log("\nNOTES — content truncated by whole lines, never mid-string (#6528)");
const chatty = fresh({ notes: "" });
const bigNote = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
const capped = applyTurn(chatty, turn([{ set: { field: "notes", value: bigNote } }]));
cover("NOTES", "notes is held under CAPS.NOTES", Buffer.byteLength(capped.state.notes, "utf8") <= CAPS.NOTES);
ok("the tail survives — the recent half is the useful half", capped.state.notes.includes("line 199"));
ok("and it is cut on line boundaries, not mid-line",
  capped.state.notes.split("\n").every(l => l === "" || /^line \d+ x+$/.test(l)));

console.log("\nTASK / EXT");
cover("TASK", "an over-long task is CAP",
  validateTurn(fresh(), turn([{ set: { field: "task", value: "t".repeat(CAPS.TASK + 1) } }])).code === ERR.CAP);
const extState = fresh();
const extOps = Array.from({ length: CAPS.EXT_KEYS + 4 }, (_, i) => ({ set: { field: `ext.k${i}`, value: i } }));
const extRes = applyTurn(extState, turn(extOps));
cover("EXT_KEYS", "ext is held at CAPS.EXT_KEYS",
  Object.keys(extRes.state.ext).length <= CAPS.EXT_KEYS);
const fatExt = applyTurn(fresh(), turn([{ set: { field: "ext.blob", value: "x".repeat(CAPS.EXT_BYTES * 2) } }]));
cover("EXT_BYTES", "ext is held under CAPS.EXT_BYTES",
  Buffer.byteLength(JSON.stringify(fatExt.state.ext), "utf8") <= CAPS.EXT_BYTES + 64);
ok("the runtime ext keys do not count against the model's budget",
  applyTurn(extState, turn(extOps), { gate: { hash: "x" } }).state.ext._gate !== undefined);

console.log("\ncoverage of the caps table itself");
const uncovered = Object.keys(CAPS).filter(k => !covered.has(k) && !["TAIL_TOKENS", "OBS_TOKENS"].includes(k));
ok(`every cap that bounds STATE has a case (${covered.size} covered)`, uncovered.length === 0, `uncovered: ${uncovered.join(", ")}`);
ok("TAIL_TOKENS/OBS_TOKENS bound the PROMPT, not the state — they belong to P5/P6, not here", true);

done();
