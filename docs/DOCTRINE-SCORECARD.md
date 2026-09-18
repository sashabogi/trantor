# Doctrine scorecard: the five important projects on this hub

Card #6453 (Consolidate 8/8), BUILD-DOCTRINE.md rule 13, read against docs/SYSTEM-CONTRACT.md and
the consolidate cards #6448 to #6452. Audited 2026-09-17 at trantor c8cc63e from the checkouts under
~/development (CLAUDE.md, docs/, git log, source counts) plus each board brief over the signed API.

Only the trantor brief could be read: /catchup for the other four answered 403, because this seat's
identity is scoped to trantor and the operator has not linked the projects. Those four are scored
from their checkouts alone; the bus contracts and card logs behind them are unread, and every line
that depends on them says so. bin/audit.mjs (checklist item 0) was out of this contract's scope.

Six items per project, scored met / partial / missing with one line of evidence each: state not
event, episodes not timers, no fake affordances, done is a gate, contracts carry a base, seats can
ask. Counts exclude node_modules, vendor, graft/ indexes and scratch dirs. The consolidation phase
names what to do first; the wave waits for it where the score says so.

## trantor (0.18.61, c8cc63e)

Brief (read): SUCCESSION wave, the machine hands itself off reliably. Board: 291 done, 19 doing,
13 testing, 22 todo, 1 failed, 1 blocked, 5 stale.
Shape: 2,568 source files; 11 over 800 lines, 3 over 1,500; desktop/src-tauri/src/lib.rs is 7,997
lines, 235 unwrap/expect across the Rust tree and no clippy deny (#6448 blocked). CI runs the whole
suite on every push (ci.yml); two timing drills quarantined to 2026-09-22; the 5 root dependencies
are caret-ranged, not pinned (rule 9).

- state not event: PARTIAL. The overseer and duty derive episodes from state (lib/overseer.mjs,
  hub/duty.mjs), but the app still guesses: the sidebar's ACTIVE NOW reads "mid-turn" for every
  project (#7775) and a seat's turn state is inferred, never exposed (#7749).
- episodes not timers: PARTIAL. Warnings are episodic on the hub, yet the desktop runs 36
  setInterval pulls (AppShell every 15/30/45/60 s, Composer every 5 s) and 12 Rust sleep loops;
  herdr events.subscribe is wired only in herdr.rs, so SYSTEM-CONTRACT phase 3 has not landed.
- no fake affordances: PARTIAL. Workspace.tsx states the rule ("a stated placeholder, never an
  imitation") and keeps it; the fabricated ACTIVE NOW (#7775) and the "tools that lie" field
  report (#7755) are surfaces that do not.
- done is a gate: PARTIAL. The hub's 409 on a drill-less move to done is built and verified on
  seat/claude (#6452) but not on main (hub/routes/cards.mjs has no drill check at c8cc63e);
  341 of 1,128 commits in 90 days name a drill or a verified-at sha.
- contracts carry a base: MET. The runner's RULES demand a `base: <sha>` line, refuse an
  unresolvable one, and `trantor sync` reads harvest receipts; this card's contract carried c8cc63e.
- seats can ask: MET. relay_ask (mcp.mjs) sends a kind:ask that blocks the card with the question,
  and the answer resumes the seat (hub/routes/messages.mjs; #7756).

Consolidation phase, in order: (1) merge #6452 and #6450 so the drill gate and the comment policy
hold on main, not on a seat branch; (2) SYSTEM-CONTRACT phase 3, events.subscribe replaces the 36
desktop polls; (3) expose turn state instead of inferring it (#7749, #7775); (4) unblock #6448, the
lib.rs split and the clippy deny. The next feature wave waits for (1) and (2).
