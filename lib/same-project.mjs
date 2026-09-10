// #5760: the same-project OVERSEER warning is an EPISODE, not a timer (monitoring doctrine).
// Fires ONCE when the member set CHANGES, keyed by a stable hash of the set; reports DURATION,
// not repetition; an operator-declared crew is the NORMAL state and never triggers it.
// Pure module: no I/O, no imports. The hub owns persistence and the crew declaration.
const clean = (v) => String(v ?? "").trim();

// The member SET: sorted, deduped — so set comparison and hashing never see order or repeats.
export function memberSet(sessions) {
  return [...new Set((sessions ?? []).map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// A stable hash of the member set, so "did the membership change" is one comparison that
// survives process restarts and set reordering. FNV-1a over the joined members: deterministic
// everywhere, no dependencies.
export function memberSetHash(sessions) {
  let h = 0x811c9dc5;
  for (const ch of memberSet(sessions).join("\u0000")) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// "6h" / "12m" / "<1m" — the record line states how long the episode has held, never a count
// of warnings. An unchanged state is not news; its DURATION is.
export function durationLabel(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// Fire-or-not. previous = the member set as of the LAST fire (null = never fired); current = the
// live sessions on the project now; declaredCrew = the operator's crew (seats + orchestrator);
// lastFiredAt = when the last fire happened (null = never). The clock inputs exist ONLY to state
// duration — there is no elapsed-time threshold anywhere: a change fires, a hold never does.
export function sameProjectDecision({ previous = null, current = [], declaredCrew = [], lastFiredAt = null, now = 0 } = {}) {
  const cur = memberSet(current);
  const crew = new Set(memberSet(declaredCrew));
  const intruders = cur.filter((s) => !crew.has(s));
  if (intruders.length === 0) return { fire: false, reason: "crew-only", intruders: [], durationMs: 0 };
  if (previous == null || lastFiredAt == null) {
    return { fire: true, reason: "first-sighting", intruders, durationMs: 0 };
  }
  if (memberSetHash(previous) === memberSetHash(cur)) {
    return { fire: false, reason: "unchanged", intruders, durationMs: 0 };
  }
  return {
    fire: true,
    reason: "membership-changed",
    intruders,
    durationMs: Math.max(0, (Number(now) || 0) - (Number(lastFiredAt) || 0)),
  };
}
