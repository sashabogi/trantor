export function createReaper({
  state, now, canon, appendCardEvent, appendEvent, markDirty,
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
// The general stale-card reaper prunePeers never was. Every 60s:
//  (a) close a focus card once its session has been OFFLINE past FOCUS_OFFLINE_MS (not the old 6h peer TTL).
//  (b) move an OFFLINE-owner doing card to "stale" once it's untouched past REAP_GRACE_MS.
// Testing is waiting for the operator's verdict and is therefore outside the reaper's authority.
// It NEVER touches a card whose owner is still online, so a live long task is safe; the owner-alive-but-idle
// "forgot its card" case is left to the explicit /sweep path (preview + confirm).
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

// ---- the contract ledger -------------------------------------------------------------------
// ONE derivation, shared by GET /contracts and the reaper below. Two copies of this is how you get
// an endpoint and a sweeper that disagree about what is open, which is the same "two names for one
// intent" mistake the spawn guards made.
//
// A contract is a DIRECT message from `session` to one peer. It closes when that peer answers:
// strictly by `re`, or, for seats that predate that column, oldest-open-first. Excluded outright,
// because none of these can ever be answered and so would hang open forever:
//   - broadcasts (`to === "all"`)
//   - self-dispatch (`from === to`) — a reply from yourself is never counted as an answer
//   - the hub's own pseudo-identities (`hub:*`) and hub-authored mail — nothing polls them (0.17.87)
// Durations an agent READS and acts on, so they must not round to nonsense. Minutes are the useful
// unit in production (the abandon window is an hour), but the drills run in seconds and "past the 0m
// abandon window" is a sentence that tells the reader nothing.
function humanMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 60000) return `${Math.max(1, Math.round(n / 1000))}s`;
  if (n < 3600000) return `${Math.round(n / 60000)}m`;
  return `${(n / 3600000).toFixed(n < 36000000 ? 1 : 0)}h`;
}

function contractRecipientIsAnswerable(m) {
  return !!m.to && m.to !== "all" && m.from !== m.to && !m.to.startsWith("hub:") && !m.from.startsWith("hub:");
}

function contractsFor(session, { project = "", windowMs = CONTRACT_WINDOW_MS, overdueMs = null } = {}) {
  const t = now();
  const cutoff = t - windowMs;
  const abandonCut = t - CONTRACT_ABANDON_MS;
  const onCut = t - ONLINE_MS;
  const mine = state.messages.filter(m =>
    m.from === session && m.ts >= cutoff && contractRecipientIsAnswerable(m) && (!project || m.project === project));
  const replies = state.messages.filter(m => m.to === session && m.from !== session && m.ts >= cutoff);
  const byRe = new Map();
  for (const r of replies) if (r.re) byRe.set(Number(r.re), r);
  const looseByPeer = new Map();
  for (const r of replies) if (!r.re) { if (!looseByPeer.has(r.from)) looseByPeer.set(r.from, []); looseByPeer.get(r.from).push(r); }
  for (const arr of looseByPeer.values()) arr.sort((a, b) => a.ts - b.ts);

  const out = [];
  for (const c of mine.sort((a, b) => a.ts - b.ts)) {
    let answer = byRe.get(c.id) || null;
    if (!answer) {
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
    else if (seen < abandonCut) disposition = "abandoned";     // covers never-seen (seen === 0)
    else if (!online || (overdueMs != null && ageMs >= overdueMs)) disposition = "stalled";
    else disposition = "waiting";

    out.push({
      id: c.id, to: c.to, text: c.text, ts: c.ts, ageMs,
      answered: !!answer,
      answer: answer ? { id: answer.id, ts: answer.ts, text: answer.text } : null,
      disposition,
      assigneeOnline: online,
      assigneeStatus: String(peer?.status || ""),
      assigneeLastSeenMs: seen ? t - seen : null,
      reaped: reaped ? { ts: reaped.ts, reason: reaped.reason } : null,
    });
  }

  // ---- superseded: the terminal state for a row nobody will ever answer ------------------------
  // `abandoned` keys on the ASSIGNEE being gone, so a permanently HEALTHY seat could strand a
  // contract forever: it can never be answered (that seat's replies all carry `re` for other
  // contracts, so the loose-reply fallback above never claims this one) and it can never be
  // abandoned (the seat is alive). The row then blocks its dispatcher's stop hook every single
  // turn, for days — observed on #10573 across two consecutive sessions.
  //
  // TWO signals must agree, because either alone is wrong. "The peer answered something newer" on
  // its own would punish honest out-of-order completion — a seat handed three jobs may finish the
  // third first and still be working the second, which is a real pattern this suite already drills.
  // Age on its own would punish a seat legitimately grinding one long job. Together they are only
  // true when the assignee is alive, has moved on to later work, AND the row has sat unanswered
  // past the window in which any genuine in-flight job would have reported.
  const newestAnswered = new Map();
  for (const c of out) {
    if (c.answered && c.ts > (newestAnswered.get(c.to) || 0)) newestAnswered.set(c.to, c.ts);
  }
  for (const c of out) {
    if (c.answered || c.disposition === "abandoned") continue;
    if (c.ageMs < CONTRACT_ABANDON_MS) continue;
    if (c.ts < (newestAnswered.get(c.to) || 0)) c.disposition = "superseded";
  }
  // ---- superseded by a later DIRECT reply: the morning case (#11047/#11048) --------------------
  // A row can be unanswerable by a seat that is perfectly healthy: its later replies all carry `re`
  // for NEWER contracts (a re-dispatch, or an "ack by reference" threaded to the newer id), so
  // neither byRe nor the loose fallback ever claims the old row — the two matchers above only ever
  // see replies aimed at the NEWER work. The row then sits WAITING forever: it can never be
  // answered, it can never be abandoned (the seat is alive), and the newestAnswered rule above
  // misses it whenever the newer work was dispatched under a peer identity the old row never shares.
  //
  // The signal both matchers ignored is the DIRECT reply itself: if the assignee has sent this
  // session ANY message after the row was dispatched, the assignee is alive, reachable, and has
  // demonstrably moved on to later work — an older row that has then sat unanswered past the
  // abandon window is dead weight, not in flight. Age still gates it, so honest out-of-order
  // completion (a seat that answered a newer job while still working an older one) is never
  // punished — the older row stays open until the window that any genuine in-flight job would have
  // reported within has passed.
  const latestDirectReply = new Map();
  for (const r of replies) {
    if (r.ts > (latestDirectReply.get(r.from) || 0)) latestDirectReply.set(r.from, r.ts);
  }
  for (const c of out) {
    if (c.answered || c.disposition === "abandoned") continue;
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
// quiet past CONTRACT_ABANDON_MS, so the abandonment survives a hub restart (in-memory-only state is
// exactly why the escalation backlog re-fires on every restart) and shows up once in the FEED.
// After this the contract stops counting as open, so it stops nagging every future session; it stays
// listed with its evidence, so `relay_contracts` can still show what died.
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
