#!/usr/bin/env node
// trantor wake-policy drill, session/card-binding half (#7061, #7763, #7765, #7060, #6289) —
// a wake names a card; these drills prove WHICH card the session binds to, live through the real
// runner: the assigned one, never a done card cited in passing, never a message-card transcript,
// and an armed seat says on every turn which path it took. Hermetic: mock hub + fake CLI.
// #9832 part 4: split out of test-wake-policy.mjs (it grew past the runner's per-suite cap); the
// shared mock harness is test/lib/wake-mock.mjs; turn-cost/cross-project stay in test-wake-policy.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";
import { createWakeHarness } from "../lib/wake-mock.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor wake-policy drill — session and card binding");

const { HUB, drill, setMock, close } = await createWakeHarness();

// The board shapes the #7763 drills serve: 7700 is a message-card transcript, 7701 the seat's real
// open card.
const MSGCARD_BOARD = {
  7700: { id: 7700, project: "tt-wake", title: "NEW BUS MESSAGE for you: [orch]: read this and answer the question inside", assignee: "codex:tt-wake", status: "todo" },
  7701: { id: 7701, project: "tt-wake", title: "the seat's real work card", assignee: "codex:tt-wake", status: "doing", updated: 2 },
};

// ---- drill 2: two cards -> two sessions -------------------------------------------------------
console.log("\n## one session per card");
{
  // #7763: the mock board serves the card the contract cites — on a real hub it exists, and the
  // runner now checks the board before binding.
  const r = await drill([{ text: "contract: card #7010, build the thing" }],
    { waitMs: 5000, cards: { 7010: { id: 7010, project: "tt-wake", title: "build the thing", assignee: "codex:tt-wake", status: "todo" } } });
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
  // #6289 regression (the #7763 rebinding must never touch the session SHAPE): the mock board
  // has NO #7020, so the binding resolves to nothing — the wake still opens its OWN fresh
  // session instead of silently resuming the kickoff's CLI session as a bare resume.
  ok("#6289: a wake whose card the board lacks still runs FRESH, never a bare resume",
    first.fresh.length === 1 && first.resumed.length === 0,
    `fresh=${first.fresh.length} resumed=${first.resumed.length}`);

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
  // The #7061 shape: the order opens with the card that just MERGED. The runner is the only thing
  // that writes the FRESH SESSION line, so the line is proof of what the machine believed.
  const r = await drill([
    { text: "#7037 is merged as a01f629 and pushed. YOUR CARD: #6983, fixes 2 and 3." },
  ], { waitMs: 5000, cards: {
    7037: { id: 7037, project: "tt-wake", title: "the merged card", assignee: "", status: "done" },
    6983: { id: 6983, project: "tt-wake", title: "fixes 2 and 3", assignee: "codex:tt-wake", status: "todo" },
  } });
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
  ], { waitMs: 5000, cards: {
    7040: { id: 7040, project: "tt-wake", title: "build the thing", assignee: "codex:tt-wake", status: "todo" },
    7041: { id: 7041, project: "tt-wake", title: "the merged one", assignee: "", status: "done" },
  } });
  ok("#7061: one batch, one session — the mentioned card does not buy a second one",
    r.wakeTurns.length === 1 && r.fresh.length === 1,
    `wakes=${r.wakeTurns.length} fresh=${r.fresh.length}`);
  ok("#7061: bound to the contract's card", r.wakeTurns[0]?.includes("FRESH SESSION for card #7040"),
    r.wakeTurns[0]?.slice(0, 400));
}

// ---- drill 2c: a wake citing a message-card resolves to the seat's REAL card (#7763, #7765) ----
// The kimi specimen: exit 0 at 1201s, stderr ending in "tried to close message-card #7731, but it
// doesn't exist on this board either" — a whole turn burned on a transcript instead of the
// question it carried. Now the runner checks the board BEFORE binding and reroutes.
console.log("\n## a message-card citation binds the seat's own card");
{
  const r = await drill([{ text: "#7700 is the transcript — answer the question inside it" }],
    { waitMs: 5000, cards: MSGCARD_BOARD, tasks: Object.values(MSGCARD_BOARD) });
  ok("#7765: the wake still buys its turn — the question gets reached, not dropped", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  ok("#7763: the turn is bound to the seat's REAL card, not the message-card",
    r.wakeTurns[0]?.includes("FRESH SESSION for card #7701"), r.wakeTurns[0]?.slice(0, 400));
  ok("#7763: the seat is never sent to read the message-card as its card",
    !r.wakeTurns[0]?.includes("relay_board with card:7700"), r.wakeTurns[0]?.slice(0, 400));
  ok("#7763: the rules name the mine view as the no-card-id first call",
    r.wakeTurns[0]?.includes("relay_board with mine:true"), r.wakeTurns[0]?.slice(0, 400));
}
{
  // The phantom shape — the exact id kimi died on: the board does not have the card AT ALL. No
  // confirmed title means no reroute and no binding either: the turn still happens, the question
  // still rides, and the rules send the seat to its mine view instead of chasing the id.
  const r = await drill([{ text: "close message-card #7731, then: is the gate green?" }], { waitMs: 5000 });
  ok("#7765: a wake naming a NON-EXISTENT message-card still gets the question answered",
    r.wakeTurns.length === 1 && r.wakeTurns[0]?.includes("is the gate green?"), r.wakeTurns[0]?.slice(0, 400));
  ok("#7765: the phantom id binds NO card — the seat is never sent to chase it",
    !r.wakeTurns[0]?.includes("FRESH SESSION for card #7731") && !r.wakeTurns[0]?.includes("relay_board with card:7731"),
    r.wakeTurns[0]?.slice(0, 400));
  ok("#7765: the no-card-id rule points the seat at its own cards instead",
    r.wakeTurns[0]?.includes("relay_board with mine:true"), r.wakeTurns[0]?.slice(0, 400));
}
{
  // Regression guard: a wake citing a REAL card must bind exactly as before — the board check may
  // only reroute message-cards and phantoms, never ordinary contracts.
  const r = await drill([{ text: "contract: card #7702, build the thing" }],
    { waitMs: 5000, cards: { 7702: { id: 7702, project: "tt-wake", title: "build the thing", assignee: "codex:tt-wake", status: "todo" } } });
  ok("#7763: an ordinary contract still binds its own card, unchanged",
    r.wakeTurns.length === 1 && r.wakeTurns[0]?.includes("FRESH SESSION for card #7702"), r.wakeTurns[0]?.slice(0, 400));
}

// ---- drill 2d: an armed seat SAYS which path each turn took (#7060) ---------------------------
// #7060: the boot line used to read "ASSEMBLE mode ON" while the kickoff turn could never be
// assembled (a kickoff has no wake, so no card). The runner is armed for real here — claude seat,
// a CLI whose --help carries --json-schema — and STDOUT is the evidence this card is about.
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
  setMock({ queued: [{ from: "sasha@mac", project: PROJ, text: "next: rebase and re-run your own test file, then report back" }], served: 0, links: [], sent: [] });
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

close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
