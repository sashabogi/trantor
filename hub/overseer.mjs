import * as collisionRules from "../lib/overseer.mjs";
import * as sameProjectRules from "../lib/same-project.mjs";
const { levelFor, checkoutKey, collisionIdentity } = collisionRules;
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: orgPolicy is loaded from legacy durable state and this structural split preserves its existing compatibility guard. */
export function createOverseer({ state, fileClaims, now, appendEvent, markDirty, duty }) {
const _overseer = collisionRules;
const _sameProject = sameProjectRules;
const saved = state.overseerState || {};
const OVERSEER_TICK_MS = Number(process.env.RELAY_OVERSEER_TICK_MS || 30 * 1000);
// How long a condition must be ABSENT before we consider the episode over. This is NOT a re-warn
// timer: see overseerTick.
const OVERSEER_CLEAR_MS = Number(process.env.RELAY_OVERSEER_CLEAR_MS || process.env.RELAY_OVERSEER_DEDUP_MS || 10 * 60 * 1000);
// Standing conditions, keyed by collision identity -> { since, lastTick }. A collision is a STATE,
// not an event: it persists (#5350 doctrine). It fires ONCE when it starts, stays quiet while it
// holds (a metronome woke duty on 500 events for 4 conditions once), and the entry is forgotten
// only after OVERSEER_CLEAR_MS of absence, so a genuine recurrence warns again.
const overseerActive = new Map((saved.active || []).map(([key, entry]) => [key, { ...entry, sessions: new Set(entry.sessions) }]));
// Heartbeat for the WATCHER itself: /overseer/status must distinguish "fleet is clear" from "the
// overseer stopped ticking" — a monitor that cannot prove it is alive reads as clear when dead.
let overseerLastTick = 0;
let overseerLastCollisions = [];
function overseerPolicy() {
  const p = state.orgPolicy && typeof state.orgPolicy === "object" ? state.orgPolicy : {};
  return {
    autonomy: { "*": 2, ...(p.autonomy || {}) },
    links: Array.isArray(p.links) ? p.links : [],
  };
}
function overseerInputs() {
  return {
    peers: Object.entries(state.peers).map(([session, v]) => ({
      session, project: v.project || "", gitRoot: v.gitRoot || state.overseerState?.roots?.[session] || "", lastSeen: v.lastSeen || 0,
      llm: v.llm || "", model: v.model || "", status: v.status || "",
    })),
    claims: [...fileClaims.values()],
    // #7029: linked-activity needs an EVENT, and a card held from both sides of a link is one of
    // the two the hub already has. Only cards in hand travel — the board is 950+ rows and 99% of
    // them are done, so shipping the open ones keeps this tick as cheap as it was.
    cards: state.tasks
      .filter(t => t.status === "doing" || t.status === "testing")
      .map(t => ({ id: t.id, project: t.project || "", status: t.status, assignee: t.assignee || "", workedBy: t.workedBy || "" })),
    ...overseerPolicy(),
    now: now(),
  };
}

// Claims and their decisions recover together so a restart cannot reopen a standing hold.
const holds = new Map(saved.holds || []);
const claimTtl = Number(process.env.RELAY_CLAIM_TTL_MS || 10 * 60 * 1000);
for (const claim of saved.claims || []) {
  if (now() - claim.ts <= claimTtl) fileClaims.set(`${checkoutKey(claim)}\u0000${claim.file}\u0000${claim.session}`, claim);
}
function persistEpisodes() {
  state.overseerState = {
    roots: state.overseerState?.roots || {},
    active: [...overseerActive].map(([key, entry]) => [key, { ...entry, sessions: [...entry.sessions] }]),
    sameProjectFired: [...sameProjectFired],
    holds: [...holds],
    claims: [...fileClaims.values()].filter(claim => now() - claim.ts <= claimTtl),
  };
  markDirty();
}
function syncHolds() {
  const live = [...fileClaims.values()].filter(c => now() - c.ts <= claimTtl);
  for (const [key, hold] of holds) {
    if (levelFor(hold.project, overseerPolicy().autonomy) < 3 || !live.some(c => checkoutKey(c) === checkoutKey(hold) && c.file === hold.file && c.session === hold.other)) {
      holds.delete(key);
      appendEvent("hold.expired", hold.project, "overseer", { holdId: hold.id, file: hold.file });
    }
  }
  const first = new Map();
  for (const claim of live) {
    const fileKey = JSON.stringify([checkoutKey(claim), claim.file]);
    const other = first.get(fileKey);
    if (!other) { first.set(fileKey, claim.session); continue; }
    if (other === claim.session || levelFor(claim.project, overseerPolicy().autonomy) < 3) continue;
    const key = JSON.stringify([checkoutKey(claim), claim.file, claim.session]);
    if (holds.has(key)) continue;
    const hold = { id: ++state.verifyGateSeq, project: claim.project, file: claim.file,
      session: claim.session, gitRoot: claim.gitRoot || "", other, status: "pending", ts: now() };
    holds.set(key, hold);
    markDirty();
    appendEvent("hold.opened", hold.project, hold.session,
      { holdId: hold.id, file: hold.file, sessions: [other, hold.session], reason: holdReason(hold) });
  }
  persistEpisodes();
}
function holdReason(hold) {
  return `held: file conflict with ${hold.other}, ${hold.status === "nogo" ? "operator decided no-go" : "waiting on the operator"}`;
}
function holdFor(project, file, session, gitRoot = "") {
  syncHolds();
  if (levelFor(project, overseerPolicy().autonomy) < 3) return null;
  const hold = holds.get(JSON.stringify([checkoutKey({ project, gitRoot }), file, session]));
  return hold && hold.status !== "go" ? { ...hold, reason: holdReason(hold) } : null;
}
function listHolds() { syncHolds(); return [...holds.values()]; }
function decideHold(id, status, by) {
  syncHolds();
  const hold = [...holds.values()].find(h => h.id === id);
  if (!hold || hold.status !== "pending") return null;
  hold.status = status;
  hold.decidedBy = by;
  hold.decidedTs = now();
  persistEpisodes();
  appendEvent("hold.decided", hold.project, by, { holdId: hold.id, file: hold.file, status });
  duty.hubSend(hold.session, `File hold #${hold.id}: ${status === "go" ? "Go — retry your edit" : "No-go — your edit remains held"} (${hold.file}).`, hold.project);
  return hold;
}

// --- #5760: the same-project warning is an EPISODE keyed by the MEMBER SET -------------------
// lib/same-project.mjs (pure) decides from (previous set, current set, declared crew,
// last-fired-at): a declared crew is the NORMAL state of a project and not a collision at all,
// an unchanged set never re-warns (#5350 machinery), and the record reports DURATION.
const sameProjectFired = new Map(saved.sameProjectFired || []); // project -> { hash, sessions, ts } — the set as of the last verdict

// #8723 bounce-4: peerKindOf is the ONE answer to "what is this peer" — the row's own kind,
// nothing else — shared with /peers, so roster and overseer can never disagree. The enrolled
// identity is NOT a fallback (every identity defaults kind "agent", which made every peer crew
// and hid real intruders): the beats stamp orch/agent and pg COALESCE keeps the kind instead.
function peerKindOf(p) {
  return p && typeof p === "object" ? String(p.kind || "") : "";
}

// The declared crew is HUB state: the peer row's kind (#6148, #6075) — "agent" is a crew seat
// (crew-runner stamps every /register its seats make), "orch" the project's orchestrator pane
// (sessionstart stamps it when TRANTOR_ORCH names this project). A local crew-windows.txt reader
// would describe the OPERATOR's machine, never this hub's. Genesis is deliberately NOT crew (#6068).
function declaredCrewFor(project, gitRoot = "") {
  const crew = new Set();
  for (const [sid, p] of Object.entries(state.peers)) {
    if (gitRoot ? (p.gitRoot || state.overseerState?.roots?.[sid]) !== gitRoot : (p.project || "") !== project) continue;
    const k = peerKindOf(p);
    if (k === "agent" || k === "orch") crew.add(sid);
  }
  return [...crew];
}

function overseerTick() {
  syncHolds();
  if (!_overseer?.detectCollisions) return;
  let collisions = [];
  try { collisions = _overseer.detectCollisions(overseerInputs()) || []; } catch { return; }
  const t = now();
  overseerLastTick = t;
  const pol = overseerPolicy();
  const seen = new Set();
  // The intro hands each party the others' session ids at the moment coordination is warranted —
  // the warning alone went only to duty, and ids never cross the bus by themselves. Shared by the
  // episode-start branch (all parties) and the standing branch (newcomers only, same-project
  // included): existing members never re-hear it, so a standing condition cannot re-wake every tick.
  const intro = (c, me, others) => {
    const project = state.peers[me]?.project || c.project;
    if (levelFor(project, pol.autonomy) < 2) return;
    const rest = others.filter(p => p !== me);
    if (rest.length === 0) return;
    duty.hubSend(me,
      `🤝 OVERSEER ${c.kind}: you and ${rest.join(", ")} are working on overlapping ground${c.files?.length ? ` (${c.files.slice(0, 3).join(", ")})` : ""}. ${c.detail || ""} Coordinate directly — relay_send to ${rest[0]} — and split the work between you. No human needs to relay this.`,
      project);
  };
  // #5760: same-project sets judged crew-only are dropped entirely — the normal state of a
  // project, not a collision — so not even the context feed narrates them.
  const kept = [];
  for (const c of collisions) {
    // #5760: the pure episode rule rides ON TOP of the shared machinery — a crew-only set is not
    // a collision at all (dropped, no context), a liveness flap replays the SAME set and stays
    // silent, the record reports DURATION. Without the rule module the fallback is the pre-#5760
    // generic loop: a missing rule must never re-instate the metronome, only loosen it.
    if (c.kind === "same-project-sessions" && _sameProject?.sameProjectDecision) {
      const scope = checkoutKey(c);
      const prior = sameProjectFired.get(scope) || null;
      const d = _sameProject.sameProjectDecision({
        previous: prior?.sessions ?? null,
        current: c.sessions,
        declaredCrew: declaredCrewFor(c.project, c.gitRoot),
        lastFiredAt: prior?.ts ?? null,
        now: t,
      });
      if (d.reason === "crew-only") continue;
      const key = `${scope} ${c.kind}`;
      c.key = key;
      seen.add(key);
      kept.push(c);
      const parties = [...new Set(c.sessions || [])].filter(s => s && s !== duty.session);
      const standing = overseerActive.get(key);
      if (standing) {
        // The episode HOLDS: no new warn, whoever was introed once is never re-heard.
        standing.lastTick = t;
        c.since = standing.since;
        if (_sameProject.durationLabel) c.detail = `${c.detail || ""} (same-project for ${_sameProject.durationLabel(t - standing.since)})`.trim();
        for (const me of parties) if (!standing.sessions.has(me)) intro(c, me, parties);
        for (const me of parties) standing.sessions.add(me);
        // The record tracks the live membership (ts stays at the last warn) so a later open
        // judges the true previous set and can say how long the old one held.
        if (d.fire && prior) sameProjectFired.set(scope, { hash: _sameProject.memberSetHash(c.sessions), sessions: c.sessions, ts: prior.ts });
        continue;
      }
      // The episode OPENS and the pure rule said fire — first sighting, or a membership change
      // on a remembered set; the record line states how long the previous state held.
      overseerActive.set(key, { since: t, lastTick: t, sessions: new Set(parties) });
      c.since = t;
      if (d.reason === "membership-changed") c.detail = `${c.detail || ""} (same-project for ${_sameProject.durationLabel(d.durationMs)})`.trim();
      sameProjectFired.set(scope, { hash: _sameProject.memberSetHash(c.sessions), sessions: c.sessions, ts: t });
      appendEvent("overseer.warn", c.project, "overseer",
        { kind: c.kind, sessions: c.sessions || [], files: c.files || [], detail: c.detail || "", narrated: false });
      if (levelFor(c.project, pol.autonomy) >= 2 && duty.session) duty.hubSend(duty.session, `⚠️ OVERSEER ${c.kind} [${c.project}]: ${c.detail || ""} — if the parties are not already coordinating, message them.`, c.project);
      if (parties.length > 1) for (const me of parties) intro(c, me, parties);
      continue;
    }
    kept.push(c);
    // Episode identity is the CONDITION (project+kind+files), never the session list (#5350):
    // membership is volatile — a third seat bouncing in and out of a standing collision minted a
    // fresh key, so a fresh episode, so a fresh warn (+ duty wake + party intros) per permutation.
    // Sessions are participants, not identity; current membership still rides every warn payload.
    const key = collisionIdentity(c);
    c.key = key;
    seen.add(key);
    const parties = [...new Set(c.sessions || [])].filter(s => s && s !== duty.session);
    const standing = overseerActive.get(key);
    if (standing) {
      // The episode HOLDS — no new warn. But a NEWCOMER to a standing collision still needs the
      // intro: it was not present when the episode started, so it never learned the others' ids.
      // Diff the current membership against the set the episode has already introduced, hand the
      // intro only to newly arrived sessions, and remember them so they are not re-introduced.
      standing.lastTick = t;
      c.since = standing.since;
      // Every standing kind reports DURATION, not a count — the doctrine's rule, and until #7029 only
      // same-project obeyed it. "held for 4h" is the line that tells an operator whether a collision
      // is a moment or a stuck seat; "warned 40 times" tells them only that the watcher is loud.
      if (_sameProject?.durationLabel) c.detail = `${c.detail || ""} (standing for ${_sameProject.durationLabel(t - standing.since)})`.trim();
      for (const me of parties) if (!standing.sessions.has(me)) intro(c, me, parties);
      for (const me of parties) standing.sessions.add(me);
      continue;
    }
    overseerActive.set(key, { since: t, lastTick: t, sessions: new Set(parties) });
    c.since = t;
    appendEvent("overseer.warn", c.project, "overseer",
      { kind: c.kind, sessions: c.sessions || [], files: c.files || [], detail: c.detail || "", narrated: false });
    if (levelFor(c.project, pol.autonomy) >= 2 && duty.session) duty.hubSend(duty.session, `⚠️ OVERSEER ${c.kind} [${c.project}]: ${c.detail || ""} — if the parties are not already coordinating, message them.`, c.project);
    if (parties.length > 1) for (const me of parties) intro(c, me, parties);

  }
  // Episode end: a condition gone for the whole clear window is over, so a LATER recurrence is a
  // new episode and warns again. Without this the map would grow forever and nothing could re-fire.
  for (const [k, v] of overseerActive) {
    if (!seen.has(k) && t - v.lastTick > OVERSEER_CLEAR_MS) {
      overseerActive.delete(k);
      // #5760: the same-project verdict record dies WITH its episode — a set that returns after a
      // genuine clear is a new episode (it warns again, first sighting), not the old one continuing.
      if (k.endsWith(" same-project-sessions")) sameProjectFired.delete(k.slice(0, -" same-project-sessions".length));
    }
  }
  overseerLastCollisions = kept;
  persistEpisodes();
}
setInterval(overseerTick, OVERSEER_TICK_MS).unref?.();
setTimeout(overseerTick, 2000).unref?.();

  return {
    syncHolds, holdFor, listHolds, decideHold,
    overseerTick, overseerPolicy, overseerInputs, declaredCrewFor, peerKindOf,
    active: overseerActive,
    get engine() { return _overseer; },
    get sameProject() { return _sameProject; },
    get lastTick() { return overseerLastTick; },
    get lastCollisions() { return overseerLastCollisions; },
    OVERSEER_TICK_MS, OVERSEER_CLEAR_MS,
  };
}
