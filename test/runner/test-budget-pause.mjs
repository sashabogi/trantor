#!/usr/bin/env node
// #11864 — a card's token-budget pause lifts when the card is testing/done/failed, and a newer
// contract for another card is served instead of being held behind a stale message for the paused one.
import { budgetPause } from "../../lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
const SESSION = "glm:trantor";
const paused = { card: 11853, tokens: 900000 };
const msg = (id, text) => ({ id, to: SESSION, from: "orch@mac", text, ts: id });
const old = msg(1, "contract: card #11853 - trim the relay tool list");
const next = msg(2, "work #11854 now; #11853 is done");

ok("paused card moved to done -> lifted", budgetPause({ paused, status: "done", messages: [old], session: SESSION }).action === "lift");
ok("paused card in testing -> lifted", budgetPause({ paused, status: "testing", messages: [old], session: SESSION }).action === "lift");
ok("paused card failed -> lifted", budgetPause({ paused, status: "failed", messages: [old], session: SESSION }).action === "lift");

const b = budgetPause({ paused, status: "doing", messages: [old, next], session: SESSION });
ok("[old msg for paused card, new contract for card B] -> binds B", b.action === "bind" && b.card === 11854);
ok("the stale message is dropped, the contract is not", b.drop.length === 1 && b.drop[0] === old);

const keep = msg(3, "#11854 follows #11853, which is paused");
const b2 = budgetPause({ paused, status: "doing", messages: [old, keep], session: SESSION });
ok("a contract that mentions the paused card is never dropped", b2.action === "bind" && !b2.drop.includes(keep));

ok("batch only for the paused card, still open -> stays paused",
  budgetPause({ paused, status: "doing", messages: [old, msg(4, "contract: card #11853 - go on")], session: SESSION }).action === "hold");
ok("no pause -> none", budgetPause({ paused: null, status: "", messages: [next], session: SESSION }).action === "none");
ok("a batch that never cites the paused card -> none",
  budgetPause({ paused, status: "doing", messages: [msg(5, "contract: card #11900 - go")], session: SESSION }).action === "none");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
