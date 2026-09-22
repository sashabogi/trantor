#!/usr/bin/env node
// trantor turn-usage drill — hermetic. Fixture sqlite db in a temp dir, real lib logic; the real
// ~/.local/share/opencode db is never opened. Runs under `node test/run.mjs --only runner`.
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { sumOcRows, ocTurnUsage, usageTotal } from "../../lib/turn-usage.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
console.log("# trantor turn-usage drill");

let n = 0;
function tmpdb() {
  const dir = mkdtempSync(join(tmpdir(), `tt-usage-${n++}-`));
  return { dir, db: join(dir, "opencode.db") };
}
function makeDb(db, rows) {
  const sql = [
    "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);",
    ...rows.map((r, i) => `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_${i}', '${r.sid}', ${r.t}, ${r.t}, '${r.data.replaceAll("'", "''")}');`),
  ].join("\n");
  const r = spawnSync("sqlite3", [db], { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture db failed: ${r.stderr}`);
  return db;
}
const tokens = (i, o, cr, cw) => JSON.stringify({ role: "assistant", tokens: { input: i, output: o, cache: { read: cr, write: cw } } });

console.log("\nParser (sqlite3 list-mode rows -> usage):");
{
  ok("sums one row", JSON.stringify(sumOcRows("10|20|300|4")) === JSON.stringify({ input: 10, output: 20, cacheRead: 300, cacheWrite: 4 }));
  ok("sums many rows", sumOcRows("10|20|300|4\n1|2|3|0").input === 11 && true);
  const s = sumOcRows("10|20|300|4\n1|2|3|0");
  ok("...all four fields", s.output === 22 && s.cacheRead === 303 && s.cacheWrite === 4, JSON.stringify(s));
  ok("absent field (empty) counts 0", sumOcRows("10||300|").cacheRead === 300 && sumOcRows("10||300|").input === 10);
  ok("no rows = null (unknown, never 0)", sumOcRows("") === null && sumOcRows(null) === null);
  ok("corrupt number poisons to null", sumOcRows("10|twenty|300|4") === null);
  ok("wrong column count poisons to null", sumOcRows("10|20|300") === null);
  ok("negative number poisons to null", sumOcRows("-10|20|300|4") === null);
  ok("usageTotal", usageTotal({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }) === 10 && usageTotal(null) === 0);
}

console.log("\nReader over a fixture sqlite db:");
{
  const { db } = tmpdb();
  const SID = "ses_fixture01", T = 1_700_000_000_000;
  makeDb(db, [
    { sid: SID, t: T + 1000, data: tokens(10, 20, 300, 4) },      // in window
    { sid: SID, t: T + 2000, data: tokens(1, 2, 3, 0) },          // in window
    { sid: SID, t: T - 5000, data: tokens(999, 999, 999, 999) },  // before the turn — must drop
    { sid: SID, t: T + 3000, data: JSON.stringify({ role: "assistant" }) }, // no tokens object
    { sid: SID, t: T + 1500, data: JSON.stringify({ role: "user", tokens: { input: 777 } }) }, // wrong role
    { sid: "ses_other999", t: T + 1000, data: tokens(888, 888, 888, 888) },  // other session
    { sid: SID, t: T + 2500, data: tokens(0, 0, 0, 0) },          // real reported zero
  ]);
  const u = ocTurnUsage(db, SID, T, T + 10_000);
  ok("sums only this session's in-window assistant rows",
    JSON.stringify(u) === JSON.stringify({ input: 11, output: 22, cacheRead: 303, cacheWrite: 4 }), JSON.stringify(u));
  ok("window excludes newer rows too", ocTurnUsage(db, SID, T + 10_001, T + 20_000) === null);
  ok("bad session id = null", ocTurnUsage(db, "not-a-sid", T, T + 10_000) === null);
  ok("empty session id = null", ocTurnUsage(db, "", T, T + 10_000) === null);
  ok("missing db file = null", ocTurnUsage(join(tmpdb().dir, "nope.db"), SID, T, T + 10_000) === null);
  ok("non-finite window = null", ocTurnUsage(db, SID, NaN, T + 10_000) === null);
  ok("inverted window = null", ocTurnUsage(db, SID, T + 10_000, T) === null);
  ok("spawner failure = null", ocTurnUsage(db, SID, T, T + 10_000, () => { throw new Error("boom"); }) === null);
  ok("sqlite error = null", ocTurnUsage(db, SID, T, T + 10_000, () => ({ status: 1, stderr: "no such table" })) === null);
  ok("error object = null", ocTurnUsage(db, SID, T, T + 10_000, () => ({ error: new Error("spawn"), status: null })) === null);
}

console.log("\nReal-spawn smoke over the fixture (the ocSid mechanics, unmocked):");
{
  const { db } = tmpdb();
  const SID = "ses_real01", T = 1_700_000_500_000;
  makeDb(db, [{ sid: SID, t: T + 100, data: tokens(5, 6, 7, 8) }]);
  const u = ocTurnUsage(db, SID, T, T + 1000);
  ok("real sqlite3 CLI path sums correctly",
    JSON.stringify(u) === JSON.stringify({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }), JSON.stringify(u));
  ok("fixture file was actually created", existsSync(db));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
