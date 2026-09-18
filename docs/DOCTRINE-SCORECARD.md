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

## crebral-health (f4923c0)

Brief: unread (403). README: in production, in daily use by beta clinics; 136 API routes, 90 pages,
96 migrations; 770 commits in 90 days, 281 in the last 30.
Shape: 1,390 source files; 18 over 800 lines, 4 over 1,500 (EncounterList.tsx 1,473, the
neuroscience capture config 1,420, AssistantDock.tsx 1,274); 373 test files under src; no CI
workflow, the gates (tsc, eslint, vitest) run by hand; 42 of 42 dependencies caret-ranged.

- state not event: PARTIAL. The record is single-sourced by rule (docs/clinic-single-source-of-truth.md,
  docs/server-resolved-surfaces.md: the server resolves what a clinic sees), but no status surface
  models an episode; "episode" appears only in clinical-note code.
- episodes not timers: PARTIAL. 18 setInterval sites in 12 files: NotificationsMenu, MessagesMenu
  and RegulatoryStatusCard poll every 30 s and ScribeReturnStatus polls for the note; the calendar
  now-line and the recording clock are the only timers that should be timers.
- no fake affordances: PARTIAL. Unbuilt modules render disabled with a badge from one feature map
  (clinic-features.ts, FeaturesSection.tsx), which is honest; the platform-assistant button ships
  live with the title "coming soon" (ContextBar.tsx:53), and portal/connect labels its connect
  button "Coming soon" when the wearables flag is off.
- done is a gate: PARTIAL. Every "Help me learn" fix ships a regression test (CLAUDE.md) and the
  billing spec names a verification gate per card (.crew/billing-p1-spec.md), but nothing runs on
  push and 4 of 770 commits name a drill or a verified-at sha.
- contracts carry a base: MISSING. .crew/ holds some thirty seat contracts and specs (billing-A to
  D, cardio-demo-A to D); none carries a base line, so a seat starts wherever main happens to be.
  Bus contracts unread.
- seats can ask: PARTIAL. The primitive is the runner's and reaches any seat launched through it;
  the project's own specs never name a fact a seat must ask for rather than invent. Card logs unread.

Consolidation phase: (1) CI on push running tsc, eslint and vitest, so red blocks merge (rule 2);
(2) a drill line on every card and a base line on every .crew contract; (3) replace the four
inbox-shaped polls with one subscription or one episode model (rule 11); (4) split the four files
over 1,500 lines. The next vertical waits for (1) and (2).

## crebral-scribe (99f4f3d, 1.0.1 build 21)

Brief: unread (403). Checkout: the iOS 27, iPadOS and Mac ambient scribe; 179 Swift files, 195
commits in 90 days, 30 naming a card; seat/glm was merged for #7870, so the crew flow runs here.
Shape: 6 files over 800 lines, none over 1,500 (DesktopOverviewTab.swift 1,326); 44 unit and 5 UI
test files; no CI and no fastlane, builds hand-numbered; docs/contracts/ carries the two cross-repo
contracts with semver (chart-tabs 1.3.0).

- state not event: MET. The chart strip is served, never derived (docs/contracts/chart-tabs.md §1);
  capabilities.md exists so that drift "must be impossible to ship unnoticed".
- episodes not timers: PARTIAL. 24 Timer and Task.sleep sites outside tests (RescueService,
  CoverageTracker, PCCProbe, NoteFormer, the Mac tray); the recording clock and the debounce are
  earned, the rescue and coverage warnings run on timers with no episode model.
- no fake affordances: MET. An id without a view is skipped, never drawn as an empty tab
  (chart-tabs.md); the only "not implemented" in the tree is a comment on the DICOM binary decoder.
- done is a gate: PARTIAL. ROADMAP.md: nothing is done without build, tests and an observed run,
  and the #7870 test commit ships PNGs as proof; but nothing runs on push and 0 of 195 commits name
  a drill or a verified-at sha.
- contracts carry a base: PARTIAL. The cross-repo contracts are versioned, the right shape for the
  health seam; the seat contracts live on the bus, unread here, and the repo records no base.
- seats can ask: PARTIAL. Inherited from the runner; capabilities.md was born from an ask
  ("crebral-health asked the consumer to specify the shape it consumes") made in a doc, not on the bus.

Consolidation phase: (1) CI: xcodebuild test on push for the 49 test files; (2) a drill line on
every card of the form "install build N on the phone and see X"; (3) an episode model for the
rescue and coverage warnings (rule 11); (4) split DesktopOverviewTab.swift. The GA push waits for (1).
