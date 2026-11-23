#!/usr/bin/env node
// #13923 instance-fence drill, runner half — the runner's own-card resolution (the message-card
// reroute) applies the same seat-instance fence as relay_board's mine view: a card assigned to
// this NAME before THIS runner booted is a predecessor's. Units for the shared policy, then the
// REAL runner via the shared wake harness (mock hub + fake codex), as test-wake-card-binding.mjs.
import { ownCardForInstance, contractedCardIds } from "../../lib/turn-policy.mjs";
import { createWakeHarness } from "../lib/wake-mock.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const DAY = 864e5;

console.log("# trantor seat-instance fence drill (#13923)");

// ---- units: the policy both surfaces share --------------------------------------------------------
console.log("\n## the policy");
{
  const boot = Date.now();
  const stale = { id: 12138, ts: boot - 30 * DAY };
  const minted = { id: 2, ts: boot + 1 };
  ok("no stamp (solo session, old runner) fails OPEN — the pre-#13923 behavior",
    ownCardForInstance(stale, {}) && ownCardForInstance(stale, { bootTs: 0 }));
  ok("a card older than the instance is fenced", !ownCardForInstance(stale, { bootTs: boot }));
  ok("a card minted after the instance started is this instance's", ownCardForInstance(minted, { bootTs: boot }));
  ok("a fenced card the instance was contracted for is work again",
    ownCardForInstance(stale, { bootTs: boot, contractedIds: new Set([12138]) }));
  ok("a fenced card contracted to someone else stays fenced",
    !ownCardForInstance(stale, { bootTs: boot, contractedIds: new Set([7]) }));
  ok("a card with no ts at all cannot prove it is new, so it is fenced",
    !ownCardForInstance({ id: 3 }, { bootTs: boot }));

  const session = "codex-7:trantor";
  const msgs = [
    { to: session, from: "orch:trantor", ts: boot - DAY, text: "contract: work #12138 (pre-boot, a predecessor's)" },
    { to: session, from: "orch:trantor", ts: boot + 1000, text: "contract: work #200 now" },
    { to: session, from: "orch:trantor", ts: boot + 2000, text: "fyi #201 may be re-planned", wake: false },
    { to: session, from: "hub:trantor", ts: boot + 3000, text: "status: seat reaped #202", kind: "status" },
    { to: "all", from: "orch:trantor", ts: boot + 4000, text: `@codex-7 take #203 next` },
    { to: session, from: session, ts: boot + 5000, text: "already done: #204" },
    { to: session, from: "orch:trantor", ts: boot + 6000, card: 205, text: "no ids in this text at all" },
  ];
  const ids = contractedCardIds(msgs, { session, bootTs: boot });
  ok("a post-boot direct citation contracts (#200)", ids.has(200));
  ok("a hub-stamped card field contracts even with no text citation (#205)", ids.has(205));
  ok("a PRE-boot direct citation contracts nothing — it belonged to the predecessor", !ids.has(12138));
  ok("wake:false context contracts nothing", !ids.has(201));
  ok("kind:status chatter contracts nothing", !ids.has(202));
  ok("a broadcast @mention contracts nothing", !ids.has(203));
  ok("the session's own messages contract nothing", !ids.has(204));
  ok("no boot stamp keeps pre-boot direct citations (fail open) — wake:false stays context regardless",
    contractedCardIds(msgs, { session }).has(12138) && !contractedCardIds(msgs, { session }).has(201));
}

// ---- live: the reroute through the REAL runner -----------------------------------------------------
console.log("\n## the runner's own-card resolution");
const { drill, close } = await createWakeHarness();
const SESSION = "codex:tt-wake";

// The 11-20 shape on a mock board: the name's OLD assignment (a weeks-old testing card) plus the
// message-card a wake cites. Under the fence the reroute binds NOTHING — the turn still runs, the
// rules point the seat at its mine view, and the mine view (same fence) will pass the card over.
console.log("\n### an old assignment is ignored at the reroute");
{
  const OLD = 12138, MSG = 12100;
  const board = {
    [MSG]: { id: MSG, project: "tt-wake", title: "NEW BUS MESSAGE for you: [orch]: status check on the old card", assignee: SESSION, status: "todo" },
    [OLD]: { id: OLD, project: "tt-wake", title: "the iOS card a predecessor left in testing", assignee: SESSION, status: "testing", ts: Date.now() - 30 * DAY },
  };
  const r = await drill([{ text: `#${MSG} is the transcript — answer the question inside it` }],
    { waitMs: 6000, cards: board, tasks: Object.values(board) });
  ok("#13923: the wake still buys its turn — the question gets reached, not dropped",
    r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  ok("#13923: the reroute does NOT bind the inherited assignment (the #12138 incident shape)",
    !r.wakeTurns[0]?.includes(`FRESH SESSION for card #${OLD}`), r.wakeTurns[0]?.slice(0, 300));
  ok("#13923: the seat is still pointed at its own cards, never at the transcript",
    r.wakeTurns[0]?.includes("relay_board with mine:true") && !r.wakeTurns[0]?.includes(`relay_board with card:${MSG}`),
    r.wakeTurns[0]?.slice(0, 300));
}

// Same board, but the wake is the transcript OF a contract that cites the old card: a direct
// post-boot citation re-adopts it, and the reroute lands there exactly as before the fence.
console.log("\n### a post-start contract is picked up");
{
  const OLD = 22138, MSG = 22100;
  const board = {
    [MSG]: { id: MSG, project: "tt-wake", title: "NEW BUS MESSAGE for you: [orch]: the re-contract", assignee: SESSION, status: "todo" },
    [OLD]: { id: OLD, project: "tt-wake", title: "the old card, contracted again to the revived seat", assignee: SESSION, status: "todo", ts: Date.now() - 20 * DAY },
  };
  const r = await drill([{ text: `#${MSG} is the transcript of the contract for #${OLD} — do that work` }],
    { waitMs: 6000, cards: board, tasks: Object.values(board) });
  ok("#13923: a post-start contract citing the old card is picked up by the reroute",
    r.wakeTurns[0]?.includes(`FRESH SESSION for card #${OLD}`), r.wakeTurns[0]?.slice(0, 300));
}

close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
