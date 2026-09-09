#!/usr/bin/env node
// A reply must be able to name the message it ANSWERS (#6987).
//
// contractsFor matches a reply to a contract two ways: by an explicit `re` thread id, or — failing
// that — FIFO to the peer's OLDEST outstanding contract. The hub has always read `re`; relay_send
// had no way to SET it, so every agent-to-agent reply was loose and took the FIFO path.
//
// The consequence, seen repeatedly on 2026-09-09: answering a peer's NEWEST question silently
// closes their OLDEST contract and leaves the real one reading WAITING forever. One seat had to
// send three separate "closing my phantom rows, nothing owed" messages, each costing a turn, and
// the orchestrator's stop-hook chased contracts that had been answered long before.
//
// This asserts the matching rule directly, since it is pure given the message list.
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

/** contractsFor's matcher, mirrored: `re` wins, else FIFO by timestamp, and a reply is consumed. */
function match(mine, replies) {
  const byRe = new Map();
  for (const r of replies) if (r.re) byRe.set(Number(r.re), r);
  const loose = new Map();
  for (const r of replies) if (!r.re) { if (!loose.has(r.from)) loose.set(r.from, []); loose.get(r.from).push(r); }
  for (const arr of loose.values()) arr.sort((a, b) => a.ts - b.ts);
  return mine.sort((a, b) => a.ts - b.ts).map((c) => {
    let answer = byRe.get(c.id) || null;
    if (!answer) {
      const pool = loose.get(c.to) || [];
      const i = pool.findIndex((r) => r.ts > c.ts);
      if (i >= 0) answer = pool.splice(i, 1)[0];
    }
    return { id: c.id, answered: !!answer, by: answer?.id ?? null };
  });
}

const c = (id, ts) => ({ id, ts, to: "peer:x" });
const r = (id, ts, re) => ({ id, ts, from: "peer:x", ...(re ? { re } : {}) });

console.log("\nwithout `re`: one reply closes the WRONG contract");
{
  // Three questions asked; the peer answers only the third.
  const got = match([c(1, 100), c(2, 200), c(3, 300)], [r(90, 400)]);
  ok("the oldest is marked answered — by a reply that was not about it",
    got[0].answered === true, JSON.stringify(got));
  ok("the contract actually answered still reads WAITING",
    got[2].answered === false, "this is the phantom row that gets chased");
}

console.log("\nwith `re`: the reply lands on the contract it names");
{
  const got = match([c(1, 100), c(2, 200), c(3, 300)], [r(90, 400, 3)]);
  ok("the named contract is answered", got[2].answered === true && got[2].by === 90);
  ok("the older ones are untouched, and correctly still open",
    got[0].answered === false && got[1].answered === false, JSON.stringify(got));
}

console.log("\n`re` and loose replies coexist");
{
  // One targeted reply plus one loose: the targeted one binds, the loose one takes the oldest left.
  const got = match([c(1, 100), c(2, 200), c(3, 300)], [r(90, 400, 3), r(91, 410)]);
  ok("the targeted reply still binds to its own contract", got[2].by === 90);
  ok("the loose reply falls to the oldest remaining", got[0].by === 91, JSON.stringify(got));
  ok("and does not double-answer the targeted one", got[1].answered === false);
}

console.log("\na reply older than the contract never answers it");
{
  const got = match([c(5, 500)], [r(80, 100)]);
  ok("a reply that predates the ask is not an answer", got[0].answered === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
