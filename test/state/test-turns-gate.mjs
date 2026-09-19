#!/usr/bin/env node
// Trantor State — §8.7 measures RUNWAY, so it may only judge runs that were stopped (#8066).
//
// PRD §5 metric 3 is "longer median turns-per-card before a forced cut vs baseline", and §8.7
// implemented it as a >= on turn count across every card. That is a runway metric: it asks how far
// a card gets before something forcibly stops it. Applied to a run that reached its own end it
// inverts — the fewer turns the state path needs to FINISH, the worse it scores.
//
// Found by running the real thing. The first live Phase-2a run finished card #6448 in ONE turn
// against a committed baseline of 149 turns that had landed nothing across three attempts, and the
// gate returned NO (FEWER_TURNS). The other four NOs on that run were honest could-not-evaluates;
// this one returned a substantive verdict and it was the wrong one.
//
// The regression §8.7 was written to catch is real and must keep failing: a state path cut EARLIER
// than the prose path. So the fix conditions on the terminal state rather than reversing the test.
import { turnsGate, turnsBeforeCut, wasCut } from "../../bin/state-bench.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();

const rows = (n, { cutAt = null } = {}) =>
  Array.from({ length: n }, (_, i) => (cutAt !== null && i === cutAt ? { turn: i + 1, cut: true } : { turn: i + 1 }));
const pair = (card, state, baseline) => ({ card, state, baseline });

console.log("\nthe helpers say which question is being asked");
ok("a run with no cut reports its full length", turnsBeforeCut(rows(5)) === 5);
ok("a run cut at index 2 reports 2", turnsBeforeCut(rows(5, { cutAt: 2 })) === 2);
ok("wasCut is false for a run that reached its end", wasCut(rows(5)) === false);
ok("wasCut is true for a cut run", wasCut(rows(5, { cutAt: 2 })) === true);

console.log("\nthe #6448 shape — finishing fast is not a miss");
{
  // Three cards, each finished by the state path in one turn, against long baselines.
  const g = turnsGate([1, 2, 3].map(c => pair(c, rows(1), rows(149))));
  ok("a state path that FINISHES in one turn passes §8.7", g.ok === true, `code=${g.code} msg=${g.message}`);
  ok("…and the verdict says why, rather than just passing quietly", /reached its own end/.test(g.message), g.message);
  ok("…and it still reports the medians for the record", g.state_median === 1 && g.baseline_median === 149,
    `${g.state_median} vs ${g.baseline_median}`);
}

console.log("\nthe regression it exists to catch still fails");
{
  // The real failure: the state path gets STOPPED, and earlier than the prose path was.
  const g = turnsGate([1, 2, 3].map(c => pair(c, rows(20, { cutAt: 1 }), rows(20, { cutAt: 10 }))));
  ok("a state path CUT earlier than baseline fails", g.ok === false, `ok=${g.ok}`);
  ok("…with FEWER_TURNS", g.code === "FEWER_TURNS", `got ${g.code}`);
  ok("…and the message says it judged only the cut cards", /WAS cut/.test(g.message), g.message);
}

console.log("\na cut state path that outlasts the baseline still passes");
{
  const g = turnsGate([1, 2, 3].map(c => pair(c, rows(20, { cutAt: 12 }), rows(20, { cutAt: 4 }))));
  ok("cut later than baseline passes", g.ok === true, `code=${g.code} msg=${g.message}`);
}

console.log("\nmixed cards — the finished ones must not dilute the cut ones");
{
  // Two cards finish in one turn; one is cut at turn 1 against a baseline cut at 10. The cut card
  // is a genuine regression and must not be averaged away by its well-behaved neighbours.
  const g = turnsGate([
    pair(1, rows(1), rows(149)),
    pair(2, rows(1), rows(149)),
    pair(3, rows(20, { cutAt: 1 }), rows(20, { cutAt: 10 })),
  ]);
  ok("one genuinely-cut card still fails the gate", g.ok === false, `ok=${g.ok} code=${g.code}`);
  ok("…and only the cut card was judged", g.cut_n === 1, `cut_n=${g.cut_n}`);
}

console.log("\nthe n floor is unchanged — one card is still an anecdote");
{
  const g = turnsGate([pair(1, rows(1), rows(149))]);
  ok("n below the floor carries forward, it does not pass", g.ok === false && g.code === "CARRY_FORWARD",
    `ok=${g.ok} code=${g.code}`);
  ok("…even when the single card looks perfect", /CARRIES FORWARD/.test(g.message), g.message);
}

done();
