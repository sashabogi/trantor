#!/usr/bin/env node
// trantor wake-policy drill, sender-notice half (#7766, #7288) — the seat speaks back: a demoted
// direct message TELLS its sender (silence read as a dead seat), and a threaded reply riding `re`
// is a work order, never swallowed as a receipt. Hermetic: mock hub + fake CLI, REAL runner.
// #9832 part 4: split out of test-wake-policy.mjs (it grew past the runner's per-suite cap); the
// shared mock harness is test/lib/wake-mock.mjs.
import { createWakeHarness } from "../lib/wake-mock.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };

console.log("# trantor wake-policy drill — demotion notices and threaded replies");

const { drill, drillSequence, close } = await createWakeHarness();

// ---- drill 1b: a demotion tells its sender (#7766) ----------------------------------------------
// Silence was the second half of the defect: a dropped ask looked like a dead seat. Whatever is
// still demoted says so; the sender's own wake:false and kind:status chatter stay quiet (the
// notice is itself kind status — answering one would loop).
console.log("\n## a demotion tells its sender");
{
  const r = await drill([
    { from: "hub:duty", text: "🤝 OVERSEER file-conflict: another seat edits the file you hold", ts: Date.now() - 31 * 60_000 },
    { text: "contract: card #7800, the real work" },
  ], { waitMs: 5000 });
  ok("#7766: the real work in the batch still buys its turn", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  const notices = r.sent.filter(m => m.to === "hub:duty" && /did not turn on your direct message/.test(m.text || ""));
  ok("#7766: a demoted direct message (expired hub alert) tells its sender, once",
    notices.length === 1, JSON.stringify(r.sent.map(m => ({ to: m.to, text: m.text }))));
}
{
  const r = await drill([{ text: "fyi only, nothing owed", wake: false }]);
  ok("#7766: the sender's own wake:false batches silently — no demotion notice",
    r.wakeTurns.length === 0 && !r.sent.some(m => /did not turn on your direct message/.test(m.text || "")),
    `${r.wakeTurns.length} wake turn(s)`);
}
{
  const r = await drill([{ kind: "status", text: "presence ping, nothing owed" }]);
  ok("#7766: a direct kind:status still never buys a turn and stays silent",
    r.wakeTurns.length === 0 && !r.sent.some(m => /did not turn on your direct message/.test(m.text || "")),
    `${r.wakeTurns.length} wake turn(s)`);
}

// ---- drill 4: a threaded reply is not a receipt (#7288) ---------------------------------------
// The live failure: the orchestrator answered the seat's done-receipt with a corrected contract,
// relay_send-style with `re` set — and isReceipt() read re>0 as "receipt", consuming the order
// before direct-address logic ever saw it. The seat stayed parked while the hub showed WAITING.
console.log("\n## threaded replies");
{
  const r = await drill([
    { text: "corrected contract for #7288: the seat must wake on this", re: 18684 },
  ], { waitMs: 5000 });
  ok("#7288: a direct work order riding `re` wakes the seat", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
}
{
  const r = await drill([{ kind: "receipt", text: "whatever the text says" }], { waitMs: 5000 });
  ok("a typed receipt still never wakes", r.wakeTurns.length === 0, `${r.wakeTurns.length} wake turn(s)`);
}
{
  const r = await drill([{ text: "✅ done on codex:t (exit 0, 9s) · asked: \"x\"" }], { waitMs: 5000 });
  ok("the stable ✅ marker still never wakes", r.wakeTurns.length === 0, `${r.wakeTurns.length} wake turn(s)`);
}
{
  // The ledger leg: an ack threaded onto a receipt this seat actually SENT is consumed as a
  // receipt — dropped, never batched as context, and it buys no turn.
  const r = await drillSequence([
    [{ text: "contract: card #9100, build it" }],
    [{ text: "thanks, accepted — nothing more owed on that card; the gate is mine", re: "@receipt" }],
    [{ text: "contract: card #9101, next one" }],
  ], { waitMs: 9000 });
  const receipt = r.sent.find(m => m.kind === "receipt");
  ok("#7288: the seat really reported its outcome first (the thread target exists)",
    Boolean(receipt), JSON.stringify(r.sent.map(m => m.kind)));
  ok("#7288: the ack threaded onto the seat's own receipt buys NO turn", r.wakeTurns.length === 2,
    `${r.wakeTurns.length} wake turn(s)`);
  ok("#7288: the ack was consumed as a receipt, not kept as context",
    r.wakeTurns.length === 2 && !r.wakeTurns[1].includes("nothing more owed"), r.wakeTurns[1]?.slice(0, 300));
}

close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
