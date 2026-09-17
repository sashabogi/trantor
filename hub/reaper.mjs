export function createReaper({
  state, now, canon, appendCardEvent, appendEvent, appendTaskLog, markDirty, sweepPresence,
  ONLINE_MS, PEER_TTL_MS, FOCUS_OFFLINE_MS, FOCUS_IDLE_MS,
  REAP_GRACE_MS, TODO_STALE_MS, REAP_INTERVAL_MS,
  CONTRACT_ABANDON_MS, CONTRACT_WINDOW_MS,
}) {
function closeFocusCard(t, by) {
  if (!t || t.status === "done") return false;
  (t.history ||= []).push({ from: t.status, to: "done", by, ts: now() });
  if (t.history.length > 60) t.history.splice(0, 20);
  appendCardEvent("moved", t, by, t.status, "done");
  t.status = "done"; t.updated = now();
  return true;
}
// A bus session id is per (host, project), so ONE assignee can own SEVERAL open focus cards — one
// per live Claude session in that project. Close every one of them when the peer goes away; the
// old single-card `find` left the rest sitting in `doing` forever.
function closeFocus(session) {
  let closed = false;
  for (const t of state.tasks) {
    if (t.source === "session" && t.assignee === session && t.status !== "done") closed = closeFocusCard(t, session) || closed;
  }
  return closed;
}
// A git card and a focus card meet on the same bus id (`${hostId()}:${project}`), which is what the
// backfill posts as its assignee. One bus id can own several open focus cards now, so close the
// most recently active one — the session that just committed is the one that most recently spoke.
const COMMIT_FOCUS_WINDOW_MS = Number(process.env.RELAY_COMMIT_FOCUS_MS || 10 * 60 * 1000);
function linkCommitToFocus(commitCard, by) {
  // A HISTORICAL backfill (`--since "14 days ago"`) posts dozens of old commits at once and must
  // never close whatever a session happens to be doing today. Only a fresh commit closes a focus.
  if (Math.abs(now() - (commitCard.ts || 0)) > COMMIT_FOCUS_WINDOW_MS) return false;
  const owner = commitCard.assignee || by || "";
  if (!owner) return false;
  const proj = canon(commitCard.project || "");
  const open = state.tasks
    .filter(x => x.source === "session" && x.status !== "done" && x.assignee === owner && canon(x.project) === proj)
    .sort((a, b2) => (b2.updated || 0) - (a.updated || 0));
  const focus = open[0];
  if (!focus) return false;
  focus.commitCard = commitCard.id;                 // the two halves point at each other, so the
  commitCard.focusCard = focus.id;                  // card drawer can walk either way
  (focus.history ||= []).push({ from: focus.status, to: "done", by: owner, ts: now(), note: `closed by commit — ${String(commitCard.title || "").slice(0, 80)}` });
  if (focus.history.length > 60) focus.history.splice(0, 20);
  appendCardEvent("moved", focus, owner, focus.status, "done");
  focus.status = "done"; focus.updated = now();
  appendEvent("focus", focus.project, owner, { taskId: focus.id, closedBy: commitCard.id, reason: "commit" });
  return true;
}
function prunePeers() {
  const cutoff = now() - PEER_TTL_MS;
  let removed = false;
  for (const [session, peer] of Object.entries(state.peers)) {
    if ((peer.lastSeen || 0) < cutoff) { if (closeFocus(session)) removed = true; delete state.peers[session]; removed = true; }
  }
  if (removed) markDirty();
}
setInterval(prunePeers, 60000).unref?.();
setInterval(sweepPresence, 60000).unref?.();

// Is ANY session associated with this card currently online? For a crew card the assignee IS a peer key
// (codex:project); for a cc-subagent/fork/cc-bg-agent card the live owner is the PARENT session (parent/by);
// a focus card is keyed by its assignee (= the session). If none resolves to an online peer, the card's
// owner is gone.
function cardOwnerOnline(t, cutoff) {
  for (const k of [t.assignee, t.parent, t.by]) {
    if (!k) continue;
    const p = state.peers[k];
    if (p && (p.lastSeen || 0) > cutoff) return true;
  }
  return false;
}
function cardOwnerLastSeen(t) {
  let latest = 0;
  for (const k of new Set([t.assignee, t.parent, t.by].filter(Boolean))) {
    latest = Math.max(latest, state.peers[k]?.lastSeen || 0);
  }
  return latest;
}
function appendReaperStaleLog(t, reason, ts) {
  const seen = cardOwnerLastSeen(t);
  const lastSeen = seen ? `${humanMs(ts - seen)} ago` : "never";
  appendTaskLog(t, "reaper", `${reason}; owner last seen ${lastSeen}`, ts);
}
// The general stale-card reaper prunePeers never was. Every 60s: (a) close a focus card whose
// session is OFFLINE past FOCUS_OFFLINE_MS; (b) stale an offline-owner doing card past REAP_GRACE_MS.
// Testing (the operator's verdict) and online owners are NEVER touched — the owner-alive-but-idle
// case belongs to the explicit /sweep path (preview + confirm).
function reapStaleCards() {
  const onCut = now() - ONLINE_MS;
  const focusCut = now() - FOCUS_OFFLINE_MS;
  const idleCut = now() - FOCUS_IDLE_MS;
  const graceCut = now() - REAP_GRACE_MS;
  let changed = false;
  for (const t of state.tasks) {
    if (t.status === "done" || t.status === "stale") continue;
    if (t.status === "testing") continue;
    if (t.status === "todo" && (t.updated || t.ts || 0) < now() - TODO_STALE_MS) {
      const from = t.status;
      const untouchedAt = t.updated || t.ts || 0;
      const agedDays = Math.floor((now() - untouchedAt) / 86400000);
      const reapedAt = now();
      (t.history ||= []).push({ from, to: "stale", by: "reaper", ts: reapedAt });
      if (t.history.length > 60) t.history.splice(0, 20);
      appendReaperStaleLog(t, `todo aged out after ${agedDays}d untouched`, reapedAt);
      appendCardEvent("moved", t, "reaper", from, "stale");
      t.status = "stale"; t.updated = reapedAt; t._reaped = true; changed = true;
      continue;
    }
    if (t.source === "session") {                                  // (a) focus cards → done when session offline
      const p = state.peers[t.assignee];
      const peerGone = !p || (p.lastSeen || 0) < focusCut;
      // …or when THIS card has gone quiet for a very long time, which is the only signal available
      // for a dead Claude session whose bus identity a living sibling keeps warm.
      const longIdle = (t.updated || t.ts || 0) < idleCut;
      if (peerGone || longIdle) { if (closeFocusCard(t, peerGone ? t.assignee : "reaper")) changed = true; }
      continue;
    }
    if (t.status === "doing"                                      // (b) offline-owner work cards → stale
        && (t.updated || t.ts || 0) < graceCut
        && !cardOwnerOnline(t, onCut)) {
      const reapedAt = now();
      (t.history ||= []).push({ from: t.status, to: "stale", by: "reaper", ts: reapedAt });
      if (t.history.length > 60) t.history.splice(0, 20);
      appendReaperStaleLog(t, "owner offline → stale", reapedAt);
      appendCardEvent("moved", t, "reaper", t.status, "stale");
      t.status = "stale"; t.updated = reapedAt; t._reaped = true; changed = true;
    }
  }
  if (changed) markDirty();
}
setInterval(reapStaleCards, REAP_INTERVAL_MS).unref?.();

// ---- the contract ledger: ONE derivation shared by GET /contracts and the reaper below ---------
// A contract is a DIRECT message from `session` to one peer, closed when that peer answers:
// strictly by `re`, or, for seats that predate that column, oldest-open-first. Broadcasts,
// self-dispatch and hub:* identities are excluded — none can ever be answered (0.17.87).
function humanMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 60000) return `${Math.max(1, Math.round(n / 1000))}s`;
  if (n < 3600000) return `${Math.round(n / 60000)}m`;
  return `${(n / 3600000).toFixed(n < 36000000 ? 1 : 0)}h`;
}

function contractRecipientIsAnswerable(m) {
  return !!m.to && m.to !== "all" && m.from !== m.to && !m.to.startsWith("hub:") && !m.from.startsWith("hub:");
}

// A direct message the SENDER declared owes nothing back (#7079): `wake:false` ("context, not a
// contract"), a `receipt`, or a `status` never buys the recipient a turn, so none can be answered —
// counted as contracts they age into `stalled` and block the dispatcher's stop hook over work that
// was never owed.
function contractIsAck(m) {
  return m.wake === false || m.kind === "receipt" || m.kind === "status";
}

function contractsFor(session, { project = "", windowMs = CONTRACT_WINDOW_MS, overdueMs = null } = {}) {
  const t = now();
  const cutoff = t - windowMs;
  const abandonCut = t - CONTRACT_ABANDON_MS;
  const onCut = t - ONLINE_MS;
  const mine = state.messages.filter(m =>
    m.from === session && m.ts >= cutoff && contractRecipientIsAnswerable(m) && (!project || m.project === project));
  const replies = state.messages.filter(m => m.to === session && m.from !== session && m.ts >= cutoff);
  // #7756: an ask (kind:"ask") rides `re` to name the contract it QUESTIONS — it is not the answer.
  // Counted as one, the contract would read answered while the seat sits blocked waiting.
  const byRe = new Map();
  for (const r of replies) if (r.re && r.kind !== "ask") byRe.set(Number(r.re), r);
  const looseByPeer = new Map();
  for (const r of replies) if (!r.re && r.kind !== "ask") { if (!looseByPeer.has(r.from)) looseByPeer.set(r.from, []); looseByPeer.get(r.from).push(r); }
  for (const arr of looseByPeer.values()) arr.sort((a, b) => a.ts - b.ts);

  const out = [];
  for (const c of mine.sort((a, b) => a.ts - b.ts)) {
    const ack = contractIsAck(c);
    let answer = byRe.get(c.id) || null;
    // An ack never claims a LOOSE reply: it is older than the real contract more often than not, and
    // letting it consume the seat's untagged "done" would leave the real row WAITING — a false stall
    // manufactured by the very row that was supposed to owe nothing.
    if (!answer && !ack) {
      const pool = looseByPeer.get(c.to) || [];
      const i = pool.findIndex(r => r.ts > c.ts);
      if (i >= 0) answer = pool.splice(i, 1)[0];
    }
    const peer = state.peers[c.to] || null;
    const seen = peer?.lastSeen || 0;
    const online = !!seen && seen > onCut;
    const ageMs = t - c.ts;
    const reaped = state.contractReap?.[String(c.id)] || null;

    // An answer ALWAYS wins, including over a recorded abandonment: the reap is evidence, not a
    // tombstone. A seat that comes back and reports still closes its own contract.
    let disposition;
    if (answer) disposition = "answered";
    else if (ack) disposition = "ack";                          // nothing owed: never waits, never stalls
    else if (seen < abandonCut) disposition = "abandoned";     // covers never-seen (seen === 0)
    else if (!online || (overdueMs != null && ageMs >= overdueMs)) disposition = "stalled";
    else disposition = "waiting";

    const row = {
      id: c.id, to: c.to, text: c.text, ts: c.ts, ageMs,
      answered: !!answer,
      answer: answer ? { id: answer.id, ts: answer.ts, text: answer.text } : null,
      disposition,
      assigneeOnline: online,
      assigneeStatus: String(peer?.status || ""),
      assigneeLastSeenMs: seen ? t - seen : null,
      reaped: reaped ? { ts: reaped.ts, reason: reaped.reason } : null,
    };
    // The two inputs the `ack` disposition is decided on, shown so a reader can tell a row that
    // LOST its flag (#7140: the store dropped it) from one that was never sent with it.
    if (c.wake === false) row.wake = false;
    if (c.kind) row.kind = c.kind;
    out.push(row);
  }

  // ---- superseded: the terminal state for a row nobody will ever answer ------------------------
  // `abandoned` keys on the ASSIGNEE being gone, so a permanently HEALTHY seat could strand a
  // contract forever — unanswerable, yet never abandoned — blocking the stop hook for days (#10573).
  // Two signals must agree (a newer answer AND age past the window) so out-of-order completion is safe.
  const newestAnswered = new Map();
  for (const c of out) {
    if (c.answered && c.ts > (newestAnswered.get(c.to) || 0)) newestAnswered.set(c.to, c.ts);
  }
  for (const c of out) {
    if (c.answered || c.disposition === "abandoned" || c.disposition === "ack") continue;
    if (c.ageMs < CONTRACT_ABANDON_MS) continue;
    if (c.ts < (newestAnswered.get(c.to) || 0)) c.disposition = "superseded";
  }
  // ---- superseded by a later DIRECT reply: the morning case (#11047/#11048) --------------------
  // Both matchers above only see replies aimed at NEWER work, so a healthy seat whose replies are
  // all `re`-threaded to newer contracts strands the old row even when newestAnswered misses it.
  // ANY later direct reply + past the abandon window = moved on; age gates out-of-order completion.
  const latestDirectReply = new Map();
  for (const r of replies) {
    if (r.ts > (latestDirectReply.get(r.from) || 0)) latestDirectReply.set(r.from, r.ts);
  }
  for (const c of out) {
    if (c.answered || c.disposition === "abandoned" || c.disposition === "ack") continue;
    if (c.ageMs < CONTRACT_ABANDON_MS) continue;
    const latest = latestDirectReply.get(c.to);
    if (latest != null && c.ts < latest) c.disposition = "superseded";
  }
  return out;
}

// Every session that has dispatched inside the ledger window. The reaper needs all of them; the
// endpoint only ever asks about one.
function contractDispatchers(windowMs = CONTRACT_WINDOW_MS) {
  const cutoff = now() - windowMs;
  const set = new Set();
  for (const m of state.messages) if (m.ts >= cutoff && contractRecipientIsAnswerable(m)) set.add(m.from);
  return set;
}

// The contract reaper. Records — never invents an answer for — a contract whose assignee has been
// quiet past CONTRACT_ABANDON_MS, persisted so the abandonment survives a hub restart and shows once
// in the FEED. It stops counting as open but stays listed with its evidence for `relay_contracts`.
function reapAbandonedContracts() {
  let changed = false;
  for (const session of contractDispatchers()) {
    for (const c of contractsFor(session)) {
      if (c.disposition !== "abandoned") continue;
      const key = String(c.id);
      if (state.contractReap[key]) continue;
      const quiet = c.assigneeLastSeenMs == null
        ? "never seen on the bus"
        : `last seen ${humanMs(c.assigneeLastSeenMs)} ago`;
      const reason = `assignee ${c.to} ${quiet}, past the ${humanMs(CONTRACT_ABANDON_MS)} abandon window`;
      state.contractReap[key] = { ts: now(), from: session, to: c.to, reason, dispatchedTs: c.ts };
      appendEvent("contract.abandoned", "", "reaper", {
        msgId: c.id, fromSession: session, toSession: c.to, reason,
        text: String(c.text || "").slice(0, 500),
      });
      changed = true;
    }
  }
  // Forget reap records whose contract has aged out of the ledger window entirely — nothing can
  // read them any more and the map would grow without bound.
  const cutoff = now() - CONTRACT_WINDOW_MS;
  for (const [key, r] of Object.entries(state.contractReap)) {
    if ((r?.dispatchedTs || 0) < cutoff) { delete state.contractReap[key]; changed = true; }
  }
  if (changed) markDirty();
}
setInterval(reapAbandonedContracts, REAP_INTERVAL_MS).unref?.();

  return {
    closeFocusCard, closeFocus, linkCommitToFocus, prunePeers, cardOwnerOnline,
    cardOwnerLastSeen, reapStaleCards, contractsFor, contractDispatchers,
    reapAbandonedContracts,
  };
}
