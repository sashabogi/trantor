#!/usr/bin/env node
// trantor wake-policy drill (#6134, #7766) — the two rules that cut the fleet's turn count:
// a turn costs a session (on a direct message the SENDER's wake flag decides: unset or true
// turns, false batches as context; receipts and kind:status never wake) and one session per card
// (a wake naming a new card = a FRESH CLI session). Hermetic: mock hub + fake CLI, REAL runner.
// #9832 part 4: the suite grew past the runner's per-suite cap, so it is split by feature — this
// file keeps the POLICY: the parsing unit tests, the live turn-cost and cross-project drills, and
// the hub's wake:false storage contract. Session/card binding lives in test-wake-card-binding,
// sender notices and threading in test-wake-demotions-threading; the shared mock harness is
// test/lib/wake-mock.mjs.
import { drillEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";
import { createWakeHarness } from "../lib/wake-mock.mjs";
import { cardRef, cardRefs, assignedCardRef, wakeCard, servedContractCard, carriesWork, parseTurnTokens, parseResetAt, quotaSpent, reasonWithBalances, quotaResetAt, isLinkedProject, senderProjectOf, stateSkipReason, isMessageCardTitle, OPEN_CARD_STATUSES } from "../../lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  // ---- #10824: the contract message BEING SERVED decides, never earlier batch text ---------------
  console.log("\n## #10824: the served contract names the card");
  const scc = (msgs) => servedContractCard(msgs, { session: "claude:t" });
  // The live ibkr shape: contract A (#X) still owed behind a no-delivery retry, then contract B
  // arrives naming only #Y. The row must say #Y — A's assignment must not reach across the queue.
  ok("#10824: a newer contract citing its own card beats an older contract's assignment",
    scc([
      { id: 4, to: "claude:t", text: "contract: work card #10173, run the gate" },
      { id: 5, to: "claude:t", text: "#10809 is the next one — the agent Approve prefill" },
    ]) === 10809, `got ${scc([{ id: 4, to: "claude:t", text: "contract: work card #10173, run the gate" }, { id: 5, to: "claude:t", text: "#10809 is the next one — the agent Approve prefill" }])}`);
  ok("#10824: the served message's OWN assignment wins inside it (#7061 kept)",
    scc([{ id: 1, to: "claude:t", text: "#7037 is merged as a01f629 and pushed. YOUR CARD: #6983, fixes 2 and 3." }]) === 6983);
  ok("#10824: a hub-stamped card field on the served message wins outright",
    scc([{ id: 1, to: "claude:t", text: "no ids in here at all", card: 7001 }]) === 7001);
  ok("#10824: a served note citing NOTHING defers to the contract still queued with it",
    scc([
      { id: 4, to: "claude:t", text: "contract: work card #10173, run the gate" },
      { id: 5, to: "claude:t", text: "quick heads-up, nothing carded" },
    ]) === 10173, `got ${scc([{ id: 4, to: "claude:t", text: "contract: work card #10173, run the gate" }, { id: 5, to: "claude:t", text: "quick heads-up, nothing carded" }])}`);
  ok("#10824: a batch with NO card anywhere binds nothing (and the runner must label it 0, not inherit)",
    scc([
      { id: 4, to: "claude:t", text: "resume where you left off" },
      { id: 5, to: "claude:t", text: "also, the hub was restarted" },
    ]) === 0);
  // The deference: chatter that re-cites the standing contract defers to it — the pinned #7061
  // drill's note ("#7041 is merged … carry on with #7040") must not steal the binding.
  ok("#10824: a newest message that re-cites an older assignment is commentary, and defers",
    scc([
      { id: 1, to: "claude:t", text: "contract: card #7040, build the thing" },
      { id: 2, to: "claude:t", text: "note: #7041 is merged, unrelated to yours — carry on with #7040" },
    ]) === 7040, `got ${scc([{ id: 1, to: "claude:t", text: "contract: card #7040, build the thing" }, { id: 2, to: "claude:t", text: "note: #7041 is merged, unrelated to yours — carry on with #7040" }])}`);
  ok("#10824: a mention-only batch (no direct messages) keeps the #7061 reading",
    scc([
      { id: 3, to: "all", text: "@claude take #7099 when free" },
    ]) === 7099);
  ok("#10824: an empty batch binds nothing", scc([]) === 0);

  // #7763/#7765: a MESSAGE-CARD is a transcript of a bus message parked on the board, never work.
  // The runner checks the board before binding, so the predicate lives where the other rules do.
  ok("#7763: a NEW BUS MESSAGE card is a message-card",
    isMessageCardTitle("NEW BUS MESSAGE for you: [MacBook-Pro-M1:trantor]: #7938 landed on main"));
  ok("#7763: the join note is one too",
    isMessageCardTitle("You just joined (your arrival was already announced on the bus). 1) relay_inbox"));
  ok("#7763: case and leading space do not hide it", isMessageCardTitle("  new bus messages for you: x"));
  ok("#7763: a real work title is never a message-card",
    !isMessageCardTitle("relay_board gains a my-cards view so seats can find their own cards"));
  ok("#7763: no title is nothing", !isMessageCardTitle("") && !isMessageCardTitle(null));
  ok("#7763: the open-work set is exactly doing/testing/todo",
    JSON.stringify(OPEN_CARD_STATUSES) === JSON.stringify(["doing", "testing", "todo"]));

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

// ---- the runner, against the mock hub ----------------------------------------------------------
const { HUB, drill, close } = await createWakeHarness();

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
  // #7766: the old shape-based veto is gone — the SENDER decides. An unflagged direct message
  // buys a turn whatever its text says; a sender who wants context must set wake:false.
  const r = await drill([{ text: "thanks, acknowledged" }]);
  ok("#7766: an unflagged direct message buys a turn even when the text reads as an ack",
    r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
}
{
  // #7766: the drill the card is ABOUT — no card id, no imperative word, no wake flag.
  const r = await drill([{ text: "did the gate pass on your last run?" }]);
  ok("#7766: a plain question, no card id, no imperative, default wake -> exactly one turn",
    r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
}
{
  // #7766: the field shape — the ask came from a sibling seat, not a host session, and still
  // must wake. The old runner-label veto is gone with the keyword net.
  const r = await drill([{ from: "kimi:tt-wake", text: "can you check the schema before you ship?" }]);
  ok("#7766: a plain question from a sibling seat wakes too, not only host senders",
    r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
}
{
  const r = await drill([{ text: "#7002 is bounced: the gate is red" }]);
  ok("a bounce naming a card wakes", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
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
  const hub = await startTestHub();
  const BASE = hub.base;
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
  await hub.stop();
}

close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
