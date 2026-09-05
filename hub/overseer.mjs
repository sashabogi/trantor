/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: orgPolicy is loaded from legacy durable state and this structural split preserves its existing compatibility guard. */
export function createOverseer({ state, fileClaims, now, appendEvent, markDirty, duty }) {
let _overseer = null;
import("../lib/overseer.mjs").then(m => { _overseer = m; }).catch(() => {});
// #5760: the same-project episode rule (lib/same-project.mjs, pure) — lazy like the detector, so
// a hub booted before the module lands still runs (the same-project branch fails QUIET until it
// arrives: a missing rule must never re-instate the hourly metronome).
let _sameProject = null;
import("../lib/same-project.mjs").then(m => { _sameProject = m; }).catch(() => {});
const OVERSEER_TICK_MS = Number(process.env.RELAY_OVERSEER_TICK_MS || 30 * 1000);
// How long a condition must be ABSENT before we consider the episode over. This is NOT a re-warn
// timer: see overseerTick.
const OVERSEER_CLEAR_MS = Number(process.env.RELAY_OVERSEER_CLEAR_MS || process.env.RELAY_OVERSEER_DEDUP_MS || 10 * 60 * 1000);
// Standing conditions, keyed by collision identity -> { since, lastTick }. A collision is a STATE,
// not an event: it persists. Emitting on a 10-minute timer turned the watcher into a metronome —
// 500 events for 4 distinct conditions (2026-08-12 audit), each one also waking the duty seat for a
// full turn. Now an episode fires ONCE when it starts and stays quiet while it holds; the entry is
// forgotten only after the condition has been gone for OVERSEER_CLEAR_MS, so a genuine recurrence
// warns again.
const overseerActive = new Map();
// Heartbeat for the WATCHER itself: /overseer/status must distinguish "fleet is clear" from "the
// overseer stopped ticking" — a monitor that cannot prove it is alive reads as clear when dead.
let overseerLastTick = 0;
let overseerLastCollisions = [];
function overseerPolicy() {
  const p = state.orgPolicy && typeof state.orgPolicy === "object" ? state.orgPolicy : {};
  return {
    autonomy: { "*": 1, ...(p.autonomy || {}) },
    links: Array.isArray(p.links) ? p.links : [],
  };
}
function overseerInputs() {
  return {
    peers: Object.entries(state.peers).map(([session, v]) => ({
      session, project: v.project || "", lastSeen: v.lastSeen || 0,
      llm: v.llm || "", model: v.model || "", status: v.status || "",
    })),
    claims: [...fileClaims.values()],
    ...overseerPolicy(),
    now: now(),
  };
}

// --- #5760: the same-project warning is an EPISODE keyed by the MEMBER SET -------------------
// The night of 08-31 the same-project DM re-fired hourly for a membership that never changed and
// woke every seat into metered chatter turns. The rule (lib/same-project.mjs, pure) decides
// fire-or-not from (previous set, current set, declared crew, last-fired-at): a declared crew is
// the NORMAL state of a project and is not a collision at all; a set that never changed re-warns
// never. The warn itself rides the SAME episode machinery as every other kind (#5350: one warn at
// open, newcomer-only intros while standing, a genuine clear ends it) — the record below only
// feeds the pure rule the set it judged last, so "unchanged" is one hash comparison and the
// record line reports DURATION ("same-project for 6h"), never a count of warnings.
const sameProjectFired = new Map(); // project -> { hash, sessions, ts } — the set as of the last verdict

// The declared crew: HUB state, never a file on the operator's machine (#6075). The production
// hub runs on netcup, where ~/.agent-bus/crew-windows.txt does not exist — the file describes the
// OPERATOR'S machine (it is written by `trantor up` there), so on the remote hub the old reader
// found nothing and every same-project set looked like intruders: the crew-only exemption simply
// never held remotely. What the hub itself knows is the peer row's `kind` (#6148): "agent" is a
// crew seat — crew-runner stamps it on every /register its seats make — and "orch" is the
// project's orchestrator pane (sessionstart stamps it when TRANTOR_ORCH names this project).
// The HOST_NAME exemption is gone with the file: the hub's hostname is the hub machine's
// (netcup), never the operator's, so `<HOST_NAME>:<project>` exempted a session that cannot
// exist. Genesis is deliberately NOT crew (#6068: a bookkeeping identity, not a seat).
function declaredCrewFor(project) {
  const crew = new Set();
  for (const [sid, p] of Object.entries(state.peers)) {
    if ((p.project || "") !== project) continue;
    if (p.kind === "agent" || p.kind === "orch") crew.add(sid);
  }
  return [...crew];
}

function overseerTick() {
  if (!_overseer?.detectCollisions) return;
  let collisions = [];
  try { collisions = _overseer.detectCollisions(overseerInputs()) || []; } catch { return; }
  const t = now();
  overseerLastTick = t;
  const pol = overseerPolicy();
  const seen = new Set();
  // Hand each party the others' session ids at the moment coordination is warranted. Telling two
  // sessions to "coordinate over the bus" is useless if neither knows the other's id, and the
  // warning alone went only to the duty seat and the log — so coordination needed a human to carry
  // the ids across. Shared by the episode-start branch (all parties) and the standing branch
  // (newcomers only, same-project included): existing members never
  // re-hear it, so a standing condition must not re-wake every party every tick.
  const intro = (c, me, others) => {
    const rest = others.filter(p => p !== me);
    if (rest.length === 0) return;
    duty.hubSend(me,
      `🤝 OVERSEER ${c.kind}: you and ${rest.join(", ")} are working on overlapping ground${c.files?.length ? ` (${c.files.slice(0, 3).join(", ")})` : ""}. ${c.detail || ""} Coordinate directly — relay_send to ${rest[0]} — and split the work between you. No human needs to relay this.`,
      c.project);
  };
  // #5760: same-project sets judged crew-only are dropped entirely — the normal state of a
  // project, not a collision — so not even the context feed narrates them.
  const kept = [];
  for (const c of collisions) {
    // #5760: same-project gets the pure episode rule (lib/same-project.mjs) ON TOP of the shared
    // episode machinery below: a crew-only set is not a collision at all (dropped — no warn, no
    // context, no state); a standing set re-warns never (a liveness flap replays the SAME set —
    // 08-31's metronome — and must stay silent, only genuine newcomers hear the intro once); and
    // the record line reports DURATION. Without the rule module this branch is invisible and
    // same-project rides the generic loop exactly as before — a missing rule must never
    // re-instate the hourly metronome, so the fallback is the pre-#5760 behavior, never stricter.
    if (c.kind === "same-project-sessions" && _sameProject?.sameProjectDecision) {
      const prior = sameProjectFired.get(c.project) || null;
      const d = _sameProject.sameProjectDecision({
        previous: prior?.sessions ?? null,
        current: c.sessions,
        declaredCrew: declaredCrewFor(c.project),
        lastFiredAt: prior?.ts ?? null,
        now: t,
      });
      if (d.reason === "crew-only") continue;
      const key = `${c.project} ${c.kind}`;
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
        if (d.fire && prior) sameProjectFired.set(c.project, { hash: _sameProject.memberSetHash(c.sessions), sessions: c.sessions, ts: prior.ts });
        continue;
      }
      // The episode OPENS and the pure rule said fire — first sighting, or a membership change
      // on a remembered set; the record line states how long the previous state held.
      overseerActive.set(key, { since: t, lastTick: t, sessions: new Set(parties) });
      c.since = t;
      if (d.reason === "membership-changed") c.detail = `${c.detail || ""} (same-project for ${_sameProject.durationLabel(d.durationMs)})`.trim();
      sameProjectFired.set(c.project, { hash: _sameProject.memberSetHash(c.sessions), sessions: c.sessions, ts: t });
      appendEvent("overseer.warn", c.project, "overseer",
        { kind: c.kind, sessions: c.sessions || [], files: c.files || [], detail: c.detail || "", narrated: false });
      if (duty.session) duty.hubSend(duty.session, `⚠️ OVERSEER ${c.kind} [${c.project}]: ${c.detail || ""} — if the parties are not already coordinating, message them.`, c.project);
      if (parties.length > 1) for (const me of parties) intro(c, me, parties);
      continue;
    }
    kept.push(c);
    // Episode identity is the CONDITION (project+kind+files), never the session list (#5350):
    // membership is volatile — a third seat bouncing in and out of a standing collision minted a
    // fresh key, so a fresh episode, so a fresh warn (+ duty wake + party intros) per permutation.
    // Sessions are participants, not identity; current membership still rides every warn payload.
    const key = `${c.project} ${c.kind} ${(c.files || []).join(",")}`;
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
      for (const me of parties) if (!standing.sessions.has(me)) intro(c, me, parties);
      for (const me of parties) standing.sessions.add(me);
      continue;
    }
    overseerActive.set(key, { since: t, lastTick: t, sessions: new Set(parties) });
    c.since = t;
    appendEvent("overseer.warn", c.project, "overseer",
      { kind: c.kind, sessions: c.sessions || [], files: c.files || [], detail: c.detail || "", narrated: false });
    if (duty.session) duty.hubSend(duty.session, `⚠️ OVERSEER ${c.kind} [${c.project}]: ${c.detail || ""} — if the parties are not already coordinating, message them.`, c.project);
    if (parties.length > 1) for (const me of parties) intro(c, me, parties);
    const level = _overseer.levelFor ? _overseer.levelFor(c.project, pol.autonomy) : 1;
    if (level >= 3 && c.kind === "file-conflict") {
      const g = { id: ++state.verifyGateSeq, project: c.project, status: "open", ts: now(),
        by: "overseer", claim: `file conflict: ${(c.files || []).join(", ")} — ${(c.sessions || []).join(" vs ")}`,
        why: c.detail || "two live sessions on the same file", howToVerify: "decide who proceeds; coordinate over the bus" };
      state.verifyGates.push(g); markDirty();
      appendEvent("verify.gate.opened", c.project, "overseer", { gateId: g.id, claim: g.claim, why: g.why });
    }
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
}
setInterval(overseerTick, OVERSEER_TICK_MS).unref?.();
setTimeout(overseerTick, 2000).unref?.();

  return {
    overseerTick, overseerPolicy, overseerInputs, declaredCrewFor,
    active: overseerActive,
    get engine() { return _overseer; },
    get sameProject() { return _sameProject; },
    get lastTick() { return overseerLastTick; },
    get lastCollisions() { return overseerLastCollisions; },
    OVERSEER_TICK_MS, OVERSEER_CLEAR_MS,
  };
}
