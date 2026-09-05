/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: Event payloads preserve the established card wire contract, including numeric cost fields from legacy durable rows. */
import { publicView } from "../lib/identity.mjs";

export function createEventRuntime({ state, markDirty, AUTH_MODE, ONLINE_MS, canon }) {
const streams = [];
// live file claims: "project file session" -> { project, file, session, ts }. Ephemeral like
// presence — see the /claim handler for the design.
const CLAIM_TTL_MS = Number(process.env.RELAY_CLAIM_TTL_MS || 10 * 60 * 1000);
const fileClaims = new Map();
function pruneClaims() {
  const cut = now() - CLAIM_TTL_MS;
  for (const [k, c] of fileClaims) if (c.ts < cut) fileClaims.delete(k);
}
const now = () => Date.now();
const fmtAge = ms => { const m = Math.floor(ms / 60000); return m > 48 * 60 ? `${Math.floor(m / 1440)}d ago` : m > 90 ? `${Math.floor(m / 60)}h ago` : `${m}m ago`; };
function applyPeerAuth(p, auth) {
  if (!p || AUTH_MODE === "off") return;
  if (auth?.identity) {
    p.pubkey = auth.pubkey || auth.identity.pubkey || "";
    p.identity = publicView(auth.identity);
    delete p.authWarning;
  } else if (auth?.warning) {
    p.authWarning = auth.warning;
  }
}
function touch(session, status, project, hookVersion, auth) {
  if (!session || session === "all") return;   // "all" is a wildcard, not a real peer
  const p = state.peers[session] || { lastSeen: 0, status: "", project: "" };
  // NOTE: peers deliberately carry NO terminal address (tty/window). A short-lived experiment recorded
  // one so an idle session could be woken by typing into its terminal; that was removed as unsafe.
  // /send is unauthenticated and `from` is self-asserted, so a routable terminal address turns any local
  // process into arbitrary keystrokes in a session that may be running with permissions bypassed. A
  // message must reach an agent through a channel the agent's own harness controls (see hooks/
  // inbox-deliver.mjs and hooks/stop-inbox.mjs), never by driving a process we do not own.
  delete p.tty; delete p.windowId; delete p.host;
  const wasOnline = p._on === true;   // explicit flag, so the log gets ONE event per transition
  p.lastSeen = now();
  if (status !== undefined) p.status = String(status).slice(0, 280);
  if (project) p.project = canon(String(project).slice(0, 80));
  // record the session's Trantor hook version so the dashboard can flag sessions running OLD hooks —
  // the real cure for the baton storm/kill bugs is restarting those sessions (fixes only load on start).
  if (hookVersion) p.hookVersion = String(hookVersion).slice(0, 20);
  // derive project from a "host:project" session id if none given
  if (!p.project && session.includes(":")) p.project = canon(session.split(":").pop().slice(0, 80));
  applyPeerAuth(p, auth);
  state.peers[session] = p; markDirty();
  // Log the OFFLINE→ONLINE transition only — never the heartbeat itself, or the log would be
  // nothing but presence noise. The matching offline edge is emitted by sweepPresence().
  if (!wasOnline) { p._on = true; appendEvent("presence.online", p.project, session, { status: p.status || "" }); }
}
// The offline edge: a peer quiet past ONLINE_MS is gone as far as the board is concerned. Runs on
// the same 60s tick as prunePeers (which only fires at the much longer PEER_TTL_MS), so the FEED
// shows a session leaving within a minute of it actually going quiet.
function sweepPresence() {
  const cut = now() - ONLINE_MS;
  for (const [session, p] of Object.entries(state.peers)) {
    if (p._on === true && (p.lastSeen || 0) < cut) {
      p._on = false; markDirty();
      appendEvent("presence.offline", p.project, session, { lastSeen: p.lastSeen || 0 });
    }
  }
}
// Derive a coarse health from the free-text status the runner sets on a failed turn
// ("errored: <reason>" / "down: <reason>") — lets the board show a failing-but-alive agent
// distinctly instead of a healthy green. Default "ok".
function healthOf(status) {
  const s = String(status || "").toLowerCase();
  if (s.startsWith("down")) return "down";
  if (s.startsWith("errored")) return "errored";
  return "ok";
}
function deliverable(m, session) { return (m.to === session || m.to === "all") && m.from !== session; }
// The delivery ledger: the highest message id this session has actually been handed. Every read path
// (/inbox, /poll) reports here, so ONE record answers "has this session seen message N yet?" regardless
// of whether it was the model polling (relay_inbox) or the PostToolUse hook injecting mid-turn.
// That is what lets the deferred waker give in-session delivery first refusal and only type into
// somebody's terminal when nothing else got there first. Monotonic — a later read never lowers it.
function markDelivered(session, upTo) {
  const p = state.peers[session]; const n = Number(upTo || 0);
  if (!p || !n) return;
  if (n > (p.deliveredUpTo || 0)) { p.deliveredUpTo = n; markDirty(); }
}
function pushToStreams(msg) {
  for (const s of streams) {
    if (!deliverable(msg, s.session) || s.res.writableEnded || s.res.destroyed) continue;
    try { s.res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {}
  }
}
// A live runner can outlast the durable snapshot it was polling. If its cursor is now beyond the
// message high-water mark, echoing that impossible value leaves it deaf forever. Clamp it to the
// current tip and say explicitly that time moved backwards so clients can adopt the lower cursor.
function inboxWindow(value) {
  const parsed = Number(value || 0);
  const requested = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  const tip = Math.max(Number(state.seq || 0), Number(state.messages[state.messages.length - 1]?.id || 0));
  const rewound = requested > tip;
  return { since: rewound ? tip : requested, tip, rewound };
}
function inboxResponse(auth, messages, cursor, rewound = false) {
  const response = { messages, cursor };
  if (rewound) response.rewound = true;
  if (auth?.superseded) response.superseded = true;
  return response;
}
// Live push for the FEED. Sent ONLY to streams that opted in with /stream?events=1, and as a NAMED
// SSE event ("event: ev") so an existing consumer's default onmessage handler — which expects a bus
// message and nothing else — can never see it. Backwards-safe by construction.
function pushEventToStreams(ev) {
  for (const s of streams) {
    if (!s.events || s.res.writableEnded || s.res.destroyed) continue;
    try { s.res.write(`event: ev\ndata: ${JSON.stringify(ev)}\n\n`); } catch {}
  }
}
// --- the unified event log ---------------------------------------------------------------
// One append-only stream for everything that happens in a project. Two families share it:
//   • CARD events keep the LEGACY flat shape and legacy type names ("created"/"moved"/"updated")
//     so /history, /card, /project/merge and the TIMELINE view are byte-for-byte unaffected.
//   • Everything else uses a DOTTED type ("message", "presence.online", "focus", "handoff.written",
//     "lesson", "verify.gate.opened", …) and is filtered OUT of /history — it surfaces via /events.
// Card events carry `source` + `costUsd` so the FEED can render a git commit or a sub-agent's
// spend distinctly from an ordinary card move without a second lookup.
const EVENT_CAP = Number(process.env.RELAY_EVENT_CAP || 20000);
const CARD_TYPES = new Set(["created", "moved", "updated"]);
const isCardEvent = e => CARD_TYPES.has(e?.type);

function appendEvent(type, project, by, extra = {}) {
  // The id comes from a monotonic high-water mark, NOT from the tail of the array. Trusting the tail
  // meant one bad id anywhere in the log made every future append collide, and ON CONFLICT DO NOTHING
  // then dropped them all without a word. `extra` is spread FIRST so a stray id in a payload can
  // never take over the event's own identity.
  const last = state.events[state.events.length - 1];
  state.eventSeq = Math.max(Number(state.eventSeq || 0), Number(last?.id) || 0) + 1;
  const ev = { ...extra, id: state.eventSeq, ts: now(), type, project: project || "", by: by || "" };
  state.events.push(ev);
  if (state.events.length > EVENT_CAP) state.events.splice(0, state.events.length - EVENT_CAP);
  pushEventToStreams(ev);
  markDirty();
  return ev;
}

function appendCardEvent(type, task, by, from = null, to = null) {
  return appendEvent(type, task.project, by, {
    taskId: task.id,
    title: task.title,
    from,
    to,
    difficulty: task.difficulty || null,
    assignee: task.assignee || null,
    source: task.source || null,
    costUsd: (typeof task.costUsd === "number" ? task.costUsd : null),
  });
}

  return {
    streams, fileClaims, CLAIM_TTL_MS, now, fmtAge, pruneClaims, touch,
    sweepPresence, healthOf, deliverable, markDelivered, pushToStreams,
    inboxWindow, inboxResponse, pushEventToStreams, appendEvent,
    appendCardEvent, EVENT_CAP, CARD_TYPES, isCardEvent,
  };
}

// --- FLOW v2: derive a project's PHASES (the orchestrator-rooted flowchart spine) ---
// Real data is deps-sparse (most cards carry no deps), so we DON'T derive phases from the
// dependency graph. Instead: a card's phase = its title-prefix family (P5a/P5b → "P5",
// CBv2-1/CBfix → "CB", FA-comp1 → "FA", …) when present; otherwise it's clustered with its
// time-neighbours into a "Setup N" round (gap > 8h opens a new round). Phases are ordered by
// first-seen. The orchestrator (host session, "machine:project") vs crew ("brand:project")
// split gives each phase its fan-out actors; the plan/integrate spine nodes are synthetic
// because real per-phase orchestrator cards are rare. `sparse` flags a board that's mostly
// un-prefixed (the UI shows an "inferred phases" notice — never a silent blob).
