#!/usr/bin/env node
// trantor wake-policy drill (#6134) — proves the two rules that cut the fleet's turn count:
//
//   1. A TURN COSTS A SESSION, so only a contract or a bounce buys one. A message sent with
//      wake:false batches into the next turn's context, and so does a direct message that carries
//      neither a card ref nor an instruction (the safety net for senders that never set the flag).
//   2. ONE SESSION PER CARD. A wake naming a different card starts a FRESH CLI session instead of
//      resuming — a seat that resumes forever replays every card it ever worked (qwen: 85.7M
//      tokens at 96.7% cached on 09-02).
//
// Hermetic: a mock hub (never touches the real ~/.agent-bus/bus.json) + a fake CLI that records
// every turn and how it was invoked, driving the REAL bin/crew-runner.mjs.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";
import { cardRef, cardRefs, assignedCardRef, wakeCard, carriesWork, parseTurnTokens, parseResetAt, quotaSpent, reasonWithBalances, quotaResetAt, isLinkedProject, senderProjectOf, stateSkipReason } from "../../lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor wake-policy drill");

// ---- unit: the policy itself, without a hub ---------------------------------------------------
console.log("\n## the rules");
{
  ok("a card ref is the session's card", cardRef("bounce on #6134, easy") === 6134);
  ok("a plain sentence names no card", cardRef("thanks, got it") === 0);
  ok("a card ref alone is work", carriesWork("look at #6134"));
  ok("an imperative alone is work", carriesWork("resume where you left off"));
  ok("an ack is NOT work", !carriesWork("thanks, acknowledged"));
  ok("a queue note is NOT work", !carriesWork("noted, I will queue that behind the current one"));

  // ---- #7061: which card a wake BINDS to ------------------------------------------------------
  // The live failure, verbatim in shape: the order opened with what shipped since the seat's last
  // turn and named the real card in its second sentence. `cardRef` bound the turn to the DONE
  // card, so the state sidecar, the card log and the run record were all written against #7037.
  const realOrder = "#7037 is merged as a01f629 and pushed. YOUR CARD: #6983, fixes 2 and 3.";
  ok("#7061: the pre-fix reading is the bug — first id in the text is the DONE card",
    cardRef(realOrder) === 7037);
  ok("#7061: binding by SHAPE picks the card the order ASSIGNS",
    wakeCard([{ to: "claude:t", id: 1, text: realOrder }], { session: "claude:t" }) === 6983,
    `got ${wakeCard([{ to: "claude:t", id: 1, text: realOrder }], { session: "claude:t" })}`);

  ok("an assignment label binds: YOUR CARD", assignedCardRef("shipped #1 · YOUR CARD: #6983") === 6983);
  ok("an assignment verb binds: take", assignedCardRef("#7037 merged. Contract: take #7061, it is yours.") === 7061);
  ok("an assignment verb binds through 'card'", assignedCardRef("Work order: take card #6897 (easy)") === 6897);
  ok("a bounce binds", assignedCardRef("#7002 is bounced: the gate is red") === 7002);
  ok("plain prose about a card assigns NOTHING", assignedCardRef("your 40593e5 for #6983 is merged and deployed") === 0);
  ok("a forward-looking mention does not steal the binding",
    assignedCardRef("take #7061 now; #7060 is next after this one") === 7061);

  ok("cardRefs lists every citation in order", JSON.stringify(cardRefs("#7037 done, take #6983, then #7060")) === "[7037,6983,7060]");

  // The batch axis: a direct contract outranks an @mention, and the NEWEST order wins.
  const batch = [
    { id: 4, to: "claude:t", text: "FYI #7037 is merged as a01f629" },
    { id: 9, to: "claude:t", text: "Contract: take #7061, the wrong-card binding you found" },
  ];
  ok("#7061: the newest ASSIGNMENT in the batch wins, not the oldest message",
    wakeCard(batch, { session: "claude:t" }) === 7061, `got ${wakeCard(batch, { session: "claude:t" })}`);
  // The @mention is the NEWER message here on purpose: only the direct-message preference can pick
  // #7061, so this assertion dies if that rule is dropped (it survived a mutation that did).
  ok("#7061: a direct contract outranks a LATER @mention citing another card",
    wakeCard([
      { id: 3, to: "claude:t", text: "YOUR CARD: #7061" },
      { id: 8, to: "all", text: "@claude take #7099 when free" },
    ], { session: "claude:t" }) === 7061,
    `got ${wakeCard([{ id: 3, to: "claude:t", text: "YOUR CARD: #7061" }, { id: 8, to: "all", text: "@claude take #7099 when free" }], { session: "claude:t" })}`);
  ok("#7061: two real orders in one batch -> the LATER one wins",
    wakeCard([
      { id: 4, to: "claude:t", text: "take #6983" },
      { id: 9, to: "claude:t", text: "change of plan, take #7061 instead" },
    ], { session: "claude:t" }) === 7061);
  ok("#7061: out-of-order ids still resolve newest-last",
    wakeCard([
      { id: 9, to: "claude:t", text: "take #7061" },
      { id: 4, to: "claude:t", text: "take #6983" },
    ], { session: "claude:t" }) === 7061);
  // The fallback is deliberately the OLD reading, narrowed to one message: nothing regresses to 0.
  ok("#7061: no assignment shape anywhere -> the newest message's first citation",
    wakeCard([
      { id: 1, to: "claude:t", text: "#111 and #222 are both interesting" },
      { id: 2, to: "claude:t", text: "anyway #333 then #444" },
    ], { session: "claude:t" }) === 333);
  ok("#7061: a wake citing no card at all still binds to nothing",
    wakeCard([{ id: 1, to: "claude:t", text: "resume where you left off" }], { session: "claude:t" }) === 0);
  ok("#7061: an empty batch binds to nothing", wakeCard([], { session: "claude:t" }) === 0);

  ok("codex's usage line is read", parseTurnTokens("thinking...\ntokens used: 12,345\ndone") === 12345);
  ok("the LAST running total wins", parseTurnTokens("tokens used 100\ntokens used 4,200") === 4200);
  ok("a CLI that prints no usage reports 0, not a guess", parseTurnTokens("done. exit 0") === 0);

  const now = Date.parse("2026-09-03T00:00:00Z");
  const abs = parseResetAt("You've hit your usage limit. Try again at Sep 3rd, 2026 3:34 AM", now);
  ok("codex's reset time is parsed off its own wall message", abs > now, `got ${abs}`);
  ok("a relative reset is parsed too", parseResetAt("try again in 45 minutes", now) === now + 45 * 60000);
  ok("no reset time means 0, never a made-up one", parseResetAt("API Error: 529 overloaded", now) === 0);

  ok("a spent quota row reads spent", quotaSpent([{ ok: true, kind: "quota", remainingPct: 0 }]));
  ok("a locked usage window reads spent", quotaSpent([{ ok: true, kind: "windows", windows: [{ usedPct: 100 }] }]));
  ok("a healthy row does not", !quotaSpent([{ ok: true, kind: "quota", remainingPct: 40 }]));
  // #6131: the qwen shape — the seat did not error, it went quiet with its plan spent.
  ok("#6131: a silent turn on a spent plan is EXHAUSTED, not a crash",
    reasonWithBalances("empty-output", [{ ok: true, kind: "quota", remainingPct: 0 }]) === "exhausted");
  ok("a silent turn on a healthy plan stays empty-output",
    reasonWithBalances("empty-output", [{ ok: true, kind: "quota", remainingPct: 80 }]) === "empty-output");
  ok("a backend error is never re-read as exhaustion",
    reasonWithBalances("backend-error", [{ ok: true, kind: "quota", remainingPct: 0 }]) === "backend-error");

  // #6131: quotaResetAt — the wake message never named a time, so the balance row is the only place
  // the seat's own reset instant lives. This is exactly the qwen shape: a fake 0% balances response.
  const soon = Date.now() + 6 * 86400e3;
  ok("quotaResetAt: a spent quota row's own resetTime wins",
    quotaResetAt([{ ok: true, kind: "quota", remainingPct: 0, resetTime: soon }]) === soon);
  ok("quotaResetAt: a healthy row names nothing — the seat isn't the one that's spent",
    quotaResetAt([{ ok: true, kind: "quota", remainingPct: 40, resetTime: soon }]) === 0);
  ok("quotaResetAt: spent but no reset time known → 0, never invented",
    quotaResetAt([{ ok: true, kind: "quota", remainingPct: 0, resetTime: null }]) === 0);
  const laterWin = Date.now() + 9 * 86400e3;
  ok("quotaResetAt: multiple locked windows → the EARLIEST reset wins (usable the moment the first wall lifts)",
    quotaResetAt([
      { ok: true, kind: "windows", windows: [{ usedPct: 100, resetsAt: laterWin }, { usedPct: 100, resetsAt: soon }] },
    ]) === soon);
  ok("quotaResetAt: an errored row is not evidence, even if it claims 0%",
    quotaResetAt([{ ok: false, kind: "quota", remainingPct: 0, resetTime: soon }]) === 0);
  ok("quotaResetAt: no rows → 0", quotaResetAt([]) === 0);

  // #6228: the runner's half of the cross-project guard — a wake from another project is dropped
  // unless the projects are declared linked. Pure decision logic first, the live drop below.
  ok("senderProjectOf reads the name suffix after the LAST colon", senderProjectOf("claude:crebral-com") === "crebral-com");
  ok("senderProjectOf: no colon -> no home project to fence", senderProjectOf("sasha@mac") === "");
  ok("isLinkedProject: the same project is always linked", isLinkedProject("pros", "pros", []));
  ok("isLinkedProject: no project on either side -> nothing to fence", isLinkedProject("", "crebral", []));
  ok("isLinkedProject: different, undeclared projects are NOT linked", !isLinkedProject("pros", "crebral", []));
  ok("isLinkedProject: a declared link opens the door", isLinkedProject("pros", "crebral", [{ projects: ["pros", "crebral"] }]));
  ok("isLinkedProject: a link naming OTHER projects opens nothing here",
    !isLinkedProject("pros", "crebral", [{ projects: ["a", "b"] }]));

  // #7060: the predicate the runner now reads to decide whether a turn is a state step AND to tell
  // the operator why it is not. One function, so the surface cannot drift from the behaviour — the
  // whole defect was a line that described a path the code was not on.
  const armed = { mode: true, kind: "wake", card: 7060 };
  ok("stateSkipReason: an armed wake carrying an assigned card IS a state step (null = no skip)",
    stateSkipReason(armed) === null);
  ok("stateSkipReason: a kickoff is never a state step, however good the config",
    /kickoff runs before any message arrives/.test(stateSkipReason({ ...armed, kind: "kickoff" })));
  ok("stateSkipReason: nor is a pulse — a timer is not a message",
    /pulse is a timer rather than a message/.test(stateSkipReason({ ...armed, kind: "pulse" })));
  ok("stateSkipReason: a wake that assigns no card names THAT, not the flag",
    /wake assigns no card/.test(stateSkipReason({ ...armed, card: 0 })));
  ok("stateSkipReason: a tripped breaker is its own reason, not silence",
    /breaker tripped/.test(stateSkipReason({ ...armed, breakerTripped: true })));
  ok("stateSkipReason: mode off is a reason too — never null, which would read as assembled",
    /state mode is off/.test(stateSkipReason({ ...armed, mode: false })));
  // Ordering is a claim, not an accident: on a pulse the structural fact binds whether or not the
  // breaker tripped, so that is the honest answer to "why was this turn not assembled".
  ok("stateSkipReason: on a pulse the structural reason wins over the breaker",
    /pulse is a timer/.test(stateSkipReason({ ...armed, kind: "pulse", breakerTripped: true })));
  ok("stateSkipReason: called with nothing, it does not claim a turn was assembled",
    stateSkipReason() !== null);
}

// ---- the runner, against a mock hub -----------------------------------------------------------
// Hands out one batch of messages, then stays silent. Whatever the seat does with them is the test.
let queued = [], served = 0, links = [], sent = [];
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/policy") return reply({ links, autonomy: { "*": 1 } });
    if (P === "/send") { try { sent.push(JSON.parse(buf || "{}")); } catch {} return reply({ ok: true, id: sent.length }); }
    if (P === "/poll") {
      if (served++ === 0 && queued.length) {
        return reply({ messages: queued.map((m, i) => ({ id: i + 1, ts: Date.now(), to: u.searchParams.get("session"), from: "sasha@mac", ...m })), cursor: 1 });
      }
      return setTimeout(() => reply({ messages: [], cursor: 1 }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// The fake CLI logs one record per turn: how it was invoked (`exec` = a fresh session, `resume` =
// continuing one) and the prompt it was handed. That is exactly what both rules are about.
async function drill(messages, { waitMs = 7000, projectLinks = [] } = {}) {
  queued = messages; served = 0; links = projectLinks; sent = [];
  const work = mkdtempSync(join(tmpdir(), "tt-wake-"));
  const HOME = join(work, "home");
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(work, "turns.log");
  const PROJ = "tt-wake";
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN=== mode=$1"; cat "$P"; } >> "${LOGF}"
echo "codex-drill: turn done"
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);

  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", work], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      CREW_KICKOFF: "say hi and end your turn" },
  });
  await sleep(waitMs);
  runner.kill("SIGKILL"); await sleep(150);

  const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
  return {
    turns,
    wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")),
    // `codex exec resume` passes "resume" as argv[1]; a fresh `codex exec` does not.
    fresh: turns.filter(t => t.includes("NEW BUS MESSAGE") && !/^ mode=resume/.test(t)),
    resumed: turns.filter(t => t.includes("NEW BUS MESSAGE") && /^ mode=resume/.test(t)),
    sent,
  };
}

// ---- drill 1: wake:false batches, a contract wakes --------------------------------------------
console.log("\n## a turn costs a session");
{
  const r = await drill([
    { text: "queued behind two other things, will get to it", wake: false },
    { text: "contract: work card #7001 now" },
  ]);
  ok("the contract still buys its turn", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  ok("the wake:false note rides along as CONTEXT, not as its own turn",
    r.wakeTurns.length === 1 && r.wakeTurns[0].includes("queued behind two other things"),
    r.wakeTurns[0]?.slice(0, 300));
}
{
  const r = await drill([{ text: "thanks, acknowledged", wake: false }]);
  ok("a wake:false message ALONE never starts a turn", r.wakeTurns.length === 0, `${r.wakeTurns.length} wake turn(s)`);
}
{
  // The safety net: the sender set no flag at all, and the message is plainly not work.
  const r = await drill([{ text: "thanks, acknowledged" }]);
  ok("an ack with no flag set batches on its shape alone", r.wakeTurns.length === 0, `${r.wakeTurns.length} wake turn(s)`);
}
{
  const r = await drill([{ text: "#7002 is bounced: the gate is red" }]);
  ok("a bounce naming a card wakes", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
}

// ---- drill 2: two cards -> two sessions -------------------------------------------------------
console.log("\n## one session per card");
{
  const r = await drill([{ text: "contract: card #7010, build the thing" }], { waitMs: 5000 });
  ok("the first card starts a FRESH session (it is not the kickoff's session)",
    r.fresh.length === 1 && r.resumed.length === 0, `fresh=${r.fresh.length} resumed=${r.resumed.length}`);
  ok("the fresh session is told it has no memory and where its card is",
    r.wakeTurns[0]?.includes("FRESH SESSION for card #7010") && r.wakeTurns[0]?.includes("relay_board with card:7010"),
    r.wakeTurns[0]?.slice(0, 300));
}
{
  // Both messages arrive in ONE batch, so they are one turn on the first card; the SECOND card is
  // what a later wake would carry. Two separate batches is the honest shape of that.
  const first = await drill([{ text: "contract: card #7020, build the thing" }], { waitMs: 5000 });
  ok("card A runs fresh", first.fresh.length === 1, `fresh=${first.fresh.length}`);

  const second = await drill([
    { text: "contract: card #7030, build the other thing" },
    { text: "contract: card #7030 again, same card" },
  ], { waitMs: 5000 });
  ok("two wakes citing the SAME card are one session, not two",
    second.wakeTurns.length === 1 && second.fresh.length === 1,
    `wakes=${second.wakeTurns.length} fresh=${second.fresh.length}`);
}

// ---- drill 2b: the wake binds to the card it ASSIGNS, live through the real runner (#7061) ----
console.log("\n## the bound card is the assigned one");
{
  // The shape that broke it on 2026-09-09: the order opens with the card that just MERGED. The
  // runner is the only thing that writes the FRESH SESSION line, so the line is proof of what the
  // machine believed — the same proof the card's own forensics rested on.
  const r = await drill([
    { text: "#7037 is merged as a01f629 and pushed. YOUR CARD: #6983, fixes 2 and 3." },
  ], { waitMs: 5000 });
  ok("#7061: the turn is bound to the ASSIGNED card, not the merged one",
    r.wakeTurns[0]?.includes("FRESH SESSION for card #6983"), r.wakeTurns[0]?.slice(0, 400));
  ok("#7061: and the done card is NOT what the seat is sent to read",
    !r.wakeTurns[0]?.includes("relay_board with card:7037"), r.wakeTurns[0]?.slice(0, 400));
}
{
  // Same card twice in one batch, with an unrelated id in the chatter: the session must not be
  // torn down and rebuilt on a card nobody assigned, and the seat is told which one it is on.
  const r = await drill([
    { text: "contract: card #7040, build the thing" },
    { text: "note: #7041 is merged, unrelated to yours — carry on with #7040" },
  ], { waitMs: 5000 });
  ok("#7061: one batch, one session — the mentioned card does not buy a second one",
    r.wakeTurns.length === 1 && r.fresh.length === 1,
    `wakes=${r.wakeTurns.length} fresh=${r.fresh.length}`);
  ok("#7061: bound to the contract's card", r.wakeTurns[0]?.includes("FRESH SESSION for card #7040"),
    r.wakeTurns[0]?.slice(0, 400));
}

// ---- drill 2c: an armed seat SAYS which path each turn took (#7060) ---------------------------
//
// The defect: the boot line read "ASSEMBLE mode ON for this seat" and the very next turn — the
// kickoff — could not possibly be assembled, because a kickoff has no wake and therefore no card.
// The seat that hit it had confirmed flags, a valid schema and an unassembled prompt, and nothing
// on the surface distinguished that from a working state path. So the runner is armed for real
// here, with a claude seat and a CLI whose --help carries --json-schema, and STDOUT is the
// evidence: what the operator can see is the whole subject of this card.
console.log("\n## an armed seat says which path each turn took");
{
  const work = mkdtempSync(join(tmpdir(), "tt-state-"));
  const HOME = join(work, "home");
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
  const PROJ = "tt-state";
  // --help has to carry the flag or hasJsonSchemaFlag() refuses and state mode never arms at all,
  // which would make this drill pass for the wrong reason.
  writeFileSync(join(fakebin, "claude"), `#!/bin/sh
case "$1" in --help) echo "  --json-schema <file>  hold the run to a grammar"; exit 0;; esac
echo "claude-drill: turn done"
exit 0
`);
  chmodSync(join(fakebin, "claude"), 0o755);

  // A real wake that buys a turn on its imperative alone and names no card: the OTHER way an armed
  // seat lands on the transcript path, and the one the operator is most likely to mistake for
  // proof, because unlike the kickoff it is a genuine work turn.
  queued = [{ from: "sasha@mac", project: PROJ, text: "next: rebase and re-run your own test file, then report back" }];
  served = 0; links = []; sent = [];
  const runner = spawn("node", ["bin/crew-runner.mjs", "claude", work], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "claude", RELAY_PROJECT: PROJ,
      TRANTOR_STATE_ASSEMBLE: "1", CREW_KICKOFF: "say hi and end your turn",
    },
  });
  let out = "";
  runner.stdout.on("data", c => (out += c));
  await sleep(6000);
  runner.kill("SIGKILL"); await sleep(150);

  ok("#7060: the seat really is armed, so the rest of this drill means something",
    /Trantor State: ASSEMBLE armed/.test(out), out.slice(0, 600));
  // The pre-fix line, verbatim. It is the claim the operator acted on and it must be gone.
  ok("#7060: the boot line no longer claims a mode the next turn cannot take",
    !/ASSEMBLE mode ON for this seat/.test(out), out.slice(0, 600));
  ok("#7060: boot names the ONE thing that engages it — a wake that assigns a card",
    /assembled only when a wake ASSIGNS it a card/.test(out), out.slice(0, 600));
  // The heart of the card: the kickoff is a skip, and a skip must not be mistaken for proof.
  ok("#7060: the kickoff says it is NOT assembled, instead of staying silent",
    /this turn is NOT assembled/.test(out), out.slice(0, 900));
  ok("#7060: and says WHY, in the terms of the turn's own shape",
    /NOT assembled — a kickoff runs before any message arrives, so it belongs to no card/.test(out),
    out.slice(0, 900));
  // A work turn that skips has to speak too, and name the wake rather than the flag — this is the
  // turn where "ON" was most misleading, because work really did happen on the transcript path.
  ok("#7060: a wake that assigns no card says so on ITS turn, not just at boot",
    /NOT assembled — this wake assigns no card, and a state turn is bound to exactly one/.test(out),
    out.slice(-900));
}

// ---- drill 3: a wake from another project is dropped, never worked (#6228) --------------------
console.log("\n## cross-project wakes are dropped");
{
  const r = await drill([
    { from: "claude:crebral-com", text: "contract: build card #7040 now" },
  ], { waitMs: 5000 });
  ok("a wake from another, unlinked project never buys a turn", r.wakeTurns.length === 0, `${r.wakeTurns.length} wake turn(s)`);
  const dropped = r.sent.filter(m => /cross-project/.test(m.text || ""));
  ok("the seat reports the drop back to the sender, once",
    dropped.length === 1 && dropped[0].to === "claude:crebral-com", JSON.stringify(r.sent));
}
{
  // Same shape, but the operator declared the projects linked: the wake goes through normally.
  const r = await drill([
    { from: "claude:crebral-com", text: "contract: build card #7050 now" },
  ], { waitMs: 5000, projectLinks: [{ projects: ["tt-wake", "crebral-com"] }] });
  ok("a linked project's wake still buys its turn", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  ok("nothing is reported as dropped once the projects are linked",
    !r.sent.some(m => /cross-project/.test(m.text || "")), JSON.stringify(r.sent));
}

// ---- the flag survives the REAL hub -----------------------------------------------------------
// The runner legs above prove what a seat does with `wake:false`; this proves the field actually
// gets there. Stored only when false, so every client that predates the flag is untouched.
console.log("\n## the hub carries the flag");
{
  const { spawn: spawnHub } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "tt-wake-hub-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const PORT = 47948;
  const proc = spawnHub("node", ["hub.mjs"], {
    cwd: process.cwd(),
    env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await sleep(1200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()).catch(e => ({ error: String(e) }));
  const get = (p) => fetch(BASE + p).then(r => r.json()).catch(e => ({ error: String(e) }));

  await post("/register", { session: "codex:wp", project: "wp", status: "active in wp" });
  await post("/send", { from: "host:wp", to: "codex:wp", project: "wp", text: "queued behind the current card", wake: false });
  await post("/send", { from: "host:wp", to: "codex:wp", project: "wp", text: "contract: card #9001" });
  const { messages } = await get(`/inbox?session=${encodeURIComponent("codex:wp")}&since=0`);
  const batched = (messages || []).find(m => /queued behind/.test(m.text || ""));
  const waking = (messages || []).find(m => /#9001/.test(m.text || ""));
  ok("the hub stores wake:false on the message", batched?.wake === false, JSON.stringify(batched));
  ok("and leaves it ABSENT on an ordinary send, so older clients are unchanged",
    waking && waking.wake === undefined, JSON.stringify(waking));
  proc.kill("SIGKILL");
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
