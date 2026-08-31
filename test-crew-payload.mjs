#!/usr/bin/env node
// card #5683 — the crew-runner turn payload is capped.
//
// A fresh codex seat burned 306k tokens and crash-looped into a remote-compact 404: every turn of
// a resumed session re-fed the full lessons block (22,298 of 24,698 chars in the real turn file)
// plus an unbounded FYI-broadcast backlog, redelivery after redelivery. These drills pin the
// builder: per-section caps, relevance-ranked lessons, ONE hard total cap with a visible notice,
// and byte-identical output to the old concatenation for small payloads.
import { PAYLOAD_CAPS, capWake, capBcast, pickLessons, composePrompt } from "./bin/crew-payload.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); } };

console.log("# crew-runner payload caps (#5683)");

// ---- small-payload identity: the composed wake prompt must equal the legacy concatenation ----
{
  const wake = [{ from: "MacBook-Pro-M1:trantor", to: "opencode:trantor", text: "CONTRACT card #5683 — do the thing" }];
  const bcast = [{ from: "kimi:trantor", text: "turn failed, retrying" }];
  const rules = "Rules: you are the seat. End your turn when done.";
  const lessons = [
    { scope: "global", text: "End your turn when your work is done." },
    { scope: "global", text: "Never run the FULL npm test from a crew seat." },
  ];
  const wc = capWake(wake), bc = capBcast(bcast), ls = pickLessons(lessons, wc.text);
  const wakeText = `NEW BUS MESSAGE for you:\n${wc.text}\n`;
  const ctxText = `\nFYI broadcasts since your last turn (context only):\n${bc.text}\n`;
  const tail = "\nAct on what's addressed to you, then end your turn.\n\n";
  const built = composePrompt([
    { name: "wake", text: wakeText, trim: "truncate", order: 4 },
    { name: "ctx", text: ctxText, trim: "drop", order: 1 },
    { name: "tail", text: tail },
    { name: "rules", text: rules, trim: "drop", order: 3 },
    { name: "lessons", text: ls.text, trim: "drop", order: 2 },
  ]);
  const legacy = wakeText + ctxText + tail + rules
    + "\n\nLESSONS from previous crews (hard-won — follow them):\n- [global] End your turn when your work is done.\n- [global] Never run the FULL npm test from a crew seat.";
  ok("small wake payload is byte-identical to the legacy concatenation", built.prompt === legacy, JSON.stringify(built.prompt).slice(0, 200));
  ok("small payload is not flagged truncated", built.truncated === false);
}

// kickoff/pulse identity: base + capped lessons === old KICKOFF + LESSONS concatenation
{
  const lessons = [{ scope: "global", text: "Alpha lesson." }, { scope: "global", text: "Beta lesson." }];
  const base = "You just joined. 1) relay_inbox. 2) End your turn.\n\n" + "Rules: be brief.";
  const built = composePrompt([
    { name: "base", text: base },
    { name: "lessons", text: pickLessons(lessons, "").text, trim: "drop", order: 2 },
  ]);
  const legacy = base + "\n\nLESSONS from previous crews (hard-won — follow them):\n- [global] Alpha lesson.\n- [global] Beta lesson.";
  ok("small kickoff payload is byte-identical to the legacy concatenation", built.prompt === legacy);
}

// ---- wake section: last ~10 kept, earliest dropped, each body capped ----
{
  const many = Array.from({ length: 15 }, (_, i) => ({ from: `s${i}`, to: "opencode:trantor", text: `msg ${i}` }));
  const capped = capWake(many);
  ok("wake keeps the last 10 of 15", capped.kept === 10 && capped.total === 15);
  ok("wake drops the EARLIEST messages, not the newest", capped.text.startsWith("[s5]: msg 5") && capped.text.endsWith("msg 14"));
  const huge = [{ from: "a", to: "b", text: "x".repeat(5000) }];
  const hc = capWake(huge);
  ok("oversized wake body is cut at 2000 chars with a visible marker", hc.text.length < 2200 && hc.text.includes("+3,000 chars of this message dropped"));
  ok("a small wake body passes through untouched", capWake([{ from: "a", to: "b", text: "hi" }]).text === "[a]: hi");
}

// ---- broadcast context: last ~10 kept, each body capped ----
{
  const many = Array.from({ length: 30 }, (_, i) => ({ from: `b${i}`, text: `bc ${i}` }));
  const capped = capBcast(many);
  ok("broadcast context keeps the last 10 of 30", capped.kept === 10 && capped.total === 30);
  ok("broadcast keeps the newest, drops the oldest", capped.text.includes("[b29 -> all]: bc 29") && !capped.text.includes("bc 19\n") && !capped.text.includes("[b0 -> all]"));
  const big = Array.from({ length: 3 }, (_, i) => ({ from: `b${i}`, text: "y".repeat(1500) }));
  ok("oversized broadcast body is cut at 1000 chars with a visible marker", capBcast(big).text.includes("+500 chars dropped"));
}

// ---- lessons: relevance ranking, count cap, char cap ----
{
  const lessons = [
    { scope: "global", text: "Never run a global teardown while other crews are live." },
    { scope: "global", text: "Postgres round-trip: prove the store survives a restart before shipping." },
    { scope: "global", text: "Godot triangle winding controls culling, not set_normal." },
  ];
  const picked = pickLessons(lessons, "the pg store must round-trip a restart on Postgres");
  ok("the lesson sharing the trigger's words is IN the picked set", picked.text.includes("Postgres round-trip"));
  // relevance decides INCLUSION when the count cap forces a choice; display stays in stable order
  const crowd = [
    { scope: "global", text: "filler one" }, { scope: "global", text: "filler two" },
    { scope: "global", text: "Godot winding controls culling" },
    { scope: "global", text: "Postgres store must round-trip a restart before shipping" },
  ];
  const forced = pickLessons(crowd, "pg store restart", { ...PAYLOAD_CAPS, lessonsCount: 2 });
  ok("with a 2-lesson cap the relevant lesson wins a slot over earlier irrelevant ones",
    forced.kept === 2 && forced.text.includes("Postgres store") && !forced.text.includes("Godot winding"));
  const ranked = pickLessons(lessons, "");  // no trigger → original order stands
  ok("no trigger keeps the original order", ranked.text.indexOf("global teardown") < ranked.text.indexOf("Godot"));
  const hundred = Array.from({ length: 100 }, (_, i) => ({ scope: "global", text: `lesson number ${i} ` + "w".repeat(200) }));
  ok("lessons cap at 15 of 100", pickLessons(hundred, "").kept === 15);
  const fat = Array.from({ length: 15 }, (_, i) => ({ scope: "global", text: "z".repeat(4000) }));
  ok("lessons block is char-capped (~16k) even when 15 short lessons exceed it", pickLessons(fat, "").text.length <= PAYLOAD_CAPS.lessonsChars + 100);
}

// ---- ONE hard total cap: sections at their own caps still cannot stack past 40k ----
{
  const fatLessons = Array.from({ length: 200 }, (_, i) => ({ scope: "global", text: `L${i} ` + "a".repeat(2000) }));
  const bc = capBcast(Array.from({ length: 40 }, (_, i) => ({ from: `b${i}`, text: "c".repeat(1000) })));
  const wc = capWake(Array.from({ length: 12 }, (_, i) => ({ from: `s${i}`, to: "opencode:trantor", text: "m".repeat(2000) })));
  const ls = pickLessons(fatLessons, "ship the caps");
  const rules = "Rules: ".repeat(1200);   // 8.4k of rules
  const built = composePrompt([
    { name: "wake", text: `NEW BUS MESSAGE for you:\n${wc.text}\n`, trim: "truncate", order: 4 },
    { name: "ctx", text: `\nFYI broadcasts:\n${bc.text}\n`, trim: "drop", order: 1 },
    { name: "tail", text: "\nAct on what's addressed to you, then end your turn.\n\n" },
    { name: "rules", text: rules, trim: "drop", order: 3 },
    { name: "lessons", text: ls.text, trim: "drop", order: 2 },
  ]);
  ok("stacked max-size sections land under the 40k hard cap (notice aside)", built.prompt.length <= PAYLOAD_CAPS.totalChars + 300, `got ${built.prompt.length}`);
  ok("the truncation notice is IN the payload and names the trimmed sections", built.prompt.includes("[PAYLOAD TRUNCATED: hard cap 40,000 chars") && built.dropped.length >= 1);
  ok("the wake messages — the actual task — survive the cap", built.prompt.includes("[s11]: ") === true && built.prompt.includes("mmmm"));
  ok("ctx (FYI) is dropped before lessons, lessons before rules", built.dropped[0].startsWith("ctx") && built.dropped[1].startsWith("lessons"), built.dropped.join(" | "));
  ok("trimmed flag is set", built.truncated === true);
}

// ---- last resort: the wake section itself truncates rather than disappearing ----
{
  const wc = capWake(Array.from({ length: 10 }, (_, i) => ({ from: `s${i}`, to: "opencode:trantor", text: "m".repeat(2000) })));
  const built = composePrompt([
    { name: "wake", text: `NEW BUS MESSAGE for you:\n${wc.text}\n`, trim: "truncate", order: 4 },
    { name: "tail", text: "\nAct on what's addressed to you, then end your turn.\n\n" },
    { name: "rules", text: "Rules: keep going.", trim: "drop", order: 3 },
  ], { ...PAYLOAD_CAPS, totalChars: 5000 });
  ok("wake truncates to fit a tiny hard cap instead of busting it", built.prompt.length <= 5200, `got ${built.prompt.length}`);
  ok("wake truncation notice names it", built.dropped.some(d => d.startsWith("wake")));
  ok("rules are dropped BEFORE the wake section truncates, and the notice says so",
    !built.prompt.includes("keep going") && built.dropped[0].startsWith("rules"), built.dropped.join(" | "));
  ok("the runner-authored tail frame survives", built.prompt.includes("Act on what's addressed to you"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
