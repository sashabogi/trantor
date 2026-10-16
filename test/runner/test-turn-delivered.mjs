#!/usr/bin/env node
// #11860 — a turn with no commit and the card unmoved still delivered when this seat noted its
// own card or messaged the contract's sender; reading and saying nothing stays no-delivery.
import { turnDelivered } from "../../lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
const SESSION = "kimi-3:trantor", T0 = 1000, SEQ = 50;
const assigners = [{ from: "orch@mac", id: 7 }];
const base = { newCommit: false, moved: false, session: SESSION, t0: T0, cardLogBefore: [], cardLog: [], events: [], assigners, seqBefore: SEQ };
const note = (by, ts = 2000, text = "design note") => ({ by, ts, text });
const msg = (to, id = 51, by = SESSION) => ({ type: "message", by, id, toSession: to });

ok("commit -> delivered", turnDelivered({ ...base, newCommit: true }));
ok("card moved -> delivered", turnDelivered({ ...base, moved: true }));
ok("own-card note by this seat -> delivered", turnDelivered({ ...base, cardLog: [note(SESSION)] }));
ok("direct message to the assigner -> delivered", turnDelivered({ ...base, events: [msg("orch@mac")] }));
ok("note by someone else on the card -> not delivered", !turnDelivered({ ...base, cardLog: [note("other:trantor")] }));
ok("an old note from before the turn -> not delivered",
  !turnDelivered({ ...base, cardLog: [note(SESSION, 2000)], cardLogBefore: [note(SESSION, 2000)] }));
ok("note on a different card (this card's log empty) -> not delivered", !turnDelivered({ ...base, cardLog: [] }));
ok("message to someone else -> not delivered", !turnDelivered({ ...base, events: [msg("peer:trantor")] }));
ok("message to the assigner from before the turn -> not delivered", !turnDelivered({ ...base, events: [msg("orch@mac", 40)] }));
ok("message to the assigner sent by another session -> not delivered", !turnDelivered({ ...base, events: [msg("orch@mac", 51, "other:trantor")] }));
ok("nothing -> not delivered", !turnDelivered(base));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
