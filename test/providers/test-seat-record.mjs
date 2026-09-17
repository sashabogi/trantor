#!/usr/bin/env node
// #7762 seat-record drill — the advisor's feedback loop. Pure fixtures (no hub, no LLM):
// computeSeatRecord derives completed/empty/bounced per seat from board cards + moved events +
// runner ledger rows; advise() benches a seat whose last 3 cards AT A DIFFICULTY produced
// nothing; a reset is the manual forgiveness path. Run: node test-seat-record.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeSeatRecord, benchedAt, resetSeat, resetsPathFor } from "../../lib/seat-record.mjs";
import { advise } from "../../bin/advise.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };

const T0 = 1_760_000_000_000;   // fixed base ts so resets can be newer than every fixture row
const card = (id, seat, difficulty, status, extra = {}) => ({
  id, project: "proj", title: `card ${id}`, assignee: `${seat}:proj`, difficulty, status,
  ts: T0 + id * 1000, updated: T0 + id * 1000, ...extra,
});
const row = (cardId, agent, outcome, tokens = 1_000_000, ts = T0 + cardId * 1000 + 1) =>
  ({ ts, agent, project: "proj", card: cardId, outcome, tokens });

// codex: three hard cards whose turns ALL produced nothing (empty/stalled/cut) + one clean medium
const cards = [
  card(1, "codex", "hard", "failed"),
  card(2, "codex", "hard", "doing"),
  card(3, "codex", "hard", "todo"),
  card(4, "codex", "medium", "done"),
  // kimi: one hard card bounced by the assigner (testing→doing by someone else)…
  card(5, "kimi", "hard", "doing", { history: [{ from: "testing", to: "doing", by: "arch:proj", ts: T0 + 5000 }] }),
  // …and one easy card with a HOLLOW: note on its log (#7750)
  card(6, "kimi", "easy", "testing", { log: [{ ts: T0 + 6000, by: "kimi:proj", text: "HOLLOW: no diff, no test command — moved" }] }),
];
const ledger = [
  row(1, "codex", "empty"), row(1, "codex", "stalled"),
  row(2, "codex", "cut"),
  row(3, "codex", "empty"),
  row(4, "codex", "completed"),
  row(5, "kimi", "completed"),                 // completed turns do not un-bounce a card
  row(99, "codex", "empty"),                   // a card id nobody knows — must be ignored
  { ts: T0, agent: "codex", project: "proj", outcome: "completed", tokens: 5 }, // no card — ignored
];
// glm's hard card aged off the board: only its moved events survive
const events = [
  { id: 1, type: "moved", project: "proj", taskId: 7, title: "aged", difficulty: "hard", assignee: "glm:proj", from: "doing", to: "testing", by: "glm:proj", ts: T0 + 7000 },
  { id: 2, type: "moved", project: "proj", taskId: 7, title: "aged", difficulty: "hard", assignee: "glm:proj", from: "testing", to: "done", by: "glm:proj", ts: T0 + 7100 },
];

console.log("# computeSeatRecord — classification");
const rec = computeSeatRecord({ cards, events, ledger });
const outcomeOf = (seat, id) => rec.seats[seat]?.cards.find(c => c.id === id)?.outcome;
ok("empty: all-nothing ledger turns classify the card empty",
  outcomeOf("codex", 1) === "empty" && outcomeOf("codex", 2) === "empty" && outcomeOf("codex", 3) === "empty");
ok("completed: a done card with no bounce", outcomeOf("codex", 4) === "completed");
ok("bounced: testing→doing by the assigner", outcomeOf("kimi", 5) === "bounced");
ok("bounced: a HOLLOW: note", outcomeOf("kimi", 6) === "bounced");
ok("events-only card (aged off /tasks) still classifies", outcomeOf("glm", 7) === "completed");
ok("wasted tokens count the empty cards' ledger cost", rec.seats.codex.wastedTokens === 4_000_000, `got ${rec.seats.codex.wastedTokens}`);
ok("an unknown card id in the ledger is ignored", !rec.seats.codex.cards.some(c => c.id === 99));

console.log("# benchedAt — the 3-strike rule, per difficulty");
ok("codex benched at hard (3 straight empty)", !!benchedAt(rec, "codex", "hard"));
ok("codex NOT benched at medium (record is per difficulty)", !benchedAt(rec, "codex", "medium"));
ok("kimi NOT benched at hard on a single bounce (insufficient evidence)", !benchedAt(rec, "kimi", "hard"));
ok("glm clean at hard", !benchedAt(rec, "glm", "hard"));

console.log("# reset — the manual forgiveness path");
const recReset = computeSeatRecord({ cards, events, ledger, resets: { codex: T0 + 10_000 } });
ok("a reset newer than the bad cards clears the bench", !benchedAt(recReset, "codex", "hard"));
ok("a reset wipes the seat's wasted tokens too", (recReset.seats.codex?.wastedTokens || 0) === 0);
ok("a reset does not touch other seats", outcomeOf("kimi", 5) === undefined ? false : computeSeatRecord({ cards, events, ledger, resets: { codex: T0 + 10_000 } }).seats.kimi.cards.length === 2);
const tmp = mkdtempSync(join(tmpdir(), "seat-record-"));
const rp = join(tmp, "resets.json");
ok("resetSeat writes a stamp the loader shape reads back",
  resetSeat({ project: "proj", seat: "codex", resetsPath: rp, now: T0 + 20_000 }) === true &&
  (await import("node:fs")).readFileSync(rp, "utf8").includes("codex"));
ok("resetsPathFor stays under the bus dir", resetsPathFor().includes("seat-record-resets.json"));

console.log("# advise — the feedback loop in routing");
const world = (agents, record) => ({
  profile: { providers: { claude: { tier: "api" } } },
  registry: { models: { "deepseek-v4-flash": { provider: "deepseek", cost_in: 0.14, cost_out: 0.28, good_for: ["code"] } }, tasks: {} },
  caps: { "deepseek-v4-flash": { coding: 38 } },
  agents, scrooge: true, record,
});
const pk = (title, difficulty) => [{ title, difficulty }];
// codex is first preference at hard; benched there, hard must route elsewhere and say why
const advHard = advise({ packages: pk("engine", "hard") }, world(["codex", "glm", "kimi", "deepseek"], rec));
ok("a hard card routes elsewhere when the first-choice seat is benched there",
  advHard.routing[0].executor !== "codex", `got ${advHard.routing[0].executor}`);
ok("the recommendation says who was benched and why",
  advHard.seat_feedback?.some(f => f.seat === "codex" && f.difficulty === "hard") && /benched at hard/.test(advHard.summary),
  advHard.summary?.slice(-160));
ok("the redo cost counts against the benched seat (wasted tokens named)",
  /4\.0M tok/.test(advHard.summary), advHard.summary?.slice(-160));
// codex is clean at medium — the bench is per difficulty, never global
const advMed = advise({ packages: pk("ui", "medium") }, world(["codex", "glm", "kimi", "deepseek"], rec));
ok("the same seat still gets other difficulties (codex clean at medium → routed normally)",
  !advMed.seat_feedback?.some(f => f.seat === "codex" && f.difficulty === "medium"));
// after a reset the bench lifts
const advReset = advise({ packages: pk("engine", "hard") }, world(["codex", "glm", "kimi", "deepseek"], recReset));
ok("after a reset the seat is eligible again", advReset.routing[0].executor === "codex", `got ${advReset.routing[0].executor}`);
// a bench never empties the pool
const advSolo = advise({ packages: pk("engine", "hard") }, world(["codex"], rec));
ok("benching never leaves an empty pool (sole seat still routed, bench still reported)",
  advSolo.routing[0].executor === "codex" && advSolo.seat_feedback?.some(f => f.seat === "codex"));
// no record at all → exactly the pre-#7762 behavior
const advNone = advise({ packages: pk("engine", "hard") }, world(["codex", "glm", "kimi", "deepseek"], undefined));
ok("no record → first preference routing, no feedback block",
  advNone.routing[0].executor === "codex" && advNone.seat_feedback === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
