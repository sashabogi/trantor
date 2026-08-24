#!/usr/bin/env node
// trantor — a contract's reply link must survive a hub restart.
//
// 0.17.86 added `re` to /send: the id of the contract an outcome answers, which is what lets
// /contracts close the RIGHT one instead of guessing oldest-first. It threaded correctly in the
// hub's memory and was never persisted: the messages table had no such column, so the pg store
// dropped it on write and could not return it on read. A hub restart silently downgraded strict
// threading to a heuristic, which is exactly the class of "reported healthy while broken" this
// codebase keeps paying for.
import { SCHEMA_SQL } from "./lib/store-contract.mjs";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log("# trantor message-`re` durability");

const store = readFileSync(new URL("./lib/store-pg.mjs", import.meta.url), "utf8");

console.log("\nThe column exists, on new hubs and on ones that predate it:");
ok("the messages table declares re", /CREATE TABLE IF NOT EXISTS messages[\s\S]*?\bre\b[\s\S]*?PRIMARY KEY/i.test(SCHEMA_SQL), "not in CREATE TABLE");
ok("…and an additive ALTER carries existing databases forward",
  /ALTER TABLE messages ADD COLUMN IF NOT EXISTS re\b/i.test(SCHEMA_SQL), "no ALTER for re");

console.log("\nEvery write path carries it (a partial fix is how it broke the first time):");
const inserts = store.match(/INSERT INTO messages\([^)]*\)/g) || [];
ok("there is more than one insert path", inserts.length >= 2, `${inserts.length} found`);
ok("every INSERT INTO messages lists re", inserts.length > 0 && inserts.every(i => /\bre\b/.test(i)),
  inserts.filter(i => !/\bre\b/.test(i)).join(" | ").slice(0, 200));
const upserts = (store.match(/INSERT INTO messages[\s\S]{0,400}?DO UPDATE SET[^`]*/g) || []);
ok("the upsert path updates re too", upserts.length > 0 && upserts.every(u => /re=EXCLUDED\.re/.test(u)),
  upserts.filter(u => !/re=EXCLUDED\.re/.test(u)).join(" | ").slice(0, 200));

console.log("\nAnd the read path returns it:");
ok("msgFromRow maps re back onto the message", /function msgFromRow[\s\S]*?\bre:/.test(store), "msgFromRow drops it");
ok("…as a number or absent, never a string", /re: row\.re == null \? undefined : Number\(row\.re\)/.test(store),
  (store.match(/function msgFromRow[\s\S]*?\n}/) || [""])[0].slice(0, 240));

console.log(`\n${fail === 0 ? "✅" : "❌"} message-re: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
