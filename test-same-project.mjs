#!/usr/bin/env node
// #5760 — the same-project episode rule (lib/same-project.mjs), pure: fire once per membership
// CHANGE, never on a clock; an unchanged set re-warns never; a crew-only set is not a collision.
// The six contract cases (first sighting, unchanged set, member joins, member leaves, crew-only
// set, rejoin after leave) plus the hash and duration-label primitives.
import assert from "node:assert/strict";
import { durationLabel, memberSetHash, sameProjectDecision } from "./lib/same-project.mjs";

let pass = 0, fail = 0;
const ok = (condition, name) => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? "✓" : "✗"} ${name}`);
};

const NOW = 1_000_000_000_000;
const H = 3600_000;

console.log("# same-project episode rule tests (#5760)");

// 1. FIRST SIGHTING — an intruder present and nothing fired before: warn once, no duration.
{
  const d = sameProjectDecision({ previous: null, current: ["codex:alpha", "host:alpha"], declaredCrew: [], lastFiredAt: null, now: NOW });
  ok(d.fire === true && d.reason === "first-sighting", "first sighting fires");
  ok(d.durationMs === 0, "first sighting carries no duration");
  ok(JSON.stringify(d.intruders) === JSON.stringify(["codex:alpha", "host:alpha"]), "first sighting lists every non-crew session as an intruder");
}

// 2. UNCHANGED SET — the exact case from 08-31: the same members, hours later, NEVER re-warn.
{
  const d = sameProjectDecision({ previous: ["codex:alpha", "host:alpha"], current: ["host:alpha", "codex:alpha"], declaredCrew: [], lastFiredAt: NOW - 6 * H, now: NOW });
  ok(d.fire === false && d.reason === "unchanged", "unchanged set re-warns never, however long it holds");
}

// 3. MEMBER JOINS — a change fires once, and the record line's duration is how long it held.
{
  const d = sameProjectDecision({ previous: ["codex:alpha"], current: ["codex:alpha", "kimi:alpha"], declaredCrew: [], lastFiredAt: NOW - 6 * H, now: NOW });
  ok(d.fire === true && d.reason === "membership-changed", "a joining member fires the episode");
  ok(d.durationMs === 6 * H, `duration is now minus last fire (got ${d.durationMs})`);
}

// 4. MEMBER LEAVES — same rule: a change fires, duration carried.
{
  const d = sameProjectDecision({ previous: ["codex:alpha", "host:alpha"], current: ["codex:alpha"], declaredCrew: [], lastFiredAt: NOW - 30 * 60000, now: NOW });
  ok(d.fire === true && d.reason === "membership-changed", "a leaving member fires the episode too");
  ok(durationLabel(d.durationMs) === "30m", `duration label reports the hold (got ${durationLabel(d.durationMs)})`);
}

// 5. CREW-ONLY SET — the operator's declared crew is the NORMAL state, not a collision: never
// fires, not even on first sighting.
{
  const d = sameProjectDecision({ previous: null, current: ["glm:alpha", "codex:alpha", "MacBook-Pro-M1:alpha"], declaredCrew: ["glm:alpha", "codex:alpha", "MacBook-Pro-M1:alpha"], lastFiredAt: null, now: NOW });
  ok(d.fire === false && d.reason === "crew-only", "a declared crew alone never warns");
}

// 6. REJOIN AFTER LEAVE — a member leaving fired; the SAME member returning changes the set
// again: one more fire (a returning session genuinely needs the intro), then quiet.
{
  const first = sameProjectDecision({ previous: null, current: ["a:alpha", "b:alpha"], declaredCrew: [], lastFiredAt: null, now: NOW });
  ok(first.fire === true, "rejoin setup: first sighting fires");
  const afterLeave = sameProjectDecision({ previous: ["a:alpha", "b:alpha"], current: ["a:alpha"], declaredCrew: [], lastFiredAt: NOW, now: NOW + H });
  ok(afterLeave.fire === true, "the leave fires");
  const afterRejoin = sameProjectDecision({ previous: ["a:alpha"], current: ["a:alpha", "b:alpha"], declaredCrew: [], lastFiredAt: NOW + H, now: NOW + 2 * H });
  ok(afterRejoin.fire === true && afterRejoin.reason === "membership-changed", "the rejoin fires once");
  const settled = sameProjectDecision({ previous: ["a:alpha", "b:alpha"], current: ["b:alpha", "a:alpha"], declaredCrew: [], lastFiredAt: NOW + 2 * H, now: NOW + 3 * H });
  ok(settled.fire === false, "and after the rejoin, the same set is quiet again");
}

// Crew members are never counted as intruders, and an intruder alongside a crew still fires.
{
  const d = sameProjectDecision({ previous: null, current: ["glm:alpha", "codex:alpha", "stranger:alpha"], declaredCrew: ["glm:alpha", "codex:alpha"], lastFiredAt: null, now: NOW });
  ok(d.fire === true && JSON.stringify(d.intruders) === JSON.stringify(["stranger:alpha"]), "only sessions outside the declared crew are intruders");
}

// The hash is stable across order and duplicates, and differs across membership.
{
  ok(memberSetHash(["b", "a"]) === memberSetHash(["a", "b", "a"]), "hash ignores order and duplicates");
  ok(memberSetHash(["a", "b"]) !== memberSetHash(["a", "b", "c"]), "hash changes when the membership changes");
}

// Duration labels: hours, minutes, sub-minute.
{
  ok(durationLabel(6 * H) === "6h", "durationLabel: hours");
  ok(durationLabel(12 * 60000) === "12m", "durationLabel: minutes");
  ok(durationLabel(30_000) === "<1m", "durationLabel: under a minute");
}

console.log(`\nsame-project episode: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
