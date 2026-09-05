export function createDuty({ state, now, appendEvent, markDirty, pushToStreams, OVERSEER_TICK_MS }) {
let DUTY_SESSION = String(process.env.RELAY_DUTY_SESSION || state.dutySession || "");
// 2 MINUTES, not 10 (2026-08-31): scribe DMed the woken crebral-health session at 16:11 and the
// operator hand-relayed at 16:21:58 — beating the old 10m escalation by seconds. Two agents
// actively collaborating cannot wait ten minutes; with duty's direct-wake the full chain
// (escalate → duty nudge → target's hooks poll) now lands in ~3m. Duty's own batch rules
// (one nudge per recipient per batch, consumed on activity) keep the shorter window from nagging.
const DUTY_UNDELIVERED_MS = Number(process.env.RELAY_DUTY_UNDELIVERED_MS || 2 * 60 * 1000);
const dutyEscalated = new Set();
// #5686: the janitor died 08-27 and NOTHING noticed for 4 days — the hub kept escalating to a
// corpse. Duty liveness is now a first-class state: dark = configured but no heartbeat inside
// DUTY_DARK_MS. Episode semantics (one event per transition, a standing flag on /health), and
// while dark, escalations go to the party owed the reply instead of the dead seat.
const DUTY_DARK_MS = Number(process.env.RELAY_DUTY_DARK_MS || 10 * 60 * 1000);
let dutyDarkSince = 0;
// A freshly appointed seat has no heartbeat yet and is NOT a corpse: the dark clock starts at
// appointment (boot or POST /overseer/duty), so a newborn gets one full window to first-poll.
let dutySeenFloor = Date.now();
function dutyLiveness() {
  if (!DUTY_SESSION) return { configured: false, online: false, lastSeenMs: 0 };
  const seen = Math.max(state.peers[DUTY_SESSION]?.lastSeen || 0, dutySeenFloor);
  const lastSeenMs = now() - seen;
  return { configured: true, online: lastSeenMs < DUTY_DARK_MS, lastSeenMs: Math.max(0, lastSeenMs) };
}
function dutyQueuedEscalations() {
  if (!DUTY_SESSION) return 0;
  const upTo = state.peers[DUTY_SESSION]?.deliveredUpTo || 0;
  return state.messages.reduce((n, m) => n + (m.to === DUTY_SESSION && m.id > upTo ? 1 : 0), 0);
}
function hubSend(to, text, project) {
  const msg = { id: ++state.seq, ts: now(), from: "hub:duty", to, text: String(text).slice(0, 2000), project: String(project || "").slice(0, 80) };
  state.messages.push(msg); if (state.messages.length > 5000) state.messages.splice(0, 1000);
  markDirty(); pushToStreams(msg);
  appendEvent("message", msg.project, msg.from, { msgId: msg.id, toSession: msg.to, text: msg.text.slice(0, 2000), refs: [] });
  return msg;
}
function dutyTick() {
  if (!DUTY_SESSION) return;
  // #5686: track the dark episode BEFORE escalating, so this tick already routes around a corpse.
  const live = dutyLiveness();
  if (!live.online && !dutyDarkSince) {
    dutyDarkSince = now();
    appendEvent("duty-dark", "", "hub:duty", { text: `duty seat ${DUTY_SESSION} has no heartbeat — seat trouble is not being triaged (trantor duty up)` });
  } else if (live.online && dutyDarkSince) {
    appendEvent("duty-back", "", "hub:duty", { text: `duty seat ${DUTY_SESSION} is back after ${Math.round((now() - dutyDarkSince) / 60000)}m dark` });
    dutyDarkSince = 0;
  }
  const cutoff = now() - DUTY_UNDELIVERED_MS;
  const floor = now() - 24 * 3600 * 1000;                 // never escalate ancient history
  for (const m of state.messages) {
    if (m.ts > cutoff || m.ts < floor) continue;
    // `hub:*` is the hub's own pseudo-identity, not a session: nothing polls it and nothing ever
    // will, so a message addressed there can never be "delivered". Escalating it is a category
    // error that feeds itself — the duty seat acks the escalation to hub:duty, that ack is
    // undelivered too, and since dutyEscalated prunes its oldest ids at 5,000 the same ones come
    // back around. Reported from the seat as "a fresh identical echo every stop-hook cycle".
    // Skipping the FROM side was already here; the TO side is the half that loops.
    if (!m.to || m.to === "all" || m.to === DUTY_SESSION || m.from === "hub:duty" || m.to.startsWith("hub:")) continue;
    if (dutyEscalated.has(m.id)) continue;
    if ((state.peers[m.to]?.deliveredUpTo || 0) >= m.id) continue;
    dutyEscalated.add(m.id);
    // #5686: a dark janitor must not eat escalations. Route to the SENDER — the party who
    // believes they were heard and are owed the reply — with the duty outage named, so the
    // failure is visible to someone who can act instead of queued on a corpse.
    hubSend(dutyDarkSince ? m.from : DUTY_SESSION,
      `⚠️ UNDELIVERED for ${Math.round((now() - m.ts) / 60000)}m: #${m.id} ${m.from} -> ${m.to} — "${String(m.text).slice(0, 280)}" — the recipient has not been handed this (recipient last seen ${state.peers[m.to]?.lastSeen ? Math.round((now() - state.peers[m.to].lastSeen) / 60000) + "m ago" : "never"}). Triage: is the recipient's session idle, deaf (wrong hub / old hooks), or gone? Relay, wake, or note it on their board.`,
      m.project || "");
  }
  if (dutyEscalated.size > 5000) { let n = dutyEscalated.size - 4000; for (const k of dutyEscalated) { dutyEscalated.delete(k); if (--n <= 0) break; } }
}
setInterval(dutyTick, OVERSEER_TICK_MS).unref?.();

  return {
    hubSend, dutyTick, dutyLiveness, dutyQueuedEscalations,
    get session() { return DUTY_SESSION; },
    get darkSince() { return dutyDarkSince; },
    setSession(session) {
      DUTY_SESSION = String(session || "").slice(0, 120);
      state.dutySession = DUTY_SESSION;
      dutySeenFloor = Date.now();
      dutyDarkSince = 0;
      markDirty();
      return DUTY_SESSION;
    },
  };
}
