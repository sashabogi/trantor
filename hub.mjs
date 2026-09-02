#!/usr/bin/env node
// trantor hub — message bus + presence/status board + SSE push, so independent
// Claude Code sessions can coordinate (near-instant for watchers, cheap for idle peers).
// Binds to LOOPBACK (127.0.0.1) by default — local-first and safe (no auth yet). To let other
// machines reach it (e.g. over a Tailscale tailnet), set RELAY_HOST=0.0.0.0 — but only on a
// private network, or add auth first. See "Always-on / remote hub" in the README (roadmap).
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { verifyRequest, verifyEndorsement, publicView } from "./lib/identity.mjs";
import { DEFAULT_ORG } from "./lib/store-contract.mjs";
import { assertNoSecrets } from "./lib/scrub.mjs";

const PORT = Number(process.env.RELAY_PORT || 4477);
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const DATA_DIR = process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");
const DATA = process.env.RELAY_STATE || join(DATA_DIR, "bus.json");
const RAW_STORE_KIND = String(process.env.RELAY_STORE || "").toLowerCase();
const PG_URL = process.env.RELAY_DATABASE_URL || process.env.POSTGRES_URL || ((RAW_STORE_KIND === "pg" || RAW_STORE_KIND === "postgres") ? process.env.DATABASE_URL : "");
const STORE_KIND = RAW_STORE_KIND || (PG_URL ? "pg" : "json");
const ORG_ID = process.env.RELAY_ORG_ID || DEFAULT_ORG;
const AUTH_MODE = ["off", "warn", "enforce"].includes(process.env.RELAY_AUTH) ? process.env.RELAY_AUTH : "warn";
const ENROLL_MODE = process.env.RELAY_ENROLL || "tofu";
const ONLINE_MS = Number(process.env.RELAY_ONLINE_MS || 5 * 60 * 1000);
const PEER_TTL_DEFAULT_MS = 21600000; // 6h
const _peerTtlRaw = Number(process.env.RELAY_PEER_TTL_MS || PEER_TTL_DEFAULT_MS);
const PEER_TTL_MS = Math.max(Number.isFinite(_peerTtlRaw) ? _peerTtlRaw : PEER_TTL_DEFAULT_MS, ONLINE_MS);
// Stale-card reaper. The board only advances via active carding channels (crew turn reports, TodoWrite,
// git post-commit, SubagentStart/Stop, focus hook); the instant a channel breaks — a crew seat torn down
// mid-flight, a fork that crashed, a session that died uncleanly — the card is orphaned in whatever lane it
// was in and NOTHING ever swept it (prunePeers only ever closed the ONE focus card, and only after 6h).
// The reaper is the general safety net: a doing/testing card whose OWNER is OFFLINE past this grace window
// moves to "stale" (a distinct terminal lane you triage by hand). Only fires on an OFFLINE owner, so a live
// long-running task is never touched — the owner-alive-but-idle case is handled by the manual /sweep path.
const REAP_GRACE_MS = Number(process.env.RELAY_REAP_GRACE_MS || 15 * 60 * 1000);    // 15m offline + untouched
// Supersession lapse. The baton claim was documented "never unset", which is right while the claimant
// lives and wrong the moment it dies: a session that consumed a handoff, went quiet and was killed left
// every other instance of that identity muzzled FOREVER, deferring to a process that no longer exists
// (2026-08-27: 7e014e2a claimed the baton at 22:57, died by 23:13, and the orchestrator pane was still
// being told to stand down for it an hour later). The CLAIM stays stored and permanent — supersession is
// still explicit, we never invent one — but it is REPORTED only while the claimant is still being seen.
// If the claimant comes back, the muzzle re-engages by itself; nothing needs re-claiming.
const SUPERSEDE_GRACE_MS = Number(process.env.RELAY_SUPERSEDE_GRACE_MS || REAP_GRACE_MS);
const TODO_STALE_DEFAULT_MS = 14 * 24 * 60 * 60 * 1000;
const TODO_STALE_MS = Number.isFinite(Number(process.env.RELAY_TODO_STALE_MS))
  ? Math.max(0, Number(process.env.RELAY_TODO_STALE_MS))
  : TODO_STALE_DEFAULT_MS;
const FOCUS_OFFLINE_MS = Number(process.env.RELAY_FOCUS_OFFLINE_MS || ONLINE_MS);   // close a focus card once its session is offline (not the old 6h)
// Backstop for the case the peer heartbeat cannot see: several Claude sessions share ONE bus
// identity (it is per host+project), so a sibling that is still alive keeps the whole assignee
// "online" and a dead session's focus card would hang in `doing` forever. Long, because a card
// untouched for an hour is routine — a big task runs a long time between prompts.
const FOCUS_IDLE_MS = Number(process.env.RELAY_FOCUS_IDLE_MS || 6 * 60 * 60 * 1000);
const REAP_INTERVAL_MS = Number(process.env.RELAY_REAP_INTERVAL_MS || 60000);       // how often the reaper sweeps (env-tunable; tests set it low)
// Contract lifecycle. A contract closes when the ASSIGNEE answers — so a seat that does the work and
// then dies never closes one, and a session found 16 such ghosts in a day, every one with its files
// already on disk. The dispatcher then gets nagged about them at every stop, forever, and the human
// becomes the one who remembers. That is the complaint this whole area exists to answer.
//
// The fix is the stale-card lane's shape, not an auto-close: quiet is NOT proof of death, so the hub
// never marks a contract answered on the assignee's behalf. Instead a contract walks a lifecycle —
//   waiting   assignee online and inside the overdue window; this is what progress looks like
//   stalled   assignee offline, or overdue while online; ACTIONABLE, and what blocks a stop
//   abandoned assignee quiet past CONTRACT_ABANDON_MS; it can no longer resolve itself
// — and only the middle state nags. Abandoned ones stay in the ledger with their evidence so
// `relay_contracts` can still show what died, but they stop trapping every future session.
// The window is deliberately much longer than the stop hook's overdue window, so a contract is
// always surfaced as `stalled` (and acted on) BEFORE it can go quiet as `abandoned`.
const CONTRACT_ABANDON_MS = Number(process.env.RELAY_CONTRACT_ABANDON_MS || 60 * 60 * 1000);
const CONTRACT_WINDOW_MS = Number(process.env.RELAY_CONTRACT_WINDOW_MS || 24 * 60 * 60 * 1000);
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const isLoopbackHost = (host) => {
  const h = String(host || "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
};
const LOOPBACK_BIND = isLoopbackHost(HOST);
if (!LOOPBACK_BIND && AUTH_MODE !== "enforce") {
  process.stderr.write(`[trantor] refusing non-loopback bind ${HOST}:${PORT} with RELAY_AUTH=${AUTH_MODE}; use RELAY_AUTH=enforce\n`);
  process.exit(1);
}

// Scrooge ledger cache: /economics is polled every ~15s by the dashboard, but the ledger
// (~/.token-scrooge/calls.jsonl) only changes when a cheap-model call lands. Re-parse the whole
// file only when its mtime moves; otherwise reuse the parsed rows. Keeps the lifetime running
// total cheap to serve no matter how big the ledger grows.
let _ledgerCache = { mtimeMs: -1, rows: [] };

// Per-turn failure telemetry lives across many ~/.agent-bus/logs/<agent>-<project>.jsonl files
// (written by crew-runner.mjs). Scanning them all every /learning poll would be wasteful, so cache
// the aggregate and only rescan when a log file changes (tracked by the dir's newest mtime).
const LOGDIR = join(homedir(), ".agent-bus", "logs");
let _telemetryCache = { maxMtimeMs: -1, turns: [] };
function scanTelemetry() {
  let files = [];
  try { files = readdirSync(LOGDIR).filter(f => f.endsWith(".jsonl")); } catch { return _telemetryCache.turns; }
  let maxMtime = 0;
  for (const f of files) { try { const m = statSync(join(LOGDIR, f)).mtimeMs; if (m > maxMtime) maxMtime = m; } catch {} }
  if (maxMtime === _telemetryCache.maxMtimeMs) return _telemetryCache.turns;   // nothing changed
  const turns = [];
  for (const f of files) {
    let txt = ""; try { txt = readFileSync(join(LOGDIR, f), "utf8"); } catch { continue; }
    for (const line of txt.trim().split("\n")) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r && r.agent) turns.push(r); } catch {}
    }
  }
  _telemetryCache = { maxMtimeMs: maxMtime, turns };
  return turns;
}

// peers: { session: { lastSeen, status, project } } ; tasks: kanban cards
// projectMeta: { project: { brief, by, updated } } — the "what & why" blurb per project
// state.events — THE unified append-only log (v0.17.54). Card lifecycle, bus messages, presence,
// focus, handoffs, lessons and verify gates all land here as one chronological stream, so the BOARD
// (derived index) and the FEED (the log itself) are two lenses on the same truth. Card events keep
// their legacy flat shape + legacy type names ("created"/"moved"/"updated") so /history and the
// TIMELINE view are untouched; every NEW type is dotted ("message", "presence.online", …) and is
// filtered OUT of /history. Loads from the old `cardEvents` key when `events` is absent.
function emptyState() {
  return { messages: [], peers: {}, seq: 0, tasks: [], taskSeq: 0, projectMeta: {}, lessons: [], events: [], cardEventsBackfilled: false, aliases: {}, phaseMeta: {}, verifyGates: [], verifyGateSeq: 0, proposals: [], proposalSeq: 0, balances: { ts: 0, by: "", entries: [] }, subagentCostReset: false, handoffLog: [], identities: {}, inviteTokens: {}, focus: {}, orgPolicy: {}, instances: {}, dutySession: "", contractReap: {}, eventSeq: 0 };
}

const CARD_LOG_MAX = 40;
const CARD_LOG_TEXT_MAX = 2000;
const CARD_LOG_BY_MAX = 120;
function normalizeTaskLog(t) {
  if (!Array.isArray(t.log)) { if (t.log !== undefined) delete t.log; return false; }
  const before = JSON.stringify(t.log);
  t.log = t.log
    .filter(e => e && typeof e === "object" && typeof e.text === "string")
    .map(e => ({
      ts: Number.isFinite(Number(e.ts)) && Number(e.ts) > 0 ? Math.floor(Number(e.ts)) : Date.now(),
      by: String(e.by || "").slice(0, CARD_LOG_BY_MAX),
      text: String(e.text || "").slice(0, CARD_LOG_TEXT_MAX),
    }))
    .slice(-CARD_LOG_MAX);
  if (!t.log.length) delete t.log;
  return JSON.stringify(t.log) !== before;
}
function appendTaskLog(t, by, text, ts = Date.now()) {
  if (typeof text !== "string" || text.trim() === "") return false;
  const entry = {
    ts: Number.isFinite(Number(ts)) && Number(ts) > 0 ? Math.floor(Number(ts)) : Date.now(),
    by: String(by || "").slice(0, CARD_LOG_BY_MAX),
    text: String(text).slice(0, CARD_LOG_TEXT_MAX),
  };
  const log = Array.isArray(t.log) ? t.log : [];
  log.push(entry);
  if (log.length > CARD_LOG_MAX) log.splice(0, log.length - CARD_LOG_MAX);
  t.log = log;
  return true;
}
function appendTaskNote(t, b, ts = Date.now()) {
  if (!b || typeof b.note !== "string") return false;
  return appendTaskLog(t, b.by || "", b.note, ts);
}
// Card checklists (#5624): acceptance items are the one honest denominator for a progress bar.
// Accepts plain strings (fresh items) or {text,done} (round-trips); caps 20 items x 200 chars.
// Returns null for a non-array so callers can distinguish "not sent" from "sent empty".
function cleanChecklist(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 20)
    .map(it => typeof it === "string" ? { text: it.slice(0, 200), done: false }
      : { text: String(it?.text ?? "").slice(0, 200), done: !!it?.done })
    .filter(it => it.text);
}
function runTaskBootMigrations() {
  let changed = false;
  const bootNow = Date.now();
  for (const t of state.tasks) {
    if (!t || typeof t !== "object") continue;
    if (!t.ts) {
      t.ts = t.history?.[0]?.ts || t.updated || bootNow;
      changed = true;
    }
    if (normalizeTaskLog(t)) changed = true;
  }
  return changed;
}

function normalizeState(loaded = {}) {
  const s = emptyState();
  s.messages = Array.isArray(loaded.messages) ? loaded.messages : [];
  s.seq = Number(loaded.seq || 0);
  s.tasks = Array.isArray(loaded.tasks) ? loaded.tasks : [];
  s.taskSeq = Number(loaded.taskSeq || Math.max(0, ...s.tasks.map(t => Number(t.id) || 0))) || 0;
  s.projectMeta = loaded.projectMeta && typeof loaded.projectMeta === "object" ? loaded.projectMeta : {};
  s.lessons = Array.isArray(loaded.lessons) ? loaded.lessons : [];
  s.events = Array.isArray(loaded.events) ? loaded.events : (Array.isArray(loaded.cardEvents) ? loaded.cardEvents : []);
  s.cardEventsBackfilled = !!loaded.cardEventsBackfilled;
  s.aliases = loaded.aliases && typeof loaded.aliases === "object" ? loaded.aliases : {};
  s.phaseMeta = loaded.phaseMeta && typeof loaded.phaseMeta === "object" ? loaded.phaseMeta : {};
  s.verifyGates = Array.isArray(loaded.verifyGates) ? loaded.verifyGates : [];
  s.verifyGateSeq = Number(loaded.verifyGateSeq || Math.max(0, ...s.verifyGates.map(g => Number(g.id) || 0))) || 0;
  s.proposals = Array.isArray(loaded.proposals) ? loaded.proposals : [];
  s.proposalSeq = Number(loaded.proposalSeq || Math.max(0, ...s.proposals.map(p => Number(p.id) || 0))) || 0;
  s.balances = loaded.balances && typeof loaded.balances === "object" ? loaded.balances : { ts: 0, by: "", entries: [] };
  s.subagentCostReset = !!loaded.subagentCostReset;
  s.handoffLog = Array.isArray(loaded.handoffLog) ? loaded.handoffLog : [];
  s.identities = loaded.identities && typeof loaded.identities === "object" ? loaded.identities : {};
  s.inviteTokens = loaded.inviteTokens && typeof loaded.inviteTokens === "object" ? loaded.inviteTokens : {};
  s.instances = loaded.instances && typeof loaded.instances === "object" ? loaded.instances : {};
  s.focus = loaded.focus && typeof loaded.focus === "object" ? loaded.focus : {};
  s.orgPolicy = loaded.orgPolicy && typeof loaded.orgPolicy === "object" ? loaded.orgPolicy : {};
  s.dutySession = String(loaded.dutySession || "");
  s.contractReap = loaded.contractReap && typeof loaded.contractReap === "object" ? loaded.contractReap : {};
  // The event id high-water mark. Seeded from the store's own MAX(id) where it supplied one, and
  // otherwise from the largest id in the array — never from the array TAIL, which is exactly the
  // assumption that let a clobbered id mint colliding event ids and kill the log.
  s.eventSeq = Math.max(
    Number(loaded.eventSeq || 0),
    ...s.events.map(e => Number(e?.id) || 0),
    0,
  );
  for (const [session, v] of Object.entries(loaded.peers || {})) {
    // migrate old numeric form
    s.peers[session] = typeof v === "number"
      ? { lastSeen: v, status: "", project: "" }
      : { lastSeen: v.lastSeen || 0, status: v.status || "", project: v.project || "", pubkey: v.pubkey || "", identity: v.identity || null, authWarning: v.authWarning || "", hookVersion: v.hookVersion || "", deliveredUpTo: v.deliveredUpTo || v.delivered_up_to || 0, _on: v._on === true || v.online === true };
  }
  return s;
}

let durableStore = null;
let state = emptyState();
if (STORE_KIND === "pg" || STORE_KIND === "postgres") {
  try {
    const { createPgStore } = await import("./lib/store-pg.mjs");
    durableStore = createPgStore({ url: PG_URL });
    // An event insert that hits ON CONFLICT DO NOTHING is a LOST append, not a no-op. Silence here
    // hid a dead log for 18 days. Never let it be quiet again.
    durableStore.onDroppedEvent = ({ id, type }) => {
      process.stderr.write(`[trantor] EVENT DROPPED: id ${id} (${type}) already exists — the append-only log is not appending. This is a bug, not routine.\n`);
    };
    await durableStore.init();
    if (ORG_ID !== DEFAULT_ORG) await durableStore.createOrg({ id: ORG_ID, name: ORG_ID, ownerPubkey: "local-owner" });
    state = normalizeState(await durableStore.loadSnapshot(ORG_ID));
  } catch (e) {
    process.stderr.write(`[trantor] failed to initialise Postgres store: ${e.message || e}\n`);
    process.exit(1);
  }
} else {
  try {
    if (existsSync(DATA)) state = normalizeState(JSON.parse(readFileSync(DATA, "utf8")));
  } catch {}
}
let dirty = false;
// Persist the unified log under `events`, AND mirror the card-only subset under the legacy
// `cardEvents` key — so downgrading to a pre-0.17.54 hub still boots with its full TIMELINE
// instead of a silently empty history. Cheap insurance on a live hub; drop the mirror later.
let persisting = false;
const snapshotState = () => JSON.parse(JSON.stringify({ ...state, cardEvents: state.events.filter(e => ["created", "moved", "updated"].includes(e?.type)) }));
// This hub's writer id: saveDelta stamps it into every NOTIFY so we can tell our own change
// notifications apart from a second writer's (importer, admin psql, another hub instance).
const HUB_SRC = `hub-${process.pid}-${randomBytes(4).toString("hex")}`;
// What the DB currently holds, as of our last successful persist. saveDelta diffs against this and
// writes ONLY the difference — it never deletes rows it has not seen, so a second writer's rows
// survive our persist ticks (the old saveSnapshot wholesale delete+rewrite destroyed them).
let lastPersisted = durableStore ? snapshotState() : null;
if (runTaskBootMigrations()) dirty = true;
const persist = () => {
  if (!dirty || persisting) return;
  if (durableStore) {
    const snapshot = snapshotState();
    dirty = false; persisting = true;
    durableStore.saveDelta(ORG_ID, lastPersisted, snapshot, { src: HUB_SRC }).then(() => {
      lastPersisted = snapshot;
    }).catch(e => {
      dirty = true;
      process.stderr.write(`[trantor] Postgres persist failed: ${e.message || e}\n`);
    }).finally(() => {
      persisting = false;
      if (dirty) persist();
    });
    return;
  }
  try { writeFileSync(DATA, JSON.stringify(snapshotState())); dirty = false; } catch {}
};
setInterval(persist, 1000).unref?.();

// --- reload on external change (the boot-cache fix) -------------------------------------------
// A NOTIFY from any writer that isn't us means Postgres has rows our in-memory projection has
// never seen. Flush our own un-persisted delta first (delta writes can't clobber foreign rows),
// then reload the snapshot and swap it in. If a request mutated state while the reload was in
// flight, discard the loaded snapshot and go again — hub writes are never lost to a reload.
let reloadTimer = null, reloading = false, reloadAgain = false;
function scheduleStoreReload() {
  if (reloadTimer || reloading) { reloadAgain = reloading; return; }
  reloadTimer = setTimeout(() => { reloadTimer = null; reloadFromStore(); }, 250);
}
async function reloadFromStore() {
  if (!durableStore || reloading) { reloadAgain = reloading; return; }
  reloading = true;
  try {
    for (let i = 0; i < 100 && (dirty || persisting); i++) {
      persist();
      await new Promise(r => setTimeout(r, 50));
    }
    const loaded = normalizeState(await durableStore.loadSnapshot(ORG_ID));
    if (dirty || persisting) {
      reloadAgain = true;                      // raced with a request: flush + reload again
    } else {
      state = loaded;
      lastPersisted = snapshotState();
      pushEventToStreams({ ts: Date.now(), type: "hub.reload", project: "", by: "" });
    }
  } catch (e) {
    process.stderr.write(`[trantor] store reload failed: ${e.message || e}\n`);
  } finally {
    reloading = false;
    if (reloadAgain) { reloadAgain = false; scheduleStoreReload(); }
  }
}
// --- the OVERSEER (levels 1-2 + the level-3 gate) -------------------------------------------
// Detection is MECHANICAL (lib/overseer.mjs, pure); the LLM only narrates (bin/overseer-narrate).
// Lazy import: the engine module lands from a crew seat in parallel — the hub runs without it and
// picks it up on next restart. Warnings dedup on a 10-minute window so a standing collision does
// not spam the feed; at level >= 3 a file-conflict opens a verify gate (the go/no-go primitive).
let _overseer = null;
import("./lib/overseer.mjs").then(m => { _overseer = m; }).catch(() => {});
// #5760: the same-project episode rule (lib/same-project.mjs, pure) — lazy like the detector, so
// a hub booted before the module lands still runs (the same-project branch fails QUIET until it
// arrives: a missing rule must never re-instate the hourly metronome).
let _sameProject = null;
import("./lib/same-project.mjs").then(m => { _sameProject = m; }).catch(() => {});
// This hub runs on the operator's machine, so the machine's own sessions ("<host>:<project>") ARE
// the orchestrator side of every declared crew.
const HOST_NAME = hostname().split(".")[0];
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

// The declared crew: the seats `trantor up` spawned (crew-windows.txt rows are
// project\tmux\tagent\tpane; __-prefixed markers are not sessions) plus the operator's own
// orchestrator session on this machine ("<host>:<project>").
function declaredCrewFor(project) {
  const crew = new Set();
  try {
    for (const line of readFileSync(join(homedir(), ".agent-bus", "crew-windows.txt"), "utf8").split("\n")) {
      const c = line.split("\t");
      if (c.length >= 3 && c[0] === project && c[2] && !c[2].startsWith("__")) crew.add(`${c[2]}:${project}`);
    }
  } catch { /* no crew declaration recorded: only the operator's own session is exempt */ }
  crew.add(`${HOST_NAME}:${project}`);
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
    hubSend(me,
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
      const parties = [...new Set(c.sessions || [])].filter(s => s && s !== DUTY_SESSION);
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
      if (DUTY_SESSION) hubSend(DUTY_SESSION, `⚠️ OVERSEER ${c.kind} [${c.project}]: ${c.detail || ""} — if the parties are not already coordinating, message them.`, c.project);
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
    const parties = [...new Set(c.sessions || [])].filter(s => s && s !== DUTY_SESSION);
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
    if (DUTY_SESSION) hubSend(DUTY_SESSION, `⚠️ OVERSEER ${c.kind} [${c.project}]: ${c.detail || ""} — if the parties are not already coordinating, message them.`, c.project);
    if (parties.length > 1) for (const me of parties) intro(c, me, parties);
    const level = _overseer.levelFor ? _overseer.levelFor(c.project, pol.autonomy) : 1;
    if (level >= 3 && c.kind === "file-conflict") {
      const g = { id: ++state.verifyGateSeq, project: c.project, status: "open", ts: now(),
        by: "overseer", claim: `file conflict: ${(c.files || []).join(", ")} — ${(c.sessions || []).join(" vs ")}`,
        why: c.detail || "two live sessions on the same file", howToVerify: "decide who proceeds; coordinate over the bus" };
      state.verifyGates.push(g); dirty = true;
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
// setInterval waits a FULL period before its first call, so for 30s after every restart the watcher
// had no lastTick and honestly reported itself stalled. Tick once shortly after boot (the delay lets
// the lazy lib import land) so a restarted hub proves it is alive immediately.
setTimeout(overseerTick, 2000).unref?.();

// --- the DUTY AGENT feed (deterministic escalation; the seat itself is bin/duty.mjs) -----------
// RELAY_DUTY_SESSION names the always-on triage seat (e.g. "claude:fleet"). The hub DMs it when:
//   1. a DIRECT message has sat undelivered past RELAY_DUTY_UNDELIVERED_MS — the sender believes
//      it was heard and nobody is listening (the crebral-health 4-day failure mode);
//   2. the overseer emits a warning (wired inside overseerTick below).
// Escalations are hub-authored ("hub:duty") — they never impersonate a session — and dedup per
// message id so a standing outage escalates once, not every tick.
// Settable at runtime via POST /overseer/duty, because the seat is the only party that knows it
// came up — and it often enrolls with a REMOTE hub, where no local env var could ever reach.
// Env still wins at boot (an operator's declared config beats a seat's claim); otherwise the last
// registered seat is restored from state, so a hub restart doesn't silently end the duty feed.
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
  dirty = true; pushToStreams(msg);
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

if (durableStore?.subscribeChanges) {
  durableStore.subscribeChanges((p) => {
    if (p && p.src === HUB_SRC) return;
    scheduleStoreReload();
  }).catch(e => process.stderr.write(`[trantor] LISTEN ${e.message || e} — external writes will NOT surface until restart\n`));
}
// One-time migration: collapse legacy un-deduped cc-subagent cards. Each SubagentStop minted a fresh
// card, and the infra recall/last-handoff sub-agents fire EVERY session → hundreds of near-identical
// dupes that drowned the board + stretched the FLOW canvas to thousands of px. Merge by
// (project + normalized title) into one rolling card (count + summed cost/tokens). Idempotent.
(() => {
  const subs = state.tasks.filter(t => t.source === "cc-subagent");
  if (subs.length < 2) return;
  const groups = new Map();
  for (const t of subs) {
    if (!t._fp) t._fp = subFp(t.title);
    const key = t.project + " " + t._fp;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const remove = new Set(); let collapsed = 0;
  for (const g of groups.values()) {
    if (g.length < 2) { if (g[0].count == null) g[0].count = 1; continue; }
    g.sort((a, b) => a.id - b.id);
    const keep = g[0];
    let cnt = 0, usd = 0, anyUsd = false, latestTs = 0, model = keep.model || "";
    const tok = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (const t of g) {
      cnt += (t.count || 1);
      if (typeof t.costUsd === "number") { usd += t.costUsd; anyUsd = true; }
      if (t.tokens) { tok.input += t.tokens.input || 0; tok.output += t.tokens.output || 0; tok.cacheWrite += t.tokens.cacheWrite || 0; tok.cacheRead += t.tokens.cacheRead || 0; }
      latestTs = Math.max(latestTs, t.updated || t.ts || 0);
      if (!model && t.model) model = t.model;
      if (t !== keep) remove.add(t.id);
    }
    keep.count = cnt; keep.costUsd = anyUsd ? +usd.toFixed(6) : null; keep.tokens = tok;
    keep.model = model; keep.status = "done"; keep.updated = latestTs || keep.updated;
    collapsed += g.length - 1;
  }
  if (collapsed > 0) {
    state.tasks = state.tasks.filter(t => !remove.has(t.id));
    if (Array.isArray(state.events)) state.events = state.events.filter(e => !remove.has(e.taskId));
    dirty = true; persist();
    process.stderr.write(`[trantor] migration: collapsed ${collapsed} duplicate cc-subagent cards → ${groups.size} rolling cards\n`);
  }
})();
// One-time cleanup (v0.17.37): before the findTranscript fix, the SubagentStop hook mis-resolved
// recall/handoff sub-agent transcripts to the PARENT session (1000+ turns, 100s of M cache-read), so
// cc-subagent cards were inflated to tens of thousands of $ notional (real on-disk total ≈ $1.9k). The
// data is contaminated + unrecoverable per-card (transcripts rotated, cards collapsed) — null all
// historical cc-subagent costs and let the FIXED hook rebuild correct numbers. One-shot (flagged) so it
// never wipes the future correct costs the fixed hook records.
if (!state.subagentCostReset) {
  let n = 0;
  for (const t of state.tasks) {
    if (t.source === "cc-subagent" && (t.costUsd != null || t.tokens)) {
      t.costUsd = null; t.tokens = null; t.costNote = "reset v0.17.37 — pre-fix notional was inflated (parent-transcript bug)"; n++;
    }
  }
  state.subagentCostReset = true; dirty = true; persist();
  if (n) process.stderr.write(`[trantor] migration: reset inflated notional cost on ${n} cc-subagent card(s)\n`);
}
// One-time backfill: reconstruct the cardEvents history log from each card's authoritative per-card
// `history` trail, so projects that existed BEFORE the cardEvents log show their FULL past in the
// TIMELINE view (not just events from now on). Guarded by a flag so it runs once where cardEvents
// persists; in team mode cardEvents is in-memory, so this re-derives from the persisted task.history
// on every boot — which is exactly right.
function backfillCardEvents() {
  if (state.cardEventsBackfilled && state.events.length) return;
  const events = [];
  for (const t of (state.tasks || [])) for (const h of (t.history || [])) {
    events.push({ ts: h.ts || 0, type: h.from ? "moved" : "created", taskId: t.id, project: t.project,
      title: t.title, from: h.from || null, to: h.to || null, by: h.by || "",
      difficulty: t.difficulty || null, assignee: t.assignee || null });
  }
  if (events.length) {
    events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (events.length > 5000) events.splice(0, events.length - 5000);
    events.forEach((e, i) => { e.id = i + 1; });
    state.events = events; dirty = true;
  }
  state.cardEventsBackfilled = true; dirty = true;
}
backfillCardEvents();
// A session's live "focus" card (source:"session") tracks what a REGULAR session is working on RIGHT NOW
// (set from each user prompt by hooks/prompt-focus.mjs). When the session ends (pruned offline), close its
// open focus card to "done" so the board doesn't keep a dead session "in progress" forever.
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
  if (removed) dirty = true;
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
// The general stale-card reaper prunePeers never was. Every 60s:
//  (a) close a focus card once its session has been OFFLINE past FOCUS_OFFLINE_MS (not the old 6h peer TTL).
//  (b) move an OFFLINE-owner doing/testing card to "stale" once it's untouched past REAP_GRACE_MS.
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
    if (t.status === "todo" && (t.updated || t.ts || 0) < now() - TODO_STALE_MS) {
      const from = t.status;
      const untouchedAt = t.updated || t.ts || 0;
      const agedDays = Math.floor((now() - untouchedAt) / 86400000);
      (t.history ||= []).push({ from, to: "stale", by: "reaper", ts: now() });
      if (t.history.length > 60) t.history.splice(0, 20);
      appendTaskLog(t, "reaper", `todo aged out after ${agedDays}d untouched`);
      appendCardEvent("moved", t, "reaper", from, "stale");
      t.status = "stale"; t.updated = now(); t._reaped = true; changed = true;
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
    if ((t.status === "doing" || t.status === "testing")           // (b) offline-owner work cards → stale
        && (t.updated || t.ts || 0) < graceCut
        && !cardOwnerOnline(t, onCut)) {
      (t.history ||= []).push({ from: t.status, to: "stale", by: "reaper", ts: now() });
      if (t.history.length > 60) t.history.splice(0, 20);
      appendCardEvent("moved", t, "reaper", t.status, "stale");
      t.status = "stale"; t.updated = now(); t._reaped = true; changed = true;
    }
  }
  if (changed) dirty = true;
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
  if (changed) dirty = true;
}
setInterval(reapAbandonedContracts, REAP_INTERVAL_MS).unref?.();

// dashboard HTML (read once at startup)
let UI = "";
try { UI = readFileSync(new URL("./ui.html", import.meta.url), "utf8"); } catch {}

// open SSE streams: [{ session, res }]
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
function rawBody(req) {
  if (req._rawBody !== undefined) return Promise.resolve(req._rawBody);
  return new Promise(r => { let d = ""; req.on("data", c => (d += c)); req.on("end", () => { req._rawBody = d; r(d); }); });
}
async function body(req) {
  if (req._jsonBody !== undefined) return req._jsonBody;
  const d = await rawBody(req);
  try { req._jsonBody = d ? JSON.parse(d) : {}; } catch { req._jsonBody = {}; }
  return req._jsonBody;
}
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); }
// Canonical project name: follow the alias chain so historically-divergent keys
// (e.g. "builtbetter" → "builtbetter.ai") fold into one lane on every read AND
// write. Cycle-guarded. Empty/"all" pass through untouched.
function canon(name) {
  let n = String(name || "").slice(0, 80);
  const seen = new Set();
  while (n && state.aliases[n] && !seen.has(n)) { seen.add(n); n = state.aliases[n]; }
  return n;
}
// Fingerprint for collapsing auto cost-tracking sub-agent cards: every SubagentStop posts one card,
// and infra sub-agents (session recall / last-handoff) fire EVERY session, so left un-deduped they
// pile into hundreds of near-identical cards. Normalize the title (the agentType prefix is part of it)
// so identical sub-agent invocations map to one rolling card.
function subFp(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
}
// Governance (agent-proposed permissions): pending-per-session cap, and the normalized fingerprint
// the denial memory compares against. scope+condition define WHAT is being asked; exclusions are
// deliberately left out of the fingerprint so narrowing the exclusions alone cannot dodge a denial.
const PROPOSAL_CAP = Number(process.env.RELAY_PROPOSAL_CAP || 3);
const propFp = (scope, condition) => `${scope} ${condition}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
let HUB_VERSION = ""; try { HUB_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version || ""; } catch {}
// dependency-free semver compare: -1 if a<b, 0 if equal, 1 if a>b (numeric parts only)
function cmpSemver(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0), pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) < (pb[i] || 0)) return -1; if ((pa[i] || 0) > (pb[i] || 0)) return 1; }
  return 0;
}
const AUTH_HEADERS = ["x-trantor-pubkey", "x-trantor-sig", "x-trantor-ts", "x-trantor-nonce"];
const PUBLIC_ENDPOINTS = new Set(["/", "/ui", "/health", "/enroll"]);
const OWNER_ENDPOINTS = new Set(["/project/delete", "/sweep", "/reconcile", "/invite", "/import", "/policy", "/proposal/decide"]);
const READ_ENDPOINTS = new Set(["/peers", "/tasks", "/events", "/inbox", "/peer", "/card", "/stream", "/history", "/projects", "/catchup", "/phases", "/recent", "/handoffs", "/verify-gates", "/claims", "/proposals", "/grants", "/overseer/context", "/overseer/status"]);
const roleRank = { read: 1, write: 2, owner: 3 };
const hasAuthHeaders = (req) => AUTH_HEADERS.some(h => !!req.headers[h]);
const authPath = (u) => `${u.pathname}${u.search || ""}`;
function cleanScope(s) {
  if (!s || typeof s !== "object") return null;
  const project = canon(String(s.project || s.proj || "*").slice(0, 80)) || "*";
  const role = ["read", "write", "owner"].includes(s.role) ? s.role : "read";
  return { project, role };
}
function defaultScopesFor(identity, b) {
  const explicit = Array.isArray(b.scopes) ? b.scopes.map(cleanScope).filter(Boolean) : [];
  if (explicit.length) return explicit.slice(0, 20);
  const name = String(b.name || identity.name || "");
  const project = canon(String(b.project || (name.includes(":") ? name.split(":").pop() : "*")).slice(0, 80)) || "*";
  const role = ["read", "write", "owner"].includes(b.role) ? b.role : (String(b.kind || identity.kind || "") === "agent" ? "write" : "owner");
  return [{ project, role }];
}
function findIdentity(pubkey) {
  const id = state.identities?.[pubkey];
  if (!id || id.revoked) return null;
  return id;
}
function scopeAllows(identity, project, minRole) {
  if (!identity) return false;
  const need = roleRank[minRole] || roleRank.read;
  const proj = canon(project || "");
  for (const s of identity.scopes || []) {
    const role = roleRank[s.role] || 0;
    if (role >= need && (s.project === "*" || !proj || canon(s.project) === proj)) return true;
  }
  return false;
}
const canRead = (auth, project) => AUTH_MODE !== "enforce" && !auth?.identity ? true : scopeAllows(auth?.identity, project, "read");
function projectFromRequest(P, q, b) {
  if (P === "/task/update" || P === "/card") {
    const t = state.tasks.find(x => x.id === Number(b?.id ?? q?.id));
    return t?.project || "";
  }
  if (P === "/send") {
    const from = String(b?.from || "");
    const fromProj = state.peers[from]?.project || (from.includes(":") ? from.split(":").pop() : "");
    return canon(String(b?.project || fromProj || "").slice(0, 80));
  }
  if (P === "/project/merge") return canon(String(b?.to || b?.from || "").slice(0, 80));
  // decide/withdraw carry only an id — authorization must run against the PROPOSAL's project, or a
  // project-scoped owner could decide any proposal on the hub through the empty-project wildcard.
  if (P === "/proposal/decide" || P === "/proposal/withdraw") {
    const p = state.proposals.find(x => x.id === Number(b?.id ?? q?.id));
    return p?.project || "";
  }
  return canon(String(b?.project || q?.project || "").slice(0, 80));
}
// Is a stored baton claim still worth honouring? The claim names the instance it spared
// (`exceptInstanceId`), so we defer to THAT instance only while it is still being seen. A claimant
// that died stops muzzling its twins; one that comes back starts again. Records claimed before
// `supersededBy` existed carry no claimant, so they fall back to "is any OTHER live instance of this
// name still carrying it?" — an orphaned flag must not outlive every possible carrier.
// NOTE lastSeen only advances on a request, and the heartbeat is PostToolUse, so an alive-but-idle
// claimant reads as gone after the grace window. That is the intended trade: the only session that
// ever asks this question is one a human is actively driving right now, and deferring to a claimant
// that has been silent for longer than the window is worse than letting the driven session work.
function supersessionActive(rec) {
  if (!rec?.superseded) return false;
  const cut = now() - SUPERSEDE_GRACE_MS;
  const insts = Object.values(state.instances || {});
  if (rec.supersededBy) {
    const claimant = insts.find(i => i.name === rec.name && i.instanceId === rec.supersededBy);
    // Claimant not seen YET — the owner can supersede on a session's behalf before its first signed
    // request. Honour the claim for one grace window measured from the CLAIM, so a booting successor
    // still lands its baton, but one that never arrives lapses like one that died.
    if (!claimant) return rec.superseded > cut;
    return (claimant.lastSeen || 0) > cut;
  }
  return insts.some(i => i !== rec && i.name === rec.name && !i.superseded && (i.lastSeen || 0) > cut);
}
async function authenticate(req, path) {
  if (AUTH_MODE === "off") return { ok: true, mode: AUTH_MODE, trusted: true };
  const signed = hasAuthHeaders(req);
  if (!signed) {
    if (AUTH_MODE === "warn") {
      process.stderr.write(`[trantor] auth warn: unsigned ${req.method} ${path}\n`);
      return { ok: true, mode: AUTH_MODE, trusted: false, warning: "unsigned" };
    }
    return { ok: false, code: 401, error: "signature required" };
  }
  const raw = req.method === "GET" || req.method === "HEAD" ? undefined : await rawBody(req);
  // WARN MODE NEVER BLOCKS — it annotates. That is its entire contract: an observation period
  // where the hub records what WOULD fail under enforce. The restarted local hub proved the
  // failure mode: signed requests from a not-yet-enrolled identity got 401 "unknown identity"
  // while UNSIGNED requests passed — punishing exactly the clients that already do the right
  // thing. Under warn: bad signature, replay and unknown identity all pass with a warning;
  // under enforce they are the hard failures they should be.
  const soft = (warning) => AUTH_MODE === "warn"
    ? { ok: true, mode: AUTH_MODE, trusted: false, warning }
    : { ok: false, code: 401, error: warning };
  const verified = verifyRequest({ headers: req.headers, method: req.method, path, body: raw });
  if (!verified.ok) return soft(verified.reason || "bad signature");
  const nonceKey = `${verified.pubkey}:${verified.nonce}`;
  for (const [k, ts] of seenNonces) if (Math.abs(now() - ts) > 120000) seenNonces.delete(k);
  if (seenNonces.has(nonceKey)) return soft("replay");
  seenNonces.set(nonceKey, verified.ts);
  if (seenNonces.size > 10000) seenNonces.delete(seenNonces.keys().next().value);
  // Instance-subkey path (docs/INSTANCE-KEYS-CONTRACT.md): when the three endorsement headers ride
  // along, x-trantor-pubkey was the INSTANCE key (whose signature we just verified). Verify that the
  // claimed DURABLE key endorsed it, then authenticate AS the durable identity — the instance mints
  // no authority of its own; it is the durable identity, time-boxed to one session.
  const h = (k) => req.headers[k] ?? "";
  const durableHdr = h("x-trantor-durable"), instId = h("x-trantor-inst");
  if (durableHdr && instId) {
    const endorsed = verifyEndorsement({
      durablePubkey: durableHdr, instancePubkey: verified.pubkey, instanceId: instId,
      createdAt: state.instances?.[verified.pubkey]?.createdAt || Number(h("x-trantor-inst-ts")) || 0,
      endorsement: h("x-trantor-endorse"),
    });
    if (!endorsed) return soft("bad endorsement");
    const identity = findIdentity(durableHdr);
    if (!identity) return soft("unknown identity");
    if (!state.instances || typeof state.instances !== "object") state.instances = {};
    const rec = state.instances[verified.pubkey] ||
      { durable: durableHdr, instanceId: instId, name: identity.name || "", firstSeen: now(),
        createdAt: Number(h("x-trantor-inst-ts")) || now(), superseded: false };
    rec.lastSeen = now();
    state.instances[verified.pubkey] = rec; dirty = true;
    return { ok: true, mode: AUTH_MODE, trusted: true, pubkey: durableHdr, identity,
             instanceId: instId, instancePubkey: verified.pubkey, superseded: supersessionActive(rec) };
  }
  const identity = findIdentity(verified.pubkey);
  if (!identity) return soft("unknown identity");
  return { ok: true, mode: AUTH_MODE, trusted: true, pubkey: verified.pubkey, identity };
}
function authorize(auth, method, P, project) {
  if (AUTH_MODE === "off" || PUBLIC_ENDPOINTS.has(P)) return { ok: true };
  if (auth?.warning && AUTH_MODE === "warn") return { ok: true };
  if (!auth?.identity) return { ok: false, code: 401, error: "signature required" };
  const need = OWNER_ENDPOINTS.has(P) ? "owner" : (method === "POST" ? "write" : (READ_ENDPOINTS.has(P) ? "read" : "read"));
  return scopeAllows(auth.identity, project, need) ? { ok: true } : { ok: false, code: 403, error: "forbidden" };
}
function filterReadable(auth, rows, projectOf) {
  if (AUTH_MODE !== "enforce" && !auth?.identity) return rows;
  return rows.filter(row => canRead(auth, projectOf(row)));
}
// DISCOVERY follows declared links, and is deliberately wider than read.
//
// Sending across projects was never blocked: /send authorizes against the SENDER's project, so any
// session can DM any session id it happens to know. Only the ROSTER was scoped — which meant two
// sessions the operator had explicitly declared codependent could not learn each other's ids. The
// overseer would tell both of them to "coordinate over the bus" and neither could find the other,
// so the only remaining channel was the human. That is the exact traffic-cop role this project
// exists to delete.
//
// A link is an operator declaration that two projects share resources. Treating it as mutual
// discovery grants nothing a linked pair wasn't already told to do.
function canDiscover(auth, project) {
  if (canRead(auth, project)) return true;
  const proj = canon(project || "");
  if (!proj) return false;
  for (const l of overseerPolicy().links) {
    const ps = (l.projects || []).map(p => canon(p));
    if (ps.includes(proj) && ps.some(p => p !== proj && canRead(auth, p))) return true;
  }
  return false;
}
function filterDiscoverable(auth, rows, projectOf) {
  if (AUTH_MODE !== "enforce" && !auth?.identity) return rows;
  return rows.filter(row => canDiscover(auth, projectOf(row)));
}
function inboxReadable(auth, msg, session) {
  if (msg.to === session) return !auth?.identity || String(auth.identity.name || "") === String(session || "");
  return canRead(auth, msg.project || "");
}
function canUseInboxSession(auth, session) {
  return !auth?.identity || String(auth.identity.name || "") === String(session || "");
}
const seenNonces = new Map();
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
  state.peers[session] = p; dirty = true;
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
      p._on = false; dirty = true;
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
  if (n > (p.deliveredUpTo || 0)) { p.deliveredUpTo = n; dirty = true; }
}
function pushToStreams(msg) {
  for (const s of streams) if (deliverable(msg, s.session)) { try { s.res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {} }
}
// Live push for the FEED. Sent ONLY to streams that opted in with /stream?events=1, and as a NAMED
// SSE event ("event: ev") so an existing consumer's default onmessage handler — which expects a bus
// message and nothing else — can never see it. Backwards-safe by construction.
function pushEventToStreams(ev) {
  for (const s of streams) if (s.events) { try { s.res.write(`event: ev\ndata: ${JSON.stringify(ev)}\n\n`); } catch {} }
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
  dirty = true;
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

// --- FLOW v2: derive a project's PHASES (the orchestrator-rooted flowchart spine) ---
// Real data is deps-sparse (most cards carry no deps), so we DON'T derive phases from the
// dependency graph. Instead: a card's phase = its title-prefix family (P5a/P5b → "P5",
// CBv2-1/CBfix → "CB", FA-comp1 → "FA", …) when present; otherwise it's clustered with its
// time-neighbours into a "Setup N" round (gap > 8h opens a new round). Phases are ordered by
// first-seen. The orchestrator (host session, "machine:project") vs crew ("brand:project")
// split gives each phase its fan-out actors; the plan/integrate spine nodes are synthetic
// because real per-phase orchestrator cards are rare. `sparse` flags a board that's mostly
// un-prefixed (the UI shows an "inferred phases" notice — never a silent blob).
const PHASE_GAP_MS = 8 * 60 * 60 * 1000;
const agentBrand = (a) => { const s = String(a || ""); const i = s.indexOf(":"); return i > 0 ? s.slice(0, i) : (s || ""); };
// Crew = a known helper-CLI brand; anything else with a brand (a machine hostname like
// "MacBook-Pro-M1.local" or "MacBookPro.hsd1.fl.comcast.net", or a generic "host") is the
// orchestrator. Brand-based (not hostname-pattern) so it's robust to hostname instability.
const CREW_BRANDS = /^(codex|gemini|kimi|deepseek|claude|qwen|grok|glm|mistral|llama)$/i;
const isOrchAssignee = (a) => { const b = agentBrand(a); return !!b && !CREW_BRANDS.test(b); };
function phaseFamily(title) {
  const s = String(title || "").trim();
  // "P5a Structured…", "P4-construction", "P3 Quantity" → P5/P4/P3 (group all P5a/b/c/d together).
  // The trailing letter and the separator must NOT be swallowed by \b (P5a has none between 5 and a).
  let m;
  if ((m = s.match(/^P(\d+)[a-z]?(?:[\s\-:.]|$)/i))) return "P" + m[1];
  if (/^CBv?\d/i.test(s) || /^CBfix/i.test(s) || /^CB[\s\-:.]/i.test(s)) return "CB";
  if (/^FA[\s\-:.\d]/i.test(s)) return "FA";
  if (/^RunCost/i.test(s)) return "RunCost";
  return null;
}
function phaseStatus(counts) {
  if (counts.failed) return "failed";
  if (counts.doing || counts.testing) return "active";
  const total = counts.todo + counts.doing + counts.testing + counts.failed + counts.done + counts.blocked + (counts.stale || 0);
  if (total > 0 && counts.done === total) return "done";
  if (counts.blocked) return "blocked";
  if (counts.todo === total) return "planned";
  return "active";
}
// A human "what is this phase about" line derived from the cards themselves: strip the phase-prefix
// token, take the subject before the first em/en-dash, dedupe, join the first few. Retroactive — no
// captured plan needed. An explicit phase goal (phaseMeta) overrides this in the /phases endpoint.
function phaseTheme(cards) {
  const subs = [];
  const seen = new Set();
  for (const c of cards) {
    let s = String(c.title || "")
      // drop the phase token INCLUDING any sub-index (P3.5, P5a, CBv2-1) + separators, so no "1"/".5" leaks
      .replace(/^\s*(P\d+[a-z]?(?:[.\-]\d+)?|CBv?\d+(?:[.\-]\d+)?|CBfix|FA[-\s:]?\w*|RunCost)[\s:\-–—#]*/i, "")
      .split(/[—–]| - /)[0].trim();                                                    // subject before a dash
    if (!s) continue;
    const k = s.toLowerCase().slice(0, 22);
    if (seen.has(k)) continue;
    seen.add(k); subs.push(s.slice(0, 48));
    if (subs.length >= 3) break;
  }
  return subs.join(" · ").slice(0, 120);
}
function derivePhases(tasks) {
  const sorted = [...tasks].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let miscRound = 0, lastMiscTs = 0;
  for (const t of sorted) {
    // an explicit phase tag (set at plan time) wins; else infer from the title prefix; else time-cluster.
    const explicit = t.phase && String(t.phase).trim();
    const fam = explicit || phaseFamily(t.title);
    if (fam) { t._phase = fam; }
    else {
      if (!lastMiscTs || (t.ts || 0) - lastMiscTs > PHASE_GAP_MS) miscRound++;
      lastMiscTs = t.ts || lastMiscTs;
      t._phase = `Setup ${miscRound}`;
    }
  }
  const byPhase = new Map();
  for (const t of sorted) { if (!byPhase.has(t._phase)) byPhase.set(t._phase, []); byPhase.get(t._phase).push(t); }
  const phases = [...byPhase.entries()].map(([key, cards]) => {
    const counts = { todo:0, doing:0, testing:0, failed:0, done:0, blocked:0, stale:0 };
    for (const c of cards) counts[c.status] = (counts[c.status] || 0) + 1;
    const node = (c) => ({ id: c.id, title: c.title, assignee: c.assignee || "", agent: agentBrand(c.assignee), model: c.model || "", status: c.status, difficulty: c.difficulty || "", ts: c.ts || 0, updated: c.updated || c.ts || 0, deps: Array.isArray(c.deps) ? c.deps : [], costKind: c.costKind || "", costUsd: (typeof c.costUsd === "number") ? c.costUsd : null, source: c.source || "", count: c.count || 1 });
    const crew = cards.filter(c => !isOrchAssignee(c.assignee)).map(node);
    const orchestrators = cards.filter(c => isOrchAssignee(c.assignee)).map(node);
    return {
      key, label: key, theme: phaseTheme(cards),
      start: Math.min(...cards.map(c => c.ts || 0)), end: Math.max(...cards.map(c => c.updated || c.ts || 0)),
      counts, total: cards.length, status: phaseStatus(counts),
      agents: [...new Set(crew.map(c => c.agent).filter(Boolean))],
      crew, orchestrators,
    };
  }).sort((a, b) => a.start - b.start);
  const miscCount = sorted.filter(t => /^Setup /.test(t._phase)).length;
  return { phases, total: sorted.length, sparse: sorted.length > 0 && miscCount / sorted.length > 0.5, derivedBy: "title-prefix + time-cluster" };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); const q = Object.fromEntries(u.searchParams); const P = u.pathname;
  try {
    const b0 = req.method === "POST" ? await body(req) : {};
    if (req.method === "POST" && P === "/enroll") {
      const raw = req._rawBody || "";
      const verified = verifyRequest({ headers: req.headers, method: req.method, path: authPath(u), body: raw });
      if (!verified.ok) return json(res, 401, { error: verified.reason || "bad signature" });
      const existing = findIdentity(verified.pubkey);
      if (existing) return json(res, 200, { ok: true, identity: publicView(existing), scopes: existing.scopes || [] });
      let enrolledBy = "";
      let scopes = [];
      const token = String(b0.token || "");
      // BOOTSTRAP. A fresh REMOTE hub is unusable without this: it binds non-loopback, so it must run
      // RELAY_AUTH=enforce with RELAY_ENROLL=invite — but minting an invite requires an already-enrolled
      // owner, and there is none. Chicken-and-egg, and it locks the operator out of their own server.
      //
      // The escape is a single-use operator secret, and it is safe because it is fenced three ways:
      //   1. RELAY_BOOTSTRAP_TOKEN must be set (it lives in /etc/trantor/pg.env, mode 600, root-owned);
      //   2. the identity store must be EMPTY — one existing identity closes this path permanently;
      //   3. the request is still signature-verified above, so the token alone proves nothing.
      // Compared with timingSafeEqual on equal-length buffers to avoid leaking the token byte-by-byte.
      const bootstrap = String(process.env.RELAY_BOOTSTRAP_TOKEN || "");
      const noIdentitiesYet = Object.keys(state.identities || {}).length === 0;
      const tokenMatchesBootstrap = !!bootstrap && !!token && token.length === bootstrap.length &&
        timingSafeEqual(Buffer.from(token), Buffer.from(bootstrap));
      if (bootstrap && noIdentitiesYet && tokenMatchesBootstrap) {
        // cleanScope takes an OBJECT, not a "project:role" string — a string returns null, the array
        // empties, and defaultScopesFor() silently scopes the first admin to a project guessed from
        // their session name instead of the whole hub. Owner of "*" is what lets them mint invites.
        scopes = [cleanScope({ project: "*", role: "owner" })].filter(Boolean);
        enrolledBy = "bootstrap";
      } else if (token) {
        const invite = state.inviteTokens?.[token];
        if (!invite || invite.used || (invite.expiresAt && invite.expiresAt < now())) return json(res, 403, { error: "invalid invite" });
        scopes = Array.isArray(invite.scopes) ? invite.scopes.map(cleanScope).filter(Boolean) : [];
        invite.used = true; invite.usedAt = now(); invite.pubkey = verified.pubkey; enrolledBy = "invite";
      } else {
        if (!LOOPBACK_BIND || ENROLL_MODE !== "tofu") return json(res, 403, { error: "tofu enrollment refused" });
        enrolledBy = "tofu";
      }
      const identity = {
        name: String(b0.name || "").slice(0, 120) || verified.pubkey.slice(0, 16),
        kind: String(b0.kind || "agent").slice(0, 40),
        pubkey: verified.pubkey,
        createdAt: now(),
        enrolledBy,
        scopes,
      };
      identity.scopes = scopes.length ? scopes : defaultScopesFor(identity, b0);
      state.identities[verified.pubkey] = identity; dirty = true;
      return json(res, 200, { ok: true, identity: publicView(identity), scopes: identity.scopes });
    }
    const auth = PUBLIC_ENDPOINTS.has(P) ? { ok: true, mode: AUTH_MODE, trusted: false } : await authenticate(req, authPath(u));
    // Mint a single-use invite. /enroll has always READ state.inviteTokens, but nothing ever wrote
    // one — bin/cli.mjs shipped a `trantor invite` command against an endpoint that returned 404, so
    // the only way onto a fresh remote hub was the bootstrap token. Owner-gated via OWNER_ENDPOINTS.
    if (req.method === "POST" && P === "/invite") {
      if (!auth.ok) return json(res, auth.code || 401, { error: auth.error || "unauthorized" });
      const az = authorize(auth, req.method, P, "*");
      if (!az.ok) return json(res, az.code || 403, { error: az.error || "forbidden" });
      const bi = await body(req);
      const scopes = (Array.isArray(bi.scopes) ? bi.scopes : []).map(cleanScope).filter(Boolean).slice(0, 20);
      if (!scopes.length) return json(res, 400, { error: "scopes required" });
      // Honour the requested TTL. A 60s FLOOR here silently inflated `ttlSec: 1` to a minute, so a
      // token the caller asked to expire in a second stayed valid — and an expired-token test passed
      // a live token straight through /enroll. Cap the ceiling, never the floor.
      const ttlSec = Math.min(Math.max(Number(bi.ttlSec) || 86400, 1), 30 * 86400);
      const token = randomBytes(24).toString("hex");
      state.inviteTokens[token] = { scopes, expiresAt: now() + ttlSec * 1000, used: false,
        createdBy: auth.identity?.pubkey || "", createdAt: now() };
      dirty = true;
      return json(res, 200, { ok: true, token, scopes, expiresAt: state.inviteTokens[token].expiresAt });
    }
    if (!auth.ok) return json(res, auth.code || 401, { error: auth.error || "unauthorized" });
    const authz = authorize(auth, req.method, P, projectFromRequest(P, q, b0));
    if (!authz.ok) return json(res, authz.code || 403, { error: authz.error || "forbidden" });
    if (req.method === "POST" && P === "/register") {
      const b = await body(req); touch(b.session, b.status, b.project, b.hookVersion, auth);
      // WHO is this, really: the LLM brand + the exact model currently loaded. In-memory like the
      // rest of presence — the next heartbeat re-supplies it after a restart.
      const pr = state.peers[b.session];
      // #6148: WHAT a session is rides its peer row (kind "genesis" = the CLI's brief-poster,
      // "agent" = a crew seat) — /peers hands it to the app so the seat strip can tell them apart.
      if (pr) { if (b.model) pr.model = String(b.model).slice(0, 80); if (b.llm) pr.llm = String(b.llm).slice(0, 40); if (b.kind) pr.kind = String(b.kind).slice(0, 40); }
      return json(res, 200, { ok: true, session: b.session, peers: Object.keys(state.peers) });
    }
    if (req.method === "POST" && P === "/status") { const b = await body(req); touch(b.session, b.status ?? "", b.project, b.hookVersion, auth); return json(res, 200, { ok: true }); }
    // Single-peer lookup, including the read receipt (how far this session's inbox has actually been
    // handed over). Kept out of /peers, which feeds the dashboard and wants presence, not delivery state.
    // Does NOT touch(), so asking about a peer can never make it look alive.
    if (req.method === "GET" && P === "/peer") {
      const p = state.peers[q.session];
      if (!p) return json(res, 404, { error: "unknown peer" });
      if (!canRead(auth, p.project || "")) return json(res, 404, { error: "unknown peer" });
      return json(res, 200, { session: q.session, project: p.project || "", lastSeen: p.lastSeen || 0,
        online: p._on === true, deliveredUpTo: p.deliveredUpTo || 0 });
    }
    // --- Handoff storm guard (server-side, version-independent) ---
    // A session running OLD hooks (before the local markHandedOff guard) re-fires a handoff every few
    // minutes — the crebral-cortex storm: 9 handoffs in 49 min, each spawning a Terminal window. The hub
    // rate-limits per (project, session): a fresh handoff within the cooldown is refused, so an updated
    // client DEFERS the spawn. Manual handoffs (force:true) always pass. GET /handoffs exposes the log.
    if (req.method === "POST" && P === "/handoff") {
      const b = await body(req);
      const proj = canon(String(b.project || "").slice(0, 80));
      const session = String(b.session || "").slice(0, 120);
      if (!proj || !session) return json(res, 400, { error: "project and session required" });
      const cooldownMs = (Number(b.cooldownSec) > 0 ? Number(b.cooldownSec) : 300) * 1000;
      const ts = now();
      const recent = state.handoffLog.filter(h => h.project === proj && h.session === session && (ts - h.ts) < cooldownMs);
      if (!b.force && recent.length) {
        const last = recent[recent.length - 1];
        return json(res, 200, { ok: true, allow: false, reason: "storm-guard", lastTs: last.ts, sinceSec: Math.round((ts - last.ts) / 1000), cooldownSec: cooldownMs / 1000 });
      }
      state.handoffLog.push({ project: proj, session, ts, trigger: String(b.trigger || "").slice(0, 20), id: String(b.id || "").slice(0, 80), forced: !!b.force });
      if (state.handoffLog.length > 500) state.handoffLog.splice(0, state.handoffLog.length - 500);
      dirty = true;
      appendEvent("handoff.written", proj, session, { handoffId: String(b.id || "").slice(0, 80), trigger: String(b.trigger || "").slice(0, 20), forced: !!b.force });
      return json(res, 200, { ok: true, allow: true });
    }
    if (req.method === "GET" && P === "/handoffs") {
      const proj = q.project ? canon(String(q.project).slice(0, 80)) : "";
      const lim = Math.min(200, Number(q.limit) || 50);
      const rows = filterReadable(auth, state.handoffLog.filter(h => !proj || h.project === proj), h => h.project).slice(-lim).reverse();
      return json(res, 200, { handoffs: rows });
    }
    // --- file claims: shared-resource awareness (the "two sessions, one file" problem) ----------
    // A claim says "this session touched this file moments ago". The PreToolUse hook posts one
    // BEFORE every file edit, and the response carries any live claims by OTHER sessions — which
    // the hook hands to the acting session's own model, so an orchestrator learns about a
    // collision before the edit lands, not at git time. Ephemeral BY DESIGN: like presence, a
    // claim describes NOW, and a restart forgetting it is correct, so nothing touches the store.
    // --- project adoption: merge one project's rows brought from ANOTHER hub -------------------
    // The other half of `trantor adopt`: the CLI reads the project's data off the machine-local
    // hub and POSTs it here (owner-signed), so onboarding needs no ssh and no direct Postgres
    // access. Colliding card ids get FRESH ids (both hubs mint from their own taskSeq — the
    // split-brain lesson from the first migration), and their events are re-pointed. Events append
    // with new log ids; messages take the next seq. Idempotence is the CALLER's contract: adopt
    // refuses to run when the project already has cards here, unless forced.
    if (req.method === "POST" && P === "/import") {
      const b = await body(req);
      const proj = canon(String(b.project || "").slice(0, 80));
      if (!proj) return json(res, 400, { error: "project required" });
      const existing = state.tasks.filter(t => t.project === proj).length;
      if (existing && !b.force) return json(res, 409, { error: "project already has cards here", existing });
      const remap = new Map();
      const added = { tasks: 0, events: 0, messages: 0, remapped: 0 };
      const have = new Set(state.tasks.map(t => t.id));
      for (const t of (Array.isArray(b.tasks) ? b.tasks : [])) {
        let id = Number(t.id);
        if (!Number.isFinite(id)) continue;
        if (have.has(id)) { const nid = ++state.taskSeq; remap.set(id, nid); id = nid; added.remapped++; }
        else state.taskSeq = Math.max(state.taskSeq, id);
        state.tasks.push({ ...t, id, project: proj });
        have.add(id); added.tasks++;
      }
      for (const e of (Array.isArray(b.events) ? b.events : [])) {
        const last = state.events[state.events.length - 1];
        // Spread the incoming event FIRST, then stamp OUR id and project over it. The incoming `id`
        // belongs to the other hub's log and must not survive in any form: carried into the payload
        // it comes back on load and overwrites the real row id.
        state.eventSeq = Math.max(Number(state.eventSeq || 0), Number(last?.id) || 0) + 1;
        const ev = { ...e, id: state.eventSeq, project: proj };
        if (ev.taskId != null && remap.has(Number(ev.taskId))) ev.taskId = remap.get(Number(ev.taskId));
        state.events.push(ev); added.events++;
      }
      if (state.events.length > EVENT_CAP) state.events.splice(0, state.events.length - EVENT_CAP);
      for (const m of (Array.isArray(b.messages) ? b.messages : [])) {
        state.messages.push({ ...m, id: ++state.seq, project: proj }); added.messages++;
      }
      if (state.messages.length > 5000) state.messages.splice(0, 1000);
      dirty = true;
      appendEvent("project.adopted", proj, String(b.by || ""), { counts: added });
      return json(res, 200, { ok: true, ...added });
    }
    if (req.method === "GET" && P === "/policy") {
      return json(res, 200, overseerPolicy());
    }
    if (req.method === "POST" && P === "/policy") {
      const b = await body(req);
      const p = state.orgPolicy && typeof state.orgPolicy === "object" ? state.orgPolicy : {};
      p.autonomy = { ...(p.autonomy || {}) };
      p.links = Array.isArray(p.links) ? p.links : [];
      if (b.autonomy && typeof b.autonomy === "object") {
        for (const [proj, lvl] of Object.entries(b.autonomy)) {
          const n = Number(lvl);
          if ([1, 2, 3, 4].includes(n)) p.autonomy[canon(String(proj).slice(0, 80))] = n;
        }
      }
      if (b.link && Array.isArray(b.link.projects) && b.link.projects.length >= 2 && b.link.reason) {
        const projects = b.link.projects.slice(0, 4).map(x => canon(String(x).slice(0, 80))).sort();
        const key = projects.join(" ");
        if (!p.links.some(l => (l.projects || []).slice().sort().join(" ") === key)) {
          p.links.push({ projects, reason: String(b.link.reason).slice(0, 140),
            declaredBy: auth?.identity?.name || String(b.by || ""), ts: now() });
        }
      }
      // Unlink is link's inverse (#5397 shipped the app's Unlink button before this existed —
      // a declared codependency the operator can make, they must also be able to unmake).
      if (b.unlink && Array.isArray(b.unlink.projects) && b.unlink.projects.length >= 2) {
        const key = b.unlink.projects.slice(0, 4).map(x => canon(String(x).slice(0, 80))).sort().join(" ");
        p.links = (p.links || []).filter(l => (l.projects || []).slice().sort().join(" ") !== key);
      }
      state.orgPolicy = p; dirty = true;
      return json(res, 200, { ok: true, ...overseerPolicy() });
    }
    // What a session arriving on <project> needs to know: its autonomy level, who else is live,
    // which files are in flight, which projects are declared codependent, current collisions.
    if (req.method === "GET" && P === "/overseer/status") {
      // The Overseer view's backbone: is the watcher ALIVE, and what is it watching right now.
      // `warnings` is the LIVE detection result from the last tick (pre-dedup), not the event log —
      // the log answers "what did it do", this answers "what does it see".
      const pol = overseerPolicy();
      const cutoff = now() - ONLINE_MS;
      const livePeers = Object.entries(state.peers).filter(([, v]) => v.lastSeen > cutoff);
      pruneClaims();
      return json(res, 200, {
        engine: !!_overseer?.detectCollisions,
        lastTickTs: overseerLastTick,
        tickMs: OVERSEER_TICK_MS,
        clearMs: OVERSEER_CLEAR_MS,
        dutySession: DUTY_SESSION || "",
        watching: {
          sessions: livePeers.length,
          projects: new Set(livePeers.map(([, v]) => v.project).filter(Boolean)).size,
          claims: fileClaims.size,
          links: pol.links.length,
        },
        autonomy: pol.autonomy,
        links: pol.links,
        // `since` turns a detection into a duration — "standing 4h" reads very differently from
        // "just started", and that distinction is the whole point of episode-based warning.
        warnings: overseerLastCollisions.map(c => ({ ...c, since: c.since || 0 })),
        standing: overseerActive.size,
      });
    }
    if (req.method === "GET" && P === "/overseer/context") {
      const proj = canon(String(q.project || "").slice(0, 80));
      if (!proj) return json(res, 400, { error: "project required" });
      const pol = overseerPolicy();
      const level = _overseer?.levelFor ? _overseer.levelFor(proj, pol.autonomy) : (pol.autonomy[proj] ?? pol.autonomy["*"] ?? 1);
      const links = pol.links.filter(l => (l.projects || []).includes(proj));
      const linked = new Set(links.flatMap(l => l.projects).filter(x => x !== proj));
      const cutoff = now() - ONLINE_MS;
      const peersOut = Object.entries(state.peers)
        .filter(([, v]) => v.lastSeen > cutoff && (v.project === proj || linked.has(v.project)))
        .map(([session, v]) => ({ session, project: v.project || "", llm: v.llm || "", model: v.model || "", status: v.status || "" }));
      pruneClaims();
      const inflight = [...fileClaims.values()].filter(c => c.project === proj)
        .map(c => ({ file: c.file, session: c.session, agoSec: Math.round((now() - c.ts) / 1000) }));
      let warnings = [];
      try { warnings = (_overseer?.detectCollisions ? _overseer.detectCollisions(overseerInputs()) : [])
        .filter(c => c.project === proj || linked.has(c.project)); } catch {}
      return json(res, 200, { level, links: links.map(l => ({ projects: l.projects, reason: l.reason })), peers: peersOut, inflight, warnings });
    }
    // Supersession (docs/INSTANCE-KEYS-CONTRACT.md): EXPLICIT, never automatic — the baton-claim
    // path calls this when a fresh session consumes a handoff. Marks every OTHER instance of the
    // named durable identity superseded; their /inbox + /poll answers then carry superseded:true so
    // their own hooks tell the model to stand down. Informational, never a hard block. Accepted
    // only from an endorsed instance of the SAME durable identity, or the owner.
    if (req.method === "POST" && P === "/instance/supersede") {
      const b = await body(req);
      const name = String(b.name || "").slice(0, 200);
      const except = String(b.exceptInstanceId || "").slice(0, 200);
      if (!name) return json(res, 400, { error: "name required" });
      if (AUTH_MODE !== "off") {
        const sameIdentity = auth?.identity && String(auth.identity.name || "") === name;
        const isOwner = auth?.identity?.kind === "human" || scopeAllows(auth?.identity, "", "owner");
        if (!sameIdentity && !isOwner && AUTH_MODE === "enforce") return json(res, 403, { error: "forbidden" });
      }
      let flipped = 0;
      for (const rec of Object.values(state.instances || {})) {
        if (rec.name !== name || rec.superseded) continue;
        if (except && rec.instanceId === except) continue;
        rec.superseded = now(); rec.supersededBy = except || ""; flipped++;
      }
      if (flipped) dirty = true;
      return json(res, 200, { ok: true, superseded: flipped });
    }
    if (req.method === "POST" && P === "/overseer/duty") {
      const b = await body(req);
      if (b.session === undefined) return json(res, 400, { error: "session required (send \"\" to clear the duty seat)" });
      const session = String(b.session).slice(0, 120);
      DUTY_SESSION = session;
      state.dutySession = session;
      dutySeenFloor = Date.now();   // #5686: appointment restarts the dark clock — a newborn is not a corpse
      if (dutyDarkSince) { dutyDarkSince = 0; }   // fresh seat, fresh episode accounting
      dirty = true;
      return json(res, 200, { ok: true, dutySession: DUTY_SESSION });
    }
    if (req.method === "POST" && P === "/overseer/narrate") {
      const b = await body(req);
      const ev = state.events.find(e => e.id === Number(b.eventId) && e.type === "overseer.warn");
      if (!ev) return json(res, 404, { error: "no such overseer.warn event" });
      ev.narrated = true; ev.narration = String(b.text || "").slice(0, 300);
      dirty = true;
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && P === "/claim") {
      const b = await body(req);
      const proj = canon(String(b.project || "").slice(0, 80));
      const file = String(b.file || "").slice(0, 400);
      const session = String(b.session || "").slice(0, 120);
      if (!proj || !file || !session) return json(res, 400, { error: "project, file and session required" });
      pruneClaims();
      const key = `${proj} ${file} ${session}`;
      const mine = fileClaims.get(key);
      const conflicts = [...fileClaims.values()]
        .filter(c => c.project === proj && c.file === file && c.session !== session)
        .map(c => ({ session: c.session, ts: c.ts, agoSec: Math.round((now() - c.ts) / 1000) }));
      fileClaims.set(key, { project: proj, file, session, ts: now() });
      touch(session, undefined, undefined, undefined, auth);
      // Feed events, throttled by design: the FIRST touch inside a TTL window says "claimed";
      // a collision says so every time — that is the one worth seeing on the FEED.
      if (!mine) appendEvent("file.claim", proj, session, { file });
      if (conflicts.length) appendEvent("file.conflict", proj, session, { file, with: conflicts.map(c => c.session) });
      return json(res, 200, { ok: true, conflicts, ttlMs: CLAIM_TTL_MS });
    }
    if (req.method === "GET" && P === "/claims") {
      pruneClaims();
      const proj = q.project ? canon(String(q.project).slice(0, 80)) : "";
      const rows = filterReadable(auth, [...fileClaims.values()].filter(c => !proj || c.project === proj), c => c.project)
        .map(c => ({ ...c, agoSec: Math.round((now() - c.ts) / 1000) }))
        .sort((a, b) => b.ts - a.ts);
      return json(res, 200, { claims: rows });
    }
    if (req.method === "GET" && P === "/peers") {
      prunePeers();
      const cutoff = now() - ONLINE_MS;
      const peerRows = filterDiscoverable(auth, Object.entries(state.peers), ([, v]) => v.project || "");
      return json(res, 200, { hubVersion: HUB_VERSION, authMode: AUTH_MODE, peers: peerRows.map(([s, v]) => ({ session: s, lastSeen: v.lastSeen, online: v.lastSeen > cutoff, status: v.status || "", health: healthOf(v.status), project: v.project || "",
        pubkey: v.pubkey || "", identity: v.identity || null, authWarning: v.authWarning || "",
        kind: v.kind || v.identity?.kind || "", llm: v.llm || "", model: v.model || "", hookVersion: v.hookVersion || "", staleHooks: !!(v.lastSeen > cutoff && v.hookVersion && HUB_VERSION && cmpSemver(v.hookVersion, HUB_VERSION) < 0) })) });
    }
    // --- Provider balances (prepaid credit) ---
    // The hub runs under launchd with no provider keys, so it can't fetch balances itself. Env-having
    // clients (the `trantor balances` CLI, the SessionStart hook) fetch + POST a snapshot here; the hub
    // just caches the last-known snapshot and serves it to the dashboard. Latest writer wins.
    if (req.method === "POST" && P === "/balances") {
      const b = await body(req);
      const entries = Array.isArray(b.balances) ? b.balances.slice(0, 30) : [];
      const ts = (Number.isFinite(b.ts) && b.ts > 0) ? Math.floor(b.ts) : now();
      // only accept a newer snapshot (avoid an older session clobbering a fresh push)
      if (ts >= (state.balances?.ts || 0)) { state.balances = { ts, by: String(b.by || "").slice(0, 120), entries }; dirty = true; }
      return json(res, 200, { ok: true });
    }
    // USAGE v2: the Claude statusline sidechannel. Claude Code >=2.1.80 pipes rate_limits into
    // the statusLine command on every turn; hooks/statusline.mjs forwards it here (floored 15s
    // client-side). The live windows PATCH the cached balances snapshot — free usage between
    // `trantor balances` runs, and the poller can skip Claude while liveTs is fresh (Orca's
    // lesson, docs/RESEARCH-orca-usage.md §1.1: the OAuth endpoint 429s under polling).
    if (req.method === "POST" && P === "/usage/claude") {
      const b = await body(req);
      const win = (w, name) => (w && (w.used_percentage ?? w.utilization) != null)
        ? { name, usedPct: Math.round(Number(w.used_percentage ?? w.utilization)), resetsAt: w.resets_at ?? null } : null;
      const wins = [["fiveHour", "5h"], ["sevenDay", "7d"], ["fable", "Fable"]]
        .map(([k, n]) => win(b[k], n)).filter(Boolean);
      if (!wins.length) return json(res, 400, { error: "no usable windows" });
      state.balances ||= { ts: 0, by: "", entries: [] };
      let e = state.balances.entries.find(x => x.provider === "claude");
      if (!e) { e = { provider: "claude", label: "Claude", kind: "windows", ok: true, windows: [] }; state.balances.entries.push(e); }
      // Same-value posts inside 30s are dropped (the statusline ticks ~3x/sec while streaming).
      const sig = JSON.stringify(wins);
      if (e._liveSig === sig && now() - (e.liveTs || 0) < 30_000) return json(res, 200, { ok: true, deduped: true });
      for (const w of wins) { const cur = (e.windows ||= []).find(x => x.name === w.name); if (cur) Object.assign(cur, w); else e.windows.push(w); }
      e.ok = true; e.liveTs = now(); e._liveSig = sig; e.liveSource = "statusline";
      dirty = true;
      return json(res, 200, { ok: true, windows: wins.length });
    }
    if (req.method === "GET" && P === "/balances") {
      let cfg = {}; try { cfg = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")); } catch {}
      const low = { USD: 5, CNY: 35, EUR: 5, ...(cfg.lowBalance || {}) };
      const lowQuotaPct = typeof cfg.lowQuotaPct === "number" ? cfg.lowQuotaPct : 15;
      const lowOf = e => !e.ok ? false : (e.kind === "quota"
        ? (e.remainingPct != null && e.remainingPct < lowQuotaPct)
        : (e.remaining != null && e.remaining < (low[e.currency] ?? low.USD ?? 5)));
      const ALIAS = { kimi: "moonshot", moonshot: "moonshot", glm: "zhipu", zai: "zhipu", zhipu: "zhipu" };
      const canonP = p => ALIAS[p] || p;
      let prof = {}; try { prof = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "profile.json"), "utf8")).providers || {}; } catch {}
      const profByCanon = {}; for (const [p, v] of Object.entries(prof)) profByCanon[canonP(p)] = v;
      // Server-side profile scoping (defense in depth): only surface providers the user CONFIGURED in
      // their profile — never a stray key a client scraped from the ambient env (a dev's .env may hold
      // OpenRouter/OpenAI/etc. keys for unrelated projects). Filters even a stale/old-client snapshot.
      // If no profile is set, show nothing (better empty than wrong).
      // a prepaid entry that ERRORED but whose provider is a subscription per profile is really a
      // subscription (some plan keys have no balance endpoint → the 401 is expected, not a problem).
      const isSub = (t) => !!t && t !== "api";   // capped-sub / high-sub → a subscription (nothing to refill)
      const entries = (state.balances?.entries || []).filter(e => profByCanon[canonP(e.provider)]).map(e => {
        const pv = profByCanon[canonP(e.provider)];
        if (!e.ok && isSub(pv?.tier)) return { provider: e.provider, label: e.label, kind: "subscription", plan: pv.plan, ok: true, remaining: null, low: false };
        return { ...e, low: lowOf(e) };
      });
      // list EVERY configured subscription provider not already fetched (claude/codex/gemini etc.) so the
      // dashboard shows the full configured crew, not just the ones with a queryable balance/quota.
      const known = new Set(entries.map(e => canonP(e.provider)));
      const subs = Object.entries(prof)
        .filter(([p, v]) => isSub(v?.tier) && !known.has(canonP(p)))
        .map(([p, v]) => ({ provider: p, label: p, kind: "subscription", plan: v.plan, ok: true, remaining: null, low: false }));
      return json(res, 200, { ts: state.balances?.ts || 0, by: state.balances?.by || "", thresholds: low,
        entries: [...entries, ...subs], lowCount: entries.filter(e => e.low).length, stale: (now() - (state.balances?.ts || 0)) > 6 * 3600e3 });
    }
    // Rebuild cc-subagent notional cards for a project from recomputed on-disk transcript costs
    // (`trantor recost`). REPLACES the project's existing cc-subagent cards with the supplied set so the
    // dashboard reflects the real, recoverable notional instead of stale/contaminated values. Each entry
    // is guarded again server-side (implausible → null) so a bad client can't reintroduce inflation.
    if (req.method === "POST" && P === "/subagent-recost") {
      const b = await body(req);
      const incoming = Array.isArray(b.entries) ? b.entries : [];
      // Group by CANONICAL project (so alias lanes — builtbetter→builtbetter.ai, horvath-research→
      // crebral-health — merge instead of clobbering), then by fingerprint within each lane. All in ONE
      // request so the per-lane replace is atomic. Each entry's bad cost is guarded out (counted, not billed).
      const byProj = new Map();
      for (const e of incoming) {
        const proj = canon(String(e.project || "").slice(0, 80)); if (!proj) continue;
        const title = String(e.title || "").slice(0, 200); if (!title) continue;
        if (!byProj.has(proj)) byProj.set(proj, new Map());
        const fpMap = byProj.get(proj); const fp = subFp(title);
        let g = fpMap.get(fp);
        if (!g) { g = { title, costUsd: 0, anyUsd: false, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, count: 0, model: "", ts: 0 }; fpMap.set(fp, g); }
        // guard PER-INVOCATION (entries are rolling sums; a legit 100-invocation card can exceed $50)
        const n = Math.max(1, Number(e.count) || 1);
        const cr = (e.tokens && typeof e.tokens === "object") ? Number(e.tokens.cacheRead) || 0 : 0;
        const implausible = (cr / n) > 50e6 || (typeof e.costUsd === "number" && (e.costUsd / n) > 50);
        g.count += n;
        const ets = Number(e.ts) || 0; if (ets > g.ts) g.ts = ets;
        if (!g.model && e.model) g.model = String(e.model).slice(0, 60);
        if (!implausible) {
          if (typeof e.costUsd === "number") { g.costUsd += e.costUsd; g.anyUsd = true; }
          if (e.tokens && typeof e.tokens === "object") { g.tokens.input += Number(e.tokens.input) || 0; g.tokens.output += Number(e.tokens.output) || 0; g.tokens.cacheWrite += Number(e.tokens.cacheWrite) || 0; g.tokens.cacheRead += Number(e.tokens.cacheRead) || 0; }
        }
      }
      let removedTotal = 0, addedTotal = 0; const results = [];
      for (const [proj, fpMap] of byProj) {
        // only reseed a lane that already exists on the board — never mint a lane for a stray cwd
        const known = state.tasks.some(t => t.project === proj) || !!state.projectMeta?.[proj] || Object.values(state.peers || {}).some(p => p.project === proj);
        if (!known) { results.push({ project: proj, skipped: "unknown-project" }); continue; }
        const removedIds = new Set(state.tasks.filter(t => t.source === "cc-subagent" && t.project === proj).map(t => t.id));
        state.tasks = state.tasks.filter(t => !removedIds.has(t.id));
        if (Array.isArray(state.events)) state.events = state.events.filter(e => !removedIds.has(e.taskId));
        let added = 0, usd = 0;
        for (const [fp, g] of fpMap) {
          const ts0 = (Number.isFinite(g.ts) && g.ts > 0 && g.ts <= now() + 864e5) ? Math.floor(g.ts) : now();
          const t = { id: ++state.taskSeq, project: proj, title: g.title, assignee: `subagent:${proj}`, status: "done",
            phase: "sub-agents", source: "cc-subagent", costKind: "subagent-notional",
            costUsd: g.anyUsd ? +g.costUsd.toFixed(6) : null, costNote: "recomputed from on-disk transcript",
            model: g.model || "", effort: "", tokens: g.anyUsd ? g.tokens : null, difficulty: "", deps: [],
            by: `recost:${proj}`, ts: ts0, updated: ts0, count: g.count, _fp: fp,
            history: [{ to: "done", by: "recost", ts: ts0 }] };
          state.tasks.push(t); added++; usd += g.anyUsd ? g.costUsd : 0;
        }
        removedTotal += removedIds.size; addedTotal += added;
        results.push({ project: proj, removed: removedIds.size, added, usd: +usd.toFixed(2) });
      }
      dirty = true;
      return json(res, 200, { ok: true, removed: removedTotal, added: addedTotal, projects: results });
    }
    // --- Kanban tasks ---
    if (req.method === "POST" && P === "/task") {           // create a card
      const b = await body(req); touch(b.by, undefined, b.project, undefined, auth);
      const st0 = ["todo","doing","testing","failed","done","blocked"].includes(b.status) ? b.status : "todo";
      // optional historical ts (backfill from git/import) — accept a past epoch-ms; else now().
      const ts0 = (Number.isFinite(b.ts) && b.ts > 0 && b.ts <= now() + 864e5) ? Math.floor(b.ts) : now();
      const proj0 = canon(String(b.project || "").slice(0,80));
      // Rolling dedup for auto cost-tracking sub-agent cards (source:"cc-subagent"). Collapse identical
      // invocations into ONE card per (project + normalized title): bump count, accumulate cost + tokens.
      // Keeps full board/economics visibility without the hundreds-of-dupes explosion in the FLOW view.
      if (b.source === "cc-subagent") {
        // Server-side guard (defense in depth): an OLD client hook can mis-resolve a parent transcript and
        // POST a wildly inflated notional cost. Reject implausible cc-subagent costs here. (Real agents top
        // out ~40M cache-read / ~$30 — see the v0.17.37 fix.)
        const cr = (b.tokens && typeof b.tokens === "object") ? Number(b.tokens.cacheRead) || 0 : 0;
        if (cr > 50e6 || (typeof b.costUsd === "number" && b.costUsd > 50)) {
          b.costUsd = null; b.tokens = null; b.costNote = "rejected-implausible-cost (hub guard)";
        }
        // Native SubagentStart/Stop carry agent_id (robust start↔stop pairing key) + parent (nest the sub-
        // agent under the spawning session's focus card). agentType lets an enrich find its create card.
        const agentId = b.agentId ? String(b.agentId).slice(0, 80) : "";
        const parent = b.parent ? String(b.parent).slice(0, 120) : "";
        const atype = b.agentType ? String(b.agentType).slice(0, 40) : "";
        // ENRICH (native SubagentStart): the sub-agent spawned — attach agent_id + parent to the in-flight
        // "doing" card the PreToolUse create already made. Match the newest agent_id-less doing card for this
        // (project, agentType). If none (a spawn with no matching PreToolUse — rare), CREATE one keyed by
        // agent_id so nothing orphans. Idempotent: a repeat enrich for a known agent_id is a no-op.
        if (b.enrich) {
          if (!agentId) return json(res, 200, { ok: true, ignored: "enrich-without-agentId" });
          const already = state.tasks.find(x => x.source === "cc-subagent" && x.project === proj0 && x._aid === agentId);
          if (already) return json(res, 200, { ok: true, task: already, deduped: true, enriched: true });
          const cand = state.tasks
            .filter(x => x.source === "cc-subagent" && x.project === proj0 && !x._aid && x.status === "doing" && (atype ? x._atype === atype : true))
            .sort((a, c) => (c.ts || 0) - (a.ts || 0))[0];
          if (cand) {
            cand._aid = agentId; if (parent && !cand.parent) cand.parent = parent; cand.updated = ts0;
            appendTaskNote(cand, b, ts0);
            dirty = true; return json(res, 200, { ok: true, task: cand, deduped: true, enriched: true });
          }
          const title = String(atype || "subagent").slice(0, 180);
          const t = { id: ++state.taskSeq, project: proj0, title, assignee: `${atype}:${proj0}`,
            status: "doing", phase: "sub-agents", source: "cc-subagent", costKind: "subagent-notional",
            costUsd: null, costNote: "", effort: "", tokens: null, difficulty: "", model: "", deps: [],
            parent: parent || undefined, by: b.by || "", ts: ts0, updated: ts0,
            history: [{ to: "doing", by: b.by || "", ts: ts0 }] };
          t._fp = subFp(title); t._atype = atype; t._aid = agentId; t.count = 1; t._everStarted = true; t._inflight = 1;
          appendTaskNote(t, b, ts0);
          state.tasks.push(t); appendCardEvent("created", t, b.by, null, "doing");
          dirty = true; return json(res, 200, { ok: true, task: t, created: true });
        }
        // A "start" ping (PreToolUse subagent-start.mjs) posts status:"doing" with NO cost/tokens so sub-agent
        // work shows IN PROGRESS while it runs; the SubagentStop "done" post (with cost) flips it.
        const isStart = st0 === "doing" && b.costUsd == null && !b.tokens;
        const fp = subFp(b.title);
        // Pair by agent_id first (robust — survives title differences between start & stop); fall back to the
        // title fingerprint for legacy clients / the PreToolUse-only path that predates agent_id.
        const ex = (agentId && state.tasks.find(x => x.source === "cc-subagent" && x.project === proj0 && x._aid === agentId))
          || state.tasks.find(x => x.source === "cc-subagent" && x.project === proj0 && x._fp === fp);
        if (ex) {
          if (parent && !ex.parent) ex.parent = parent;
          if (agentId && !ex._aid) ex._aid = agentId;
          if (isStart) {
            // another dispatch of the same sub-agent began — count the invocation, mark in-flight, no cost
            ex.count = (ex.count || 1) + 1;
            ex._inflight = (ex._inflight || 0) + 1; ex._everStarted = true;
            if (ex.status === "done") { (ex.history ||= []).push({ from: "done", to: "doing", by: b.by || "", ts: ts0 }); appendCardEvent("moved", ex, b.by, "done", "doing"); }
            ex.status = "doing"; ex.ts = ts0; ex.updated = ts0;
            appendTaskNote(ex, b, ts0);
            dirty = true; return json(res, 200, { ok: true, task: ex, deduped: true, count: ex.count, started: true });
          }
          // a completion (SubagentStop) or recost: accumulate cost, retire one in-flight, flip to done when none remain
          if (typeof b.costUsd === "number" && isFinite(b.costUsd)) ex.costUsd = (ex.costUsd || 0) + b.costUsd;
          if (b.tokens && typeof b.tokens === "object") {
            ex.tokens ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
            ex.tokens.input += Number(b.tokens.input) || 0; ex.tokens.output += Number(b.tokens.output) || 0;
            ex.tokens.cacheWrite += Number(b.tokens.cacheWrite) || 0; ex.tokens.cacheRead += Number(b.tokens.cacheRead) || 0;
          }
          if (b.model && !ex.model) ex.model = String(b.model).slice(0, 60);
          // upgrade a bare agentType-only fallback title with the completion's real (prompt-derived) title
          if (b.title && ex._atype && (ex.title === ex._atype) && subFp(b.title) !== subFp(ex.title)) { ex.title = String(b.title).slice(0, 200); ex._fp = subFp(ex.title); }
          if (ex._everStarted) ex._inflight = Math.max(0, (ex._inflight || 1) - 1);
          else ex.count = (ex.count || 1) + 1;   // legacy path: a stop with no prior start (old sessions) still counts the run
          const wasDoing = ex.status === "doing";
          ex.status = (ex._everStarted && ex._inflight > 0) ? "doing" : "done";
          if (wasDoing && ex.status === "done") { (ex.history ||= []).push({ from: "doing", to: "done", by: b.by || "", ts: ts0 }); appendCardEvent("moved", ex, b.by, "doing", "done"); }
          ex.ts = ts0; ex.updated = ts0;
          appendTaskNote(ex, b, ts0);
          dirty = true; return json(res, 200, { ok: true, task: ex, deduped: true, count: ex.count });
        }
      }
      // Background/child agents (CC Notification hook: agent_needs_input / agent_completed) — the fork/`--agent`/
      // subtask population that never hits the Task-tool sub-agent path. Carded as a DISTINCT source so they
      // never double-count against cc-subagent notional cost. Keyed by agent id to fold needs_input→completed.
      if (b.source === "cc-bg-agent") {
        const bgId = b.agentId ? String(b.agentId).slice(0, 120) : "";
        // never double-card a sub-agent already tracked by SubagentStart/Stop (cc-subagent) — a Notification
        // for the same agent is redundant, so drop it.
        if (bgId && state.tasks.some(x => x.source === "cc-subagent" && x._aid === bgId)) {
          return json(res, 200, { ok: true, ignored: "already-tracked-as-cc-subagent" });
        }
        const nt = String(b.notificationType || "").slice(0, 40);
        const target = nt === "agent_completed" ? "done" : (nt === "agent_needs_input" ? "blocked" : "doing");
        const ex = bgId && state.tasks.find(x => x.source === "cc-bg-agent" && x.project === proj0 && x._aid === bgId);
        if (ex) {
          const from = ex.status; ex.status = target; ex.ts = ts0; ex.updated = ts0;
          if (b.parent && !ex.parent) ex.parent = String(b.parent).slice(0, 120);
          if (b.title && b.title.length > (ex.title || "").length) ex.title = String(b.title).slice(0, 200);
          if (from !== target) { (ex.history ||= []).push({ from, to: target, by: b.by || "", ts: ts0 }); appendCardEvent("moved", ex, b.by, from, target); }
          appendTaskNote(ex, b, ts0);
          dirty = true; return json(res, 200, { ok: true, task: ex, deduped: true });
        }
        const bt = { id: ++state.taskSeq, project: proj0, title: String(b.title || b.agentType || "background agent").slice(0, 200),
          assignee: String(b.assignee || "").slice(0, 60), status: target, phase: "sub-agents",
          source: "cc-bg-agent", costKind: "", costUsd: null, costNote: "", effort: "", tokens: null,
          difficulty: "", model: "", deps: [], parent: b.parent ? String(b.parent).slice(0, 120) : undefined,
          by: b.by || "", ts: ts0, updated: ts0, history: [{ to: target, by: b.by || "", ts: ts0 }] };
        if (bgId) bt._aid = bgId; if (b.agentType) bt._atype = String(b.agentType).slice(0, 40);
        appendTaskNote(bt, b, ts0);
        state.tasks.push(bt); if (state.tasks.length > 2000) state.tasks.splice(0, 500);
        appendCardEvent("created", bt, b.by, null, target);
        dirty = true; return json(res, 200, { ok: true, task: bt, created: true });
      }
      const t = { id: ++state.taskSeq, project: proj0, title: String(b.title||"").slice(0,200),
        assignee: b.assignee || "", status: st0,
        phase: String(b.phase || "").slice(0, 40),   // explicit phase tag (FLOW v2) — wins over title-prefix inference
        source: String(b.source || "").slice(0, 20), // e.g. "git" (backfill), "todo", "cc-subagent" — provenance
        // economics: how this card's cost should be counted. costKind discriminates the source so the
        // dashboard can show notional (plan-covered) vs real spend inline-but-differentiated.
        costKind: String(b.costKind || "").slice(0, 24),         // subagent-notional|orchestrator-notional|crew-subscription|scrooge-real
        costUsd: (typeof b.costUsd === "number" && isFinite(b.costUsd)) ? b.costUsd : null,
        costNote: String(b.costNote || "").slice(0, 80),
        effort: String(b.effort || "").slice(0, 12),
        tokens: (b.tokens && typeof b.tokens === "object") ? {
          input: Number(b.tokens.input) || 0, output: Number(b.tokens.output) || 0,
          cacheWrite: Number(b.tokens.cacheWrite) || 0, cacheRead: Number(b.tokens.cacheRead) || 0,
        } : null,
        difficulty: ["easy","medium","hard"].includes(b.difficulty) ? b.difficulty : "",
        model: String(b.model || "").slice(0, 60),
        deps: Array.isArray(b.deps) ? [...new Set(b.deps.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 20) : [],
        by: b.by || "", ts: ts0, updated: ts0,
        history: [{ to: st0, by: b.by || "", ts: ts0 }] };
      { const cl = cleanChecklist(b.checklist); if (cl?.length) t.checklist = cl; }   // #5624 — rides `extra`, survives restarts
      if (b.source === "cc-subagent") { t._fp = subFp(b.title); if (b.agentType) t._atype = String(b.agentType).slice(0, 40); if (b.agentId) t._aid = String(b.agentId).slice(0, 80); if (b.parent) t.parent = String(b.parent).slice(0, 120); t.count = 1; if (t.status === "doing") { t._everStarted = true; t._inflight = 1; } }
      appendTaskNote(t, b, ts0);
      state.tasks.push(t); if (state.tasks.length > 2000) state.tasks.splice(0, 500);
      appendCardEvent("created", t, b.by, null, st0);
      // A COMMIT closes the focus. A focus card says "this session is working on X right now"; the
      // commit is X arriving, so the card that was rolling forever now completes with the commit
      // attached to it — the board finally shows a finished unit of work instead of an open card
      // whose title keeps changing. The next prompt opens a fresh one.
      if (b.source === "git" && st0 === "done") linkCommitToFocus(t, b.by);
      dirty = true; return json(res, 200, { ok: true, task: t });
    }
    if (req.method === "POST" && P === "/task/update") {    // move/edit a card
      const b = await body(req); const t = state.tasks.find(x => x.id === Number(b.id));
      if (!t) return json(res, 404, { error: "no such task" });
      // Board integrity (#5406): a card can never change hands silently. The assignee is frozen once
      // set; a mutation is legitimate only as a HANDOFF (the current assignee reassigning to someone
      // else) or an EXPLICIT reassign (reassign:true — e.g. the orchestrator re-routing work after a
      // seat dies). A silent third-party overwrite 409s so the caller knows the board refused to move.
      // Runs BEFORE any other field mutation so a refused steal cannot half-apply a status move.
      if (b.assignee !== undefined) {
        const want = String(b.assignee).slice(0, 60);
        if (want !== t.assignee) {
          const mover = String(auth?.identity?.name || b.by || "").slice(0, 120);
          const isOwner = !!t.assignee && mover === t.assignee;
          const explicit = b.reassign === true;
          if (!isOwner && !explicit) {
            return json(res, 409, { error: "assignee is immutable", id: t.id, assignee: t.assignee });
          }
        }
      }
      let eventType = "updated", eventFrom = null, eventTo = null;
      if (b.status && ["todo","doing","testing","failed","done","blocked","stale"].includes(b.status) && b.status !== t.status) {
        eventType = "moved"; eventFrom = t.status; eventTo = b.status;
        (t.history ||= []).push({ from: t.status, to: b.status, by: b.by || "", ts: now() });
        if (t.history.length > 40) t.history.splice(0, 10);
        t.status = b.status;
        // WHO is actually working this card — the SIGNED mover, not the assignee. A card filed by
        // the orchestrator and built by a seat wore the orchestrator's face on every board
        // (2026-08-28, operator caught it: "they all say claude"). The assignee stays intent;
        // workedBy is evidence, stamped only on real work moves and never from a self-asserted by.
        if (["doing","testing","done"].includes(b.status) && auth?.identity?.name) {
          t.workedBy = String(auth.identity.name).slice(0, 120);
        }
      }
      if (b.difficulty && ["easy","medium","hard"].includes(b.difficulty)) t.difficulty = b.difficulty;
      if (b.model !== undefined) t.model = String(b.model).slice(0, 60);
      if (Array.isArray(b.deps)) t.deps = [...new Set(b.deps.map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== t.id))].slice(0, 20);
      if (b.assignee !== undefined && String(b.assignee).slice(0, 60) !== t.assignee) {
        const prev = t.assignee || "(none)";
        const mover = String(auth?.identity?.name || b.by || "").slice(0, 120);
        t.assignee = String(b.assignee).slice(0, 60);
        // the handover is part of the card's story, not a silent overwrite
        appendTaskLog(t, mover, `reassigned ${prev} → ${t.assignee}${b.reassign === true ? " (explicit)" : " (handoff)"}`, now());
      }
      if (b.title !== undefined) t.title = String(b.title).slice(0,200);
      // the narrative line a human reads on the board ("assigned — did"), written by the cheap
      // summarizer; rides the tasks.extra column, so it survives restarts everywhere
      if (b.summary !== undefined) t.summary = String(b.summary).slice(0, 220);
      // #5624: full checklist replace (null clears). Item-level toggles ride /task/checklist-toggle.
      if (b.checklist !== undefined) {
        const cl = cleanChecklist(b.checklist);
        if (cl) { if (cl.length) t.checklist = cl; else delete t.checklist; }
        else if (b.checklist === null) delete t.checklist;
      }
      appendTaskNote(t, b);
      if (b.delete) { eventType = "deleted"; eventFrom = null; eventTo = null; state.tasks = state.tasks.filter(x => x.id !== t.id); }
      appendCardEvent(eventType, t, b.by, eventFrom, eventTo);
      t.updated = now(); dirty = true; return json(res, 200, { ok: true, task: t });
    }
    // #5624: toggle ONE acceptance item. Index-addressed against the card's current checklist —
    // a stale index 400s instead of silently toggling the wrong item.
    if (req.method === "POST" && P === "/task/checklist-toggle") {
      const b = await body(req); const t = state.tasks.find(x => x.id === Number(b.id));
      if (!t) return json(res, 404, { error: "no such task" });
      const i = Number(b.index);
      if (!Array.isArray(t.checklist) || !Number.isInteger(i) || i < 0 || i >= t.checklist.length) {
        return json(res, 400, { error: "no such checklist item" });
      }
      t.checklist[i].done = !!b.done;
      t.updated = now(); dirty = true; return json(res, 200, { ok: true, task: t });
    }
    // Manual board sweep — the aggressive companion to the automatic reaper. The reaper only touches
    // OFFLINE-owner cards (no false positives on live work); /sweep is the explicit "this live seat forgot
    // its card" path: it stales EVERY doing/testing card untouched past `olderMs`, regardless of owner
    // liveness — so it is preview-first (dryRun returns the candidates and changes nothing; the CLI/dashboard
    // confirm before the real move). Optional `project` scopes it to one board.
    if (req.method === "POST" && P === "/sweep") {
      const b = await body(req);
      const project = b.project ? canon(String(b.project).slice(0, 80)) : null;
      const olderMs = Number.isFinite(Number(b.olderMs)) ? Math.max(0, Number(b.olderMs)) : REAP_GRACE_MS;
      const cut = now() - olderMs;
      const cand = state.tasks.filter(t =>
        (t.status === "doing" || t.status === "testing") &&
        (t.updated || t.ts || 0) < cut &&
        (!project || t.project === project));
      const view = cand.map(t => ({ id: t.id, project: t.project, title: t.title, assignee: t.assignee || "",
        status: t.status, source: t.source || "", ageMs: now() - (t.updated || t.ts || 0) }));
      if (b.dryRun) return json(res, 200, { ok: true, dryRun: true, count: view.length, candidates: view });
      for (const t of cand) {
        (t.history ||= []).push({ from: t.status, to: "stale", by: b.by || "sweep", ts: now() });
        if (t.history.length > 60) t.history.splice(0, 20);
        appendCardEvent("moved", t, b.by || "sweep", t.status, "stale");
        t.status = "stale"; t.updated = now(); t._reaped = true;
      }
      if (cand.length) dirty = true;
      return json(res, 200, { ok: true, swept: view.length, candidates: view });
    }
    // Mirror a session's TodoWrite list onto its board as cards, so SOLO work (no crew) shows up live
    // and accrues timeline history. pending/in_progress/completed -> todo/doing/done. Reconciled by
    // todo text per session: present todos create/update; a vanished todo's card is deleted UNLESS it
    // was already done (accomplished work stays in the DONE column). Posted by hooks/todo-sync.mjs.
    if (req.method === "POST" && P === "/todos") {
      const b = await body(req);
      const session = String(b.session || b.by || "").slice(0, 120);
      const project = canon(String(b.project || "").slice(0, 80));
      if (!session || !project) return json(res, 400, { error: "session and project required" });
      touch(session, undefined, project, undefined, auth);
      const ST = { pending: "todo", in_progress: "doing", completed: "done" };
      const todos = Array.isArray(b.todos) ? b.todos : [];
      const mine = state.tasks.filter(t => t.source === "todo" && t.assignee === session && t.project === project);
      const seen = new Set();
      for (const todo of todos) {
        const key = String(todo?.content || "").trim().slice(0, 200);
        if (!key) continue;
        seen.add(key);
        const want = ST[todo.status] || "todo";
        let t = mine.find(c => c.todoKey === key);
        if (!t) {
          t = { id: ++state.taskSeq, project, title: key, assignee: session, status: want, difficulty: "", model: "",
            deps: [], by: session, ts: now(), updated: now(), source: "todo", todoKey: key,
            history: [{ to: want, by: session, ts: now() }] };
          state.tasks.push(t); appendCardEvent("created", t, session, null, want); dirty = true;
        } else if (t.status !== want) {
          (t.history ||= []).push({ from: t.status, to: want, by: session, ts: now() });
          if (t.history.length > 40) t.history.splice(0, 10);
          appendCardEvent("moved", t, session, t.status, want); t.status = want; t.updated = now(); dirty = true;
        }
      }
      for (const t of mine) {
        if (seen.has(t.todoKey) || t.status === "done") continue;   // keep accomplished work on the board
        state.tasks = state.tasks.filter(x => x.id !== t.id); appendCardEvent("deleted", t, session, null, null); dirty = true;
      }
      if (state.tasks.length > 2000) state.tasks.splice(0, state.tasks.length - 2000);
      return json(res, 200, { ok: true, count: todos.length });
    }
    // A REGULAR session's live "focus" card — what THIS session is working on right now, set from each
    // substantive user prompt (hooks/prompt-focus.mjs). ONE rolling "doing" card per session (re-titled as
    // the focus shifts, with a history trail); closed to "done" when the session is pruned offline. This is
    // the bridge that makes a non-crew session's OWN work show IN PROGRESS live, not just at commit time.
    if (req.method === "POST" && P === "/focus") {
      const b = await body(req);
      const session = String(b.session || b.by || "").slice(0, 120);
      const project = canon(String(b.project || "").slice(0, 80));
      const title = String(b.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
      // `cc` = the Claude Code session UUID (hooks/prompt-focus.mjs passes session_id). It is the
      // ONLY per-session key on the board: `assignee` is a bus id, which is per host+project, so
      // two Claude sessions in one project used to fight over a single rolling card — and every
      // sub-agent card, whose `parent` is that same UUID, had nothing to join to (measured over
      // 431 live cards, joining on the bus id resolved 0 of them). With `cc` stored here, a
      // sub-agent nests under the session that actually spawned it.
      const cc = String(b.cc || "").slice(0, 120);
      if (!session || !project || !title) return json(res, 400, { error: "session, project, title required" });
      touch(session, undefined, project, undefined, auth);
      // Match on cc when the client sends one — but never let a cc-bearing prompt adopt a card
      // from a DIFFERENT session. A client too old to send cc keeps the original assignee match.
      let t = cc
        ? state.tasks.find(x => x.source === "session" && x.cc === cc && canon(x.project) === project && x.status !== "done")
          || state.tasks.find(x => x.source === "session" && !x.cc && x.assignee === session && canon(x.project) === project && x.status !== "done")
        : state.tasks.find(x => x.source === "session" && x.assignee === session && canon(x.project) === project && x.status !== "done");
      if (t) {
        if (t.title !== title) {            // refocus: re-title in place + record the shift (keeps the trail)
          (t.history ||= []).push({ from: t.status, to: t.status, by: session, ts: now(), note: title.slice(0, 90) });
          if (t.history.length > 60) t.history.splice(0, 20);
          // A rolling card's narrative describes the OLD focus. The board renders `summary ||
          // title`, so leaving it would let a stale one-liner shadow what the session is doing
          // right now — the summarizer (or bin/focus-title.mjs) writes a fresh one.
          if (t.summary) t.summary = "";
          t.title = title; appendCardEvent("updated", t, session, null, null);
          appendEvent("focus", project, session, { taskId: t.id, title, shift: true });
        }
        if (cc && !t.cc) t.cc = cc;          // an in-flight card from an older client gets its key
        t.status = "doing"; t.updated = now();
      } else {
        t = { id: ++state.taskSeq, project, title, assignee: session, status: "doing", source: "session",
          difficulty: "", model: "", deps: [], by: session, ts: now(), updated: now(),
          cc: cc || undefined,
          history: [{ to: "doing", by: session, ts: now() }] };
        state.tasks.push(t); appendCardEvent("created", t, session, null, "doing");
        appendEvent("focus", project, session, { taskId: t.id, title, shift: false });
        if (state.tasks.length > 2000) state.tasks.splice(0, state.tasks.length - 2000);
      }
      dirty = true; return json(res, 200, { ok: true, id: t.id, task: t });
    }
    if (req.method === "GET" && P === "/focus") {     // the session's open focus card (for sub-agent nesting)
      const session = String(q.session || "");
      const cc = String(q.cc || "");
      // ?cc= is the precise lookup (one Claude session); ?session= stays the coarse one.
      const t = cc
        ? state.tasks.find(x => x.source === "session" && x.cc === cc && x.status !== "done")
        : state.tasks.find(x => x.source === "session" && x.assignee === session && x.status !== "done");
      if (t && !canRead(auth, t.project || "")) return json(res, 404, { id: null, task: null });
      return json(res, 200, { id: t ? t.id : null, task: t || null });
    }
    if (req.method === "GET" && P === "/tasks") {
      const proj = q.project ? canon(q.project) : ""; const ts = filterReadable(auth, proj ? state.tasks.filter(t => canon(t.project) === proj) : state.tasks, t => t.project || "");
      return json(res, 200, { tasks: ts });
    }
    if (req.method === "GET" && P === "/history") {
      const requestedLimit = Number(q.limit || 200);
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 200, 0), 1000);
      const proj = q.project ? canon(q.project) : "";
      // CARD events only — /history is the TIMELINE's feed and predates the unified log, so it must
      // keep returning exactly what it always did. Everything else lives behind /events.
      const all = state.events.filter(isCardEvent);
      const events = filterReadable(auth, proj ? all.filter(e => canon(e.project) === proj) : all, e => e.project || "").slice(-limit);
      return json(res, 200, { events });
    }
    // The unified log — the FEED's feed. Filters compose (AND): project, type (comma list; a
    // trailing "." is a prefix match, e.g. type=presence.), by (actor), taskId (card thread),
    // since (event id, for incremental polling). Newest-last, like /history.
    if (req.method === "GET" && P === "/events") {
      const requestedLimit = Number(q.limit || 300);
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 300, 0), 2000);
      const proj = q.project ? canon(q.project) : "";
      const since = Number(q.since || 0);
      const taskId = q.taskId ? Number(q.taskId) : null;
      const wants = String(q.type || "").split(",").map(s => s.trim()).filter(Boolean);
      const typeOk = (t) => !wants.length || wants.some(w => w.endsWith(".") ? String(t).startsWith(w) : t === w);
      let out = filterReadable(auth, state.events, e => e.project || "").filter(e =>
        (!proj || canon(e.project) === proj) &&
        (!since || e.id > since) &&
        (taskId == null || e.taskId === taskId || (Array.isArray(e.refs) && e.refs.includes(taskId))) &&
        (!q.by || e.by === q.by) &&
        typeOk(e.type));
      out = out.slice(-limit);
      return json(res, 200, { events: out, cursor: out.length ? out[out.length - 1].id : since,
        latest: state.events.length ? state.events[state.events.length - 1].id : 0 });
    }
    // A single card's FULL story for the detail panel: the card itself, its status events, and the
    // bus messages that reference it (#<id>) — i.e. the agent's own reports of what it did, why, how.
    if (req.method === "GET" && P === "/card") {
      const id = Number(q.id);
      if (!Number.isInteger(id)) return json(res, 400, { error: "numeric id required" });
      const task = state.tasks.find(t => t.id === id) || null;
      if (task && !canRead(auth, task.project || "")) return json(res, 404, { task: null, events: [], messages: [] });
      const events = filterReadable(auth, state.events.filter(e => e.taskId === id), e => e.project || "");
      const re = new RegExp("#" + id + "(?![0-9])");   // #5 but not #50
      const messages = filterReadable(auth, state.messages.filter(m => re.test(String(m.text || ""))), m => m.project || "").slice(-200);
      // fall back to the last event for title/project/assignee when the card was deleted
      const last = events[events.length - 1];
      const meta = task || (last ? { id, title: last.title, project: last.project, status: "deleted", assignee: last.assignee, difficulty: last.difficulty } : null);
      return json(res, 200, { task: meta, events, messages });
    }
    if (req.method === "POST" && P === "/project") {        // set a project's brief (what & why)
      const b = await body(req); const k = canon(String(b.project || "").slice(0, 80));
      if (!k) return json(res, 400, { error: "project required" });
      const m = state.projectMeta[k] || {};
      if (b.brief !== undefined) m.brief = String(b.brief).slice(0, 600);
      m.by = b.by || m.by || ""; m.updated = now();
      state.projectMeta[k] = m; dirty = true;
      return json(res, 200, { ok: true, project: k, brief: m.brief || "" });
    }
    if (req.method === "POST" && P === "/project/delete") { // forget a project: its cards, peers, brief, and lane
      const b = await body(req); const k = String(b.project || "").slice(0, 80);
      if (!k) return json(res, 400, { error: "project required" });
      const nt = state.tasks.length, np = Object.keys(state.peers).length, nm = state.messages.length;
      state.tasks = state.tasks.filter(t => t.project !== k);
      for (const [s, v] of Object.entries(state.peers)) if (v.project === k) delete state.peers[s];
      delete state.projectMeta[k];
      state.messages = state.messages.filter(m2 => (m2.project || "") !== k);
      // Forget its log too, or the FEED would keep replaying a project the board no longer shows.
      const ne = state.events.length;
      state.events = state.events.filter(e => (e.project || "") !== k);
      dirty = true;   // the project reappears cleanly if an agent ever registers it again
      return json(res, 200, { ok: true, project: k, removed: { tasks: nt - state.tasks.length, peers: np - Object.keys(state.peers).length, messages: nm - state.messages.length, events: ne - state.events.length } });
    }
    // Fold one project lane into another: rewrite all stored project fields from→to AND
    // record an alias so future writes under `from` canonicalize to `to`. Idempotent.
    // This is how a fragmented project (one repo, two lane keys) becomes one continuous lane.
    if (req.method === "POST" && P === "/project/merge") {
      const b = await body(req);
      const from = String(b.from || "").slice(0, 80), to = String(b.to || "").slice(0, 80);
      if (!from || !to || from === to) return json(res, 400, { error: "distinct from+to required" });
      let cards = 0, events = 0, peers = 0, msgs = 0;
      for (const t of state.tasks) if (t.project === from) { t.project = to; cards++; }
      for (const e of state.events) if (e.project === from) { e.project = to; events++; }
      for (const v of Object.values(state.peers)) if (v.project === from) { v.project = to; peers++; }
      for (const m of state.messages) if ((m.project || "") === from) { m.project = to; msgs++; }
      if (state.projectMeta[from]) {
        if (!state.projectMeta[to]) state.projectMeta[to] = state.projectMeta[from];
        else if (!state.projectMeta[to].brief && state.projectMeta[from].brief) state.projectMeta[to].brief = state.projectMeta[from].brief;
        delete state.projectMeta[from];
      }
      state.aliases[from] = to;                       // future writes fold automatically
      for (const [k, v] of Object.entries(state.aliases)) if (v === from) state.aliases[k] = to; // re-point chains
      dirty = true;
      return json(res, 200, { ok: true, from, to, moved: { cards, events, peers, messages: msgs } });
    }
    // Catch-up snapshot: everything a NEW session needs to resume a project's continuous
    // lane — the brief, card counts, what's in-flight (doing/testing/todo) and the most
    // recent done work, plus last activity. Cheap + LLM-free; the SessionStart hook injects it.
    if (req.method === "GET" && P === "/catchup") {
      const proj = canon(q.project || "");
      if (!proj) return json(res, 400, { error: "project required" });
      if (!canRead(auth, proj)) return json(res, 403, { error: "forbidden" });
      const mine = state.tasks.filter(t => canon(t.project) === proj);
      const counts = { todo:0, doing:0, testing:0, failed:0, done:0, blocked:0, stale:0 };
      for (const t of mine) counts[t.status] = (counts[t.status] || 0) + 1;
      const pick = (st, n) => mine.filter(t => t.status === st).sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0, n)
        .map(t => ({ id: t.id, title: t.title, assignee: t.assignee || "", updated: t.updated || 0, source: t.source || "" }));
      const lastActivity = mine.reduce((mx,t)=>Math.max(mx, t.updated||0), state.projectMeta[proj]?.updated || 0);
      return json(res, 200, {
        project: proj, brief: state.projectMeta[proj]?.brief || "",
        counts, total: mine.length,
        doing: pick("doing", 8), testing: pick("testing", 8), failed: pick("failed", 8),
        blocked: pick("blocked", 8), todo: pick("todo", 10), recentDone: pick("done", 8),
        lastActivity,
      });
    }
    // FLOW v2: the orchestrator-rooted phase flowchart. Returns the project's cards grouped into
    // ordered phases (title-prefix + time-cluster), each with its crew fan-out + orchestrator nodes.
    if (req.method === "GET" && P === "/phases") {
      const proj = canon(q.project || "");
      if (!proj) return json(res, 400, { error: "project required" });
      if (!canRead(auth, proj)) return json(res, 403, { error: "forbidden" });
      const mine = state.tasks.filter(t => canon(t.project) === proj);
      const out = derivePhases(mine);
      for (const p of out.phases) p.goal = state.phaseMeta[`${proj}::${p.key}`]?.goal || "";   // explicit goal overrides the derived theme
      return json(res, 200, { project: proj, brief: state.projectMeta[proj]?.brief || "", ...out });
    }
    // Set a phase's explicit GOAL — what this phase needs to do (the orchestrator captures this at plan
    // time, like a per-phase brief). Surfaces in the FLOW v2 header in place of the derived theme.
    if (req.method === "POST" && P === "/phase") {
      const b = await body(req);
      const proj = canon(String(b.project || "").slice(0, 80)), phase = String(b.phase || "").slice(0, 40);
      if (!proj || !phase) return json(res, 400, { error: "project + phase required" });
      const k = `${proj}::${phase}`; const m = state.phaseMeta[k] || {};
      if (b.goal !== undefined) m.goal = String(b.goal).slice(0, 400);
      m.by = b.by || m.by || ""; m.updated = now();
      state.phaseMeta[k] = m; dirty = true;
      return json(res, 200, { ok: true, project: proj, phase, goal: m.goal || "" });
    }
    if (req.method === "GET" && P === "/projects") {        // project-grouped view
      prunePeers();
      const cutoff = now() - ONLINE_MS; const byProj = {};
      const proj = p => canon(p) || "(unassigned)";
      const mk = k => (byProj[k] ||= { project: k, brief: (state.projectMeta[k]?.brief) || "", agents: [], tasks: { todo:0,doing:0,testing:0,failed:0,done:0,blocked:0 }, doingTitles: [], lastActivity: 0 });
      for (const [s, v] of filterReadable(auth, Object.entries(state.peers), ([, v]) => v.project || "")) {
        const k = proj(v.project); const e = mk(k); e.agents.push({ session: s, online: v.lastSeen > cutoff, status: v.status || "", health: healthOf(v.status),
          llm: v.llm || "", model: v.model || "", hookVersion: v.hookVersion || "", staleHooks: !!(v.lastSeen > cutoff && v.hookVersion && HUB_VERSION && cmpSemver(v.hookVersion, HUB_VERSION) < 0) });
        if ((v.lastSeen || 0) > e.lastActivity) e.lastActivity = v.lastSeen;
      }
      for (const t of filterReadable(auth, state.tasks, t => t.project || "")) { const e = mk(proj(t.project)); e.tasks[t.status] = (e.tasks[t.status]||0)+1; if (t.status === "doing") e.doingTitles.push(t.title); if ((t.updated || 0) > e.lastActivity) e.lastActivity = t.updated; }
      // derive a one-line phase ("where it is in the process") from the board
      for (const e of Object.values(byProj)) {
        const mu = state.projectMeta[e.project]?.updated || 0; if (mu > e.lastActivity) e.lastActivity = mu;
        e.idle = !e.agents.some(a => a.online);
        const { todo, doing, testing=0, failed=0, done, blocked } = e.tasks; const total = todo+doing+testing+failed+done+blocked;
        e.phase = total === 0 ? "no cards yet"
          : failed > 0 ? `${failed} FAILED — fixing`
          : blocked > 0 ? `blocked on ${blocked} card${blocked>1?"s":""}`
          : testing > 0 ? `verifying: ${testing} in test`
          : doing > 0 ? `building: ${e.doingTitles.slice(0,2).join(", ")}${e.doingTitles.length>2?"…":""}`
          : done === total ? "shipped — all cards done"
          : todo > 0 ? `planned: ${todo} card${todo>1?"s":""} queued`
          : "in progress";
        // dead board: no live agents -> the phase above is stale, say so honestly
        if (e.idle) e.phase = `idle · last activity ${e.lastActivity ? fmtAge(now() - e.lastActivity) : "unknown"}`;
      }
      return json(res, 200, { projects: Object.values(byProj) });
    }
    // --- lessons: cross-agent learning from failures. scope = "global" or an agent brand ("kimi") ---
    if (req.method === "POST" && P === "/lesson") {
      const b = await body(req);
      const text = String(b.text || "").trim().slice(0, 400);
      const scope = String(b.scope || "global").toLowerCase().slice(0, 40);
      if (!text) return json(res, 400, { error: "text required" });
      if (state.lessons.some(l => l.scope === scope && l.text === text)) return json(res, 200, { ok: true, dedup: true });
      state.lessons.push({ id: state.lessons.length + 1, scope, text, by: b.by || "", ts: now() });
      if (state.lessons.length > 500) state.lessons.splice(0, 100);
      dirty = true;
      // Attribute to a PROJECT the same way /send does — never to `scope`, which is lowercased and
      // isn't a project name at all ("global", a topic tag, …). Explicit project wins, then the
      // author's known project, then the "host:project" suffix.
      const lProj = canon(String(b.project || state.peers[b.by]?.project || (b.by && b.by.includes(":") ? b.by.split(":").pop() : "")).slice(0, 80));
      appendEvent("lesson", lProj, b.by || "", { text, scope });
      return json(res, 200, { ok: true, count: state.lessons.length });
    }
    // --- verification gates: structured "must verify before shipping" claims that travel with
    // handoffs and surface PROMINENTLY to whoever takes over (so a safety-critical check can't be
    // skimmed past in narrative prose — the "verify Gail coefficients" intent that got lost). ---
    if (req.method === "POST" && P === "/verify-gate") {
      const b = await body(req); touch(b.by, undefined, b.project, undefined, auth);
      const project = canon(String(b.project || "").slice(0, 80));
      if (b.resolve) {
        const g = state.verifyGates.find(x => x.id === Number(b.id) && x.project === project);
        if (!g) return json(res, 404, { error: "gate not found" });
        g.status = ["verified", "failed", "waived"].includes(b.status) ? b.status : "verified";
        g.resolvedBy = b.by || ""; g.resolvedNote = String(b.note || "").slice(0, 300); g.resolvedTs = now();
        dirty = true;
        appendEvent("verify.gate.resolved", project, b.by || "", { gateId: g.id, claim: g.claim, status: g.status, note: g.resolvedNote });
        return json(res, 200, { ok: true, gate: g });
      }
      const claim = String(b.claim || "").trim().slice(0, 300);
      if (!claim) return json(res, 400, { error: "claim required" });
      const dup = state.verifyGates.find(x => x.project === project && x.claim === claim && x.status === "open");
      if (dup) return json(res, 200, { ok: true, gate: dup, dedup: true });
      const g = { id: ++state.verifyGateSeq, project, claim, why: String(b.why || "").slice(0, 300),
        howToVerify: String(b.howToVerify || "").slice(0, 300), status: "open", by: b.by || "", ts: now() };
      state.verifyGates.push(g); if (state.verifyGates.length > 500) state.verifyGates.splice(0, 100);
      dirty = true;
      appendEvent("verify.gate.opened", project, b.by || "", { gateId: g.id, claim: g.claim, why: g.why, howToVerify: g.howToVerify });
      return json(res, 200, { ok: true, gate: g });
    }
    if (req.method === "GET" && P === "/verify-gates") {
      const project = canon(String(q.project || ""));
      let gates = filterReadable(auth, state.verifyGates.filter(g => !project || g.project === project), g => g.project || "");
      if (q.all !== "1") gates = gates.filter(g => g.status === "open");
      return json(res, 200, { gates });
    }
    // --- agent-proposed permissions (governance): the autonomy ladder made two-directional ---
    // The operator sets levels top-down (`trantor policy`); this is the bottom-up half — an agent
    // that needs more rope FILES A PROPOSAL instead of assuming, working around, or DM'ing the
    // human free-form. Three rules, all Argus-derived and all enforced HERE, not by convention:
    //   1. A proposal must state its BOUND — scope (what), condition (when), exclusions (what is
    //      still NOT covered). A permission without a bound is a blank cheque, so an unbounded
    //      proposal is a 400, not a pending row.
    //   2. The queue is CAPPED per session (default 3 pending). To file past the cap the agent
    //      must withdraw one of its own — a full queue is a prioritization exercise, not a bug.
    //   3. Denials are REMEMBERED. A near-duplicate of a denied proposal (normalized scope +
    //      condition, same project) is refused with the operator's original note, so "ask again
    //      until the human gives in" is structurally impossible.
    // Deciding is the HUMAN's act alone: /proposal/decide is owner-gated (OWNER_ENDPOINTS) and
    // nothing hub-side ever flips a proposal to approved. Approval grants nothing mechanical
    // today — it is a recorded operator decision the agent may rely on, like a mission note line.
    if (req.method === "POST" && P === "/propose") {
      const b = await body(req);
      const session = String(b.session || b.by || "").slice(0, 120);
      if (!session) return json(res, 400, { error: "session required" });
      if (auth?.identity && String(session) !== String(auth.identity.name || "")) return json(res, 403, { error: "session must match signer" });
      const proj = canon(String(b.project || state.peers[session]?.project || (session.includes(":") ? session.split(":").pop() : "")).slice(0, 80));
      const scope = String(b.scope || "").trim().slice(0, 300);
      const condition = String(b.condition || "").trim().slice(0, 300);
      const exclusions = String(b.exclusions || "").trim().slice(0, 300);
      if (!scope || !condition || !exclusions) {
        return json(res, 400, { error: "a proposal must state its bound: scope (what), condition (when), exclusions (what is still NOT covered) — a permission without a bound is a blank cheque" });
      }
      // optional machine-readable capability key ("patrol.reap-orphans") — lets a TOOL check a
      // grant exactly instead of text-matching prose. Never part of the denial fingerprint.
      const key = String(b.key || "").trim().toLowerCase().slice(0, 60);
      if (key && !/^[a-z0-9][a-z0-9._-]*$/.test(key)) return json(res, 400, { error: "key must be a slug: [a-z0-9._-]" });
      const fp = propFp(scope, condition);
      const denied = state.proposals.find(p => p.status === "denied" && p.project === proj && propFp(p.scope, p.condition) === fp);
      if (denied) {
        return json(res, 409, { error: "near-duplicate of a DENIED proposal — do not re-propose; refine the bound or move on",
          deniedId: denied.id, note: denied.note || "", decidedTs: denied.decidedTs || 0 });
      }
      const pending = state.proposals.filter(p => p.status === "pending" && p.session === session);
      const dup = pending.find(p => p.project === proj && propFp(p.scope, p.condition) === fp);
      if (dup) return json(res, 200, { ok: true, proposal: dup, dedup: true });
      if (pending.length >= PROPOSAL_CAP) {
        return json(res, 409, { error: `queue full: ${pending.length}/${PROPOSAL_CAP} pending for this session — withdraw one of yours to file another`,
          pending: pending.map(p => ({ id: p.id, scope: p.scope })) });
      }
      touch(session, undefined, proj, undefined, auth);
      const pr = { id: ++state.proposalSeq, session, project: proj, scope, condition, exclusions, key,
        status: "pending", ts: now(), decidedTs: 0, decidedBy: "", note: "" };
      state.proposals.push(pr); if (state.proposals.length > 500) state.proposals.splice(0, 100);
      dirty = true;
      appendEvent("proposal.filed", proj, session, { proposalId: pr.id, scope, condition, exclusions, ...(key ? { key } : {}) });
      return json(res, 200, { ok: true, proposal: pr });
    }
    if (req.method === "POST" && P === "/proposal/decide") {
      const b = await body(req);
      const pr = state.proposals.find(p => p.id === Number(b.id));
      if (!pr) return json(res, 404, { error: "no such proposal" });
      // A grant that GATES tool behavior needs an off-switch: the operator may REVOKE an
      // approved proposal. Revocation is not a denial — it leaves no denial memory, so the
      // agent may re-propose a refined bound later.
      if (b.status === "revoked") {
        if (pr.status !== "approved") return json(res, 409, { error: `only an approved proposal can be revoked (is ${pr.status})`, proposal: pr });
      } else if (pr.status !== "pending") return json(res, 409, { error: `already ${pr.status}`, proposal: pr });
      const decision = ["approved", "denied", "revoked"].includes(b.status) ? b.status : "";
      if (!decision) return json(res, 400, { error: "status must be 'approved', 'denied' or 'revoked'" });
      pr.status = decision; pr.decidedTs = now();
      pr.decidedBy = String(auth?.identity?.name || b.by || "").slice(0, 120);
      pr.note = String(b.note || "").slice(0, 300);
      dirty = true;
      appendEvent("proposal.decided", pr.project, pr.decidedBy, { proposalId: pr.id, scope: pr.scope, status: decision, note: pr.note });
      // Tell the proposer directly — a decision it never hears about is a decision it will act
      // around. One DM per decision (a transition, never a repeat), hub-authored like escalations.
      hubSend(pr.session,
        `📜 proposal #${pr.id} ${decision.toUpperCase()}${pr.note ? `: ${pr.note}` : ""} — scope was "${pr.scope}". ${decision === "approved" ? "You may rely on it within its stated bound." : decision === "revoked" ? "This grant no longer applies — stop relying on it. You may propose a refined bound." : "Do not re-propose this; refine the bound or move on."}`,
        pr.project);
      return json(res, 200, { ok: true, proposal: pr });
    }
    if (req.method === "POST" && P === "/proposal/withdraw") {
      const b = await body(req);
      const pr = state.proposals.find(p => p.id === Number(b.id));
      if (!pr) return json(res, 404, { error: "no such proposal" });
      if (pr.status !== "pending") return json(res, 409, { error: `already ${pr.status}`, proposal: pr });
      // own proposals only — a signed request must BE the proposer; unsigned (warn/off) must claim it
      const claimant = String(auth?.identity?.name || b.session || b.by || "").slice(0, 120);
      if (claimant !== pr.session) return json(res, 403, { error: "only the proposing session may withdraw" });
      pr.status = "withdrawn"; pr.decidedTs = now(); pr.decidedBy = pr.session;
      dirty = true;
      appendEvent("proposal.withdrawn", pr.project, pr.session, { proposalId: pr.id, scope: pr.scope });
      return json(res, 200, { ok: true, proposal: pr });
    }
    if (req.method === "GET" && P === "/proposals") {
      const proj = q.project ? canon(String(q.project).slice(0, 80)) : "";
      const rows = filterReadable(auth, state.proposals.filter(p =>
        (!proj || p.project === proj) &&
        (!q.status || p.status === q.status) &&
        (!q.session || p.session === q.session)), p => p.project || "").slice(-200);
      const pendingCount = filterReadable(auth, state.proposals.filter(p => p.status === "pending"), p => p.project || "").length;
      return json(res, 200, { proposals: rows, pendingCount });
    }
    // GRANTS = the mechanical face of approvals: the ACTIVE approved proposals, queryable by the
    // tools and sessions that must honor them. Same rows as /proposals?status=approved, but this
    // is the contract surface — a grant listed here may be relied on within its stated bound;
    // revocation removes it here first.
    if (req.method === "GET" && P === "/grants") {
      const proj = q.project ? canon(String(q.project).slice(0, 80)) : "";
      const rows = filterReadable(auth, state.proposals.filter(p =>
        p.status === "approved" &&
        (!proj || p.project === proj) &&
        (!q.key || (p.key || "") === String(q.key).toLowerCase()) &&
        (!q.session || p.session === q.session)), p => p.project || "").slice(-200);
      return json(res, 200, { grants: rows.map(p => ({ id: p.id, session: p.session, project: p.project,
        scope: p.scope, condition: p.condition, exclusions: p.exclusions, key: p.key || "",
        decidedBy: p.decidedBy, decidedTs: p.decidedTs, note: p.note || "" })) });
    }
    if (req.method === "GET" && P === "/economics") {   // the brain's books, surfaced: scrooge ledger + quota profile
      const out = { scrooge: null, lifetime: null, profile: null };
      try { out.profile = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "profile.json"), "utf8")).providers || {}; } catch {}
      try {
        const ledger = join(homedir(), ".token-scrooge", "calls.jsonl");
        const st = statSync(ledger);
        if (st.mtimeMs !== _ledgerCache.mtimeMs) {   // ledger changed → reparse the whole file once
          const rows = readFileSync(ledger, "utf8").trim().split("\n")
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(c => c && c.ok);
          _ledgerCache = { mtimeMs: st.mtimeMs, rows };
        }
        const rows = _ledgerCache.rows;
        // Roll up a set of calls into spend + the frontier-model yardstick (~$15/M in, $75/M out,
        // same reference scrooge's own ledger uses) and the resulting savings.
        const rollup = calls => {
          const s = { calls: calls.length, tokens_in: 0, tokens_out: 0, cost_usd: 0, by_model: {} };
          for (const c of calls) {
            s.tokens_in += c.tokens_in || 0; s.tokens_out += c.tokens_out || 0; s.cost_usd += c.cost_usd || 0;
            const m = s.by_model[c.model] ||= { calls: 0, cost_usd: 0 };
            m.calls++; m.cost_usd += c.cost_usd || 0;
          }
          s.opus_equiv_usd = +(s.tokens_in * 15 / 1e6 + s.tokens_out * 75 / 1e6).toFixed(2);
          s.cost_usd = +s.cost_usd.toFixed(4);
          s.saved_usd = +Math.max(0, s.opus_equiv_usd - s.cost_usd).toFixed(2);
          return s;
        };
        // Named rolling windows the dashboard dropdown offers, all served in one response so
        // switching the selector is instant (no refetch) — cheap because the rows are cached.
        const nowS = now() / 1000;
        const WINDOWS = { "24h": 24, "week": 168, "month": 720, "quarter": 2160, "year": 8760 };
        out.windows = {};
        for (const [k, hrs] of Object.entries(WINDOWS)) out.windows[k] = rollup(rows.filter(c => c.ts >= nowS - hrs * 3600));
        out.lifetime = rollup(rows);                             // all-time running total
        out.lifetime.since_ts = rows.length ? rows[0].ts : null; // first ledgered call
        out.windows.lifetime = out.lifetime;
        // back-compat: `scrooge` is the window older dashboards read (honor ?hours= if passed)
        out.scrooge = q.hours ? rollup(rows.filter(c => c.ts >= nowS - Number(q.hours) * 3600)) : out.windows["24h"];
      } catch {}
      // --- card-based costs (FLOW v2): the orchestrator's OWN work, by costKind ---
      // NOTIONAL (Claude sub-agents/orchestrator — plan-covered) is kept STRICTLY SEPARATE from REAL
      // spend (Scrooge). We never sum them into one headline — that would imply we paid for plan-covered
      // tokens. Crew is subscription (no per-task $). Card ts is in ms (the scrooge ledger is in seconds).
      try {
        const WINDOWS_MS = { "24h": 864e5, week: 7 * 864e5, month: 30 * 864e5, quarter: 90 * 864e5, year: 365 * 864e5 };
        const costCards = state.tasks.filter(t => t.costKind || t.costUsd != null);
        const rollupCards = cards => {
          const byKind = {};
          for (const t of cards) {
            const k = t.costKind || "other";
            const e = byKind[k] ||= { count: 0, usd: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, by_model: {}, hasUsd: false };
            // a rolling cc-subagent card carries an invocation count; usd/tokens are already accumulated
            const n = t.count || 1;
            e.count += n;
            if (typeof t.costUsd === "number") { e.usd += t.costUsd; e.hasUsd = true; }
            if (t.tokens) { e.tokens_in += t.tokens.input || 0; e.tokens_out += t.tokens.output || 0; e.cache_read += t.tokens.cacheRead || 0; e.cache_write += t.tokens.cacheWrite || 0; }
            if (t.model) { const m = e.by_model[t.model] ||= { count: 0, usd: 0 }; m.count += n; m.usd += t.costUsd || 0; }
          }
          for (const e of Object.values(byKind)) { e.usd = +e.usd.toFixed(4); e.usd = e.hasUsd ? e.usd : null; }
          return byKind;
        };
        out.costKinds = {};
        const nowMs = now();
        for (const [k, ms] of Object.entries(WINDOWS_MS)) out.costKinds[k] = rollupCards(costCards.filter(t => (t.ts || 0) >= nowMs - ms));
        out.costKinds.lifetime = rollupCards(costCards);
        // per-project notional totals (subagent+orchestrator) so the dashboard can scope it like reliability
        const perProject = {};
        for (const t of costCards) {
          if (typeof t.costUsd !== "number") continue;
          if (t.costKind !== "subagent-notional" && t.costKind !== "orchestrator-notional") continue;
          perProject[canon(t.project)] = +((perProject[canon(t.project)] || 0) + t.costUsd).toFixed(4);
        }
        out.notionalByProject = perProject;
      } catch {}
      return json(res, 200, out);
    }
    if (req.method === "GET" && P === "/lessons") {
      const agent = (q.agent || "").toLowerCase();
      const ls = state.lessons.filter(l => l.scope === "global" || (agent && l.scope === agent));
      return json(res, 200, { lessons: ls });
    }
    // The self-learning loop, surfaced for the dashboard "Learning" sidebar: relay lessons grouped
    // (global / per-agent / per-project), per-LLM reliability from turn telemetry (+ daily series for
    // charts), and the Scrooge guardrails baked into each model's prompt (+ per-model economics).
    if (req.method === "GET" && P === "/learning") {
      const projOf = by => (by && by.includes(":")) ? by.split(":").pop() : "";
      // ts is ms (lessons/telemetry) or s (ledger). Null-safe: a malformed record with a missing/bad
      // ts must not throw (new Date(NaN).toISOString() does) and 500 the whole endpoint — return null
      // and let callers skip that day-bucket.
      const dayOf = ts => { const n = Number(ts); if (!n) return null; const d = new Date(n > 2e10 ? n : n * 1000); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
      const ALL = "*";   // the cross-project ("All projects") bucket
      const out = { totals: {}, lessons: { global: [], byAgent: {}, byProject: {}, projects: [] }, agents: [], agentsByProject: {}, models: [], modelsByProject: {} };

      // relay lessons → global / by-agent / by-project (project derived from the recorder's session id)
      const projSet = new Set();
      for (const l of state.lessons) {
        const rec = { text: l.text, scope: l.scope, by: l.by || "", project: projOf(l.by), ts: l.ts || 0 };
        if (l.scope === "global") out.lessons.global.push(rec); else (out.lessons.byAgent[l.scope] ||= []).push(rec);
        if (rec.project) { (out.lessons.byProject[rec.project] ||= []).push(rec); projSet.add(rec.project); }
      }

      // per-LLM reliability from turn telemetry, bucketed BY PROJECT (+ a global ALL bucket) so the
      // sidebar's project filter scopes the charts. Each turn carries its own project.
      const turns = scanTelemetry();
      const relAgg = {};       // scope -> agent -> {turns,failures,models:Set,lastFailure,days}
      const scopeModels = {};  // scope -> Set(model used)
      let totalTurns = 0, totalFails = 0;
      const bumpRel = (scope, t) => {
        const a = ((relAgg[scope] ||= {})[t.agent] ||= { agent: t.agent, turns: 0, failures: 0, models: new Set(), lastFailure: null, days: {} });
        a.turns++;
        if (t.model) { a.models.add(t.model); if (t.model !== "default") (scopeModels[scope] ||= new Set()).add(t.model); }
        const dk = dayOf(t.ts); const d = dk ? (a.days[dk] ||= { turns: 0, failures: 0 }) : null; if (d) d.turns++;
        if (t.exit && t.exit !== 0) { a.failures++; if (d) d.failures++; if (!a.lastFailure || t.ts > a.lastFailure.ts) a.lastFailure = { ts: t.ts, exit: t.exit, project: t.project || "" }; }
      };
      for (const t of turns) {
        if (!t.agent) continue;
        totalTurns++; if (t.exit && t.exit !== 0) totalFails++;
        bumpRel(ALL, t);
        if (t.project) { bumpRel(t.project, t); projSet.add(t.project); }
      }
      // lessons-accumulated-over-time per scope -> agent brand -> day (agent-scoped lessons only)
      const lessonAgg = {};
      for (const l of state.lessons) {
        if (l.scope === "global") continue; const d = dayOf(l.ts); if (!d) continue;
        const bump = scope => { (((lessonAgg[scope] ||= {})[l.scope] ||= {})[d]) = (lessonAgg[scope][l.scope][d] || 0) + 1; };
        bump(ALL); const p = projOf(l.by); if (p) bump(p);
      }
      const buildAgents = scope => Object.values(relAgg[scope] || {}).sort((a, b) => b.turns - a.turns).map(a => {
        const days = Object.keys(a.days).sort(); let cum = 0; const ld = (lessonAgg[scope] || {})[a.agent] || {};
        return { agent: a.agent, turns: a.turns, failures: a.failures, failRate: a.turns ? +(a.failures / a.turns).toFixed(3) : 0,
          lastFailure: a.lastFailure, models: [...a.models],
          series: {
            failRate: days.map(d => ({ day: d, turns: a.days[d].turns, failures: a.days[d].failures, rate: a.days[d].turns ? +(a.days[d].failures / a.days[d].turns).toFixed(3) : 0 })),
            lessons: Object.keys(ld).sort().map(d => ({ day: d, count: (cum += ld[d]) })),
          } };
      });

      // Scrooge guardrails (global per model) + per-model economics from the ledger, bucketed by project
      let guard = {}; try { guard = JSON.parse(readFileSync(join(homedir(), ".token-scrooge", "lessons.json"), "utf8")) || {}; } catch {}
      try { const lp = join(homedir(), ".token-scrooge", "calls.jsonl"); const st = statSync(lp); if (st.mtimeMs !== _ledgerCache.mtimeMs) { const rows = readFileSync(lp, "utf8").trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(c => c && c.ok); _ledgerCache = { mtimeMs: st.mtimeMs, rows }; } } catch {}
      const ledAgg = {};   // scope -> model -> {calls,ti,to,cost,days}
      const bumpLed = (scope, c) => {
        const m = ((ledAgg[scope] ||= {})[c.model] ||= { calls: 0, ti: 0, to: 0, cost: 0, days: {} });
        m.calls++; m.ti += c.tokens_in || 0; m.to += c.tokens_out || 0; m.cost += c.cost_usd || 0;
        const dk = dayOf(c.ts); if (dk) { const d = (m.days[dk] ||= { cost: 0, ti: 0, to: 0 }); d.cost += c.cost_usd || 0; d.ti += c.tokens_in || 0; d.to += c.tokens_out || 0; }
        (scopeModels[scope] ||= new Set()).add(c.model);
      };
      for (const c of _ledgerCache.rows) { if (!c.model) continue; bumpLed(ALL, c); if (c.project) { bumpLed(c.project, c); projSet.add(c.project); } }

      const savedOf = (ti, to, cost) => +Math.max(0, ti * 15 / 1e6 + to * 75 / 1e6 - cost).toFixed(2);
      let totalGuardrails = 0;
      const mkModel = (scope, model, g) => {
        const gcount = Object.values(g || {}).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
        if (scope === ALL) totalGuardrails += gcount;   // guardrails are global — count once
        const lm = (ledAgg[scope] || {})[model];
        return { model, guardrails: g || {}, guardrailCount: gcount, calls: lm ? lm.calls : 0, cost_usd: lm ? +lm.cost.toFixed(4) : 0,
          saved_usd: lm ? savedOf(lm.ti, lm.to, lm.cost) : 0,
          series: { saved: lm ? Object.keys(lm.days).sort().map(d => ({ day: d, saved: savedOf(lm.days[d].ti, lm.days[d].to, lm.days[d].cost) })) : [] } };
      };
      const buildModels = scope => {
        const keys = new Set(scopeModels[scope] || []);          // models used in this scope
        if (scope === ALL) for (const k of Object.keys(guard)) if (k !== "*") keys.add(k);   // global view also lists every guardrailed model
        const arr = [...keys].sort().map(m => mkModel(scope, m, guard[m]));
        if (guard["*"]) arr.unshift(mkModel(scope, "∗ all models", guard["*"]));   // guardrails that apply to every model
        return arr;
      };

      out.lessons.projects = [...projSet].sort();
      out.agents = buildAgents(ALL); out.models = buildModels(ALL);
      for (const p of out.lessons.projects) { out.agentsByProject[p] = buildAgents(p); out.modelsByProject[p] = buildModels(p); }

      out.totals = { lessons: state.lessons.length, guardrails: totalGuardrails, turns: totalTurns, failures: totalFails, failRate: totalTurns ? +(totalFails / totalTurns).toFixed(3) : 0, models: out.models.length };
      return json(res, 200, out);
    }
    if (req.method === "POST" && P === "/send") {
      const b = await body(req);
      const text = String(b.text ?? "");
      if (!b.from || !text.trim()) return json(res, 400, { error: "from and non-empty text required" });
      const secretCheck = assertNoSecrets(text);
      if (!secretCheck.ok) return json(res, 400, { error: "secret detected", kinds: secretCheck.kinds || [] });
      if (auth?.identity && String(b.from) !== String(auth.identity.name || "")) return json(res, 403, { error: "from must match signer" });
      touch(b.from, undefined, undefined, undefined, auth);
      // attribute the message to a project so the dashboard can show it in that project's lane.
      // explicit b.project wins; else the sender's known project; else parsed from a "host:project" id.
      const fromProj = state.peers[b.from]?.project || (b.from && b.from.includes(":") ? b.from.split(":").pop() : "");
      // `re` threads an OUTCOME back to the CONTRACT it answers. Without it "what am I still owed"
      // is guesswork: a seat still working and a seat that died look identical from the sender's
      // side, which is how an orchestrator ends up waiting forever on a dead peer.
      const re = Number.isFinite(Number(b.re)) && Number(b.re) > 0 ? Number(b.re) : 0;
      const msg = { id: ++state.seq, ts: now(), from: b.from || "anon", to: b.to || "all", text, project: String(b.project || fromProj || "").slice(0, 80), ...(re ? { re } : {}) };
      state.messages.push(msg); if (state.messages.length > 5000) state.messages.splice(0, 1000);
      dirty = true; pushToStreams(msg);               // <-- instant push to live watchers
      // Mirror onto the unified log. `refs` = the card ids this message cites (#3701), which is what
      // lets the FEED thread a conversation under the card it's about. Deliberately NOT `taskId`:
      // that field is the card-event key, and /card must keep counting card events only.
      const refs = [...new Set((msg.text.match(/#(\d{1,7})(?![0-9])/g) || []).map(s => Number(s.slice(1))))].slice(0, 8);
      appendEvent("message", msg.project, msg.from, { msgId: msg.id, toSession: msg.to, text: msg.text.slice(0, 2000), refs });
      return json(res, 200, { ok: true, id: msg.id });
    }
    // ---- /contracts: what this session dispatched and has not been answered on ----------------
    // A contract is a DIRECT message from you to one peer. It closes when that peer sends you an
    // outcome: strictly by `re`, or, for seats that predate it, oldest-open-first. Broadcasts are
    // never contracts. Each open one carries the assignee's presence, because the actionable half
    // of "still waiting" is whether anyone is still on the other end.
    // ---- /delivered: an endpoint that has actually READ its mail says so ----------------------
    // The desktop app lists with peek=1 on purpose, so it never steals a message from a session's
    // delivery hooks. For a HUMAN endpoint there are no hooks — the app is the only reader — so
    // sasha@mac's deliveredUpTo sat at 0 forever while mail piled up. dutyTick then escalated every
    // message the human had already read, told the duty seat about it, the seat messaged the human,
    // and that was undelivered too: about six escalations a minute, all about mail already read.
    // Peeking stays the default; this lets a reader record delivery explicitly instead.
    if (req.method === "POST" && P === "/delivered") {
      const b = await body(req);
      const session = String(b.session || "");
      if (!session) return json(res, 400, { error: "session required" });
      if (auth?.identity && String(auth.identity.name || "") !== session) {
        return json(res, 403, { error: "session must match signer" });
      }
      touch(session, undefined, undefined, undefined, auth);
      markDelivered(session, Number(b.upTo || 0));
      return json(res, 200, { ok: true, deliveredUpTo: state.peers[session]?.deliveredUpTo || 0 });
    }

    if (req.method === "GET" && P === "/contracts") {
      const session = String(q.session || "");
      if (!session) return json(res, 400, { error: "session required" });
      const windowMs = Math.max(60000, Number(q.windowMs || CONTRACT_WINDOW_MS));
      const rawOverdue = q.overdueMs === undefined || q.overdueMs === "" ? null : Number(q.overdueMs);
      const overdueMs = Number.isFinite(rawOverdue) ? Math.max(0, rawOverdue) : null;
      const all = contractsFor(session, { project: String(q.project || ""), windowMs, overdueMs });
      const by = (d) => all.filter(c => c.disposition === d).length;
      // Abandoned contracts leave `contracts` entirely and ride in their own key.
      //
      // Not cosmetic. A session's hooks are PINNED at session start, so an older stop hook iterates
      // `contracts` with its own predicate and knows nothing about `disposition` — it kept blocking on
      // ghosts no matter what the hub called them. Keeping them in the array meant the fix only
      // reached sessions that restarted, and a live one nagged its operator every single turn.
      // Splitting them out fixes every running session the moment the hub redeploys, and the ledger
      // still shows what died via `abandonedContracts`.
      // `superseded` leaves `contracts` for exactly the reason `abandoned` does: a session's hooks
      // are PINNED at session start, so an older stop hook filters this array with its own
      // predicate and would keep blocking on a row the hub has already settled.
      const out = all.filter(c => c.disposition !== "abandoned" && c.disposition !== "superseded");
      return json(res, 200, {
        session, contracts: out, abandonedContracts: all.filter(c => c.disposition === "abandoned"),
        supersededContracts: all.filter(c => c.disposition === "superseded"),
        open: out.filter(c => !c.answered).length,
        waiting: by("waiting"), stalled: by("stalled"), abandoned: by("abandoned"),
        superseded: by("superseded"), answered: by("answered"),
      });
    }

    if (req.method === "GET" && P === "/inbox") {
      if (!canUseInboxSession(auth, q.session)) return json(res, 403, { error: "forbidden" });
      touch(q.session, undefined, undefined, undefined, auth); const since = Number(q.since || 0);
      const msgs = state.messages.filter(m => m.id > since && deliverable(m, q.session) && inboxReadable(auth, m, q.session));
      const cursor = msgs.length ? msgs[msgs.length - 1].id : since;
      // peek=1 -> LOOK without claiming delivery. The Stop hook has to ask "is anything waiting?" before
      // it knows whether it will surface it (it may be on its second pass, where it must let the stop
      // through). Advancing the ledger on a peek would tell the deferred waker the message had been
      // delivered when nobody ever saw it — a silent hole exactly where this feature is supposed to help.
      if (q.peek !== "1") markDelivered(q.session, cursor);
      // superseded (instance-keys contract): a baton twin that lost the claim learns it HERE, via
      // its own read — its hooks turn this into a stand-down note for the model. Never a block.
      return json(res, 200, auth?.superseded ? { messages: msgs, cursor, superseded: true } : { messages: msgs, cursor });
    }
    if (req.method === "GET" && P === "/poll") {
      if (!canUseInboxSession(auth, q.session)) return json(res, 403, { error: "forbidden" });
      touch(q.session, undefined, undefined, undefined, auth); const since = Number(q.since || 0);
      const waitMs = Math.min(Number(q.wait || 25), 290) * 1000;   // allow long idle-park
      const deadline = now() + waitMs;
      const tick = () => {
        const msgs = state.messages.filter(m => m.id > since && deliverable(m, q.session) && inboxReadable(auth, m, q.session));
        if (msgs.length || now() >= deadline) { touch(q.session, undefined, undefined, undefined, auth); const cursor = msgs.length ? msgs[msgs.length - 1].id : since; markDelivered(q.session, cursor); return json(res, 200, auth?.superseded ? { messages: msgs, cursor, superseded: true } : { messages: msgs, cursor }); }
        setTimeout(tick, 300);
      };
      return tick();
    }
    if (req.method === "GET" && P === "/stream") {                 // SSE — true push, no polling
      const session = q.session || "all";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", "access-control-allow-origin": "*" });
      res.write(`: connected as ${session}\n\n`);
      touch(session, q.status, undefined, undefined, auth);
      // events=1 opts this stream into the unified log as NAMED "ev" frames (see pushEventToStreams).
      // Existing consumers omit it and keep receiving bus messages on the default channel only.
      const entry = { session, res, events: q.events === "1" };
      streams.push(entry);
      const ka = setInterval(() => { try { res.write(": ka\n\n"); touch(session, undefined, undefined, undefined, auth); } catch {} }, 20000);
      req.on("close", () => { clearInterval(ka); const i = streams.indexOf(entry); if (i >= 0) streams.splice(i, 1); });
      return;
    }
    if (req.method === "GET" && P === "/recent") {   // god-view: last N messages, for the dashboard feed
      const n = Math.min(Number(q.limit || 50), 200);
      return json(res, 200, { messages: filterReadable(auth, state.messages, m => m.project || "").slice(-n) });
    }
    if (req.method === "GET" && (P === "/" || P === "/ui")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(UI || "<h1>trantor</h1><p>dashboard unavailable</p>");
    }
    if (P === "/health") return json(res, 200, { ok: true, authMode: AUTH_MODE, peers: Object.keys(state.peers).length, messages: state.messages.length, streams: streams.length,
      // #5686: duty liveness rides /health so the app's Home strip and doctor read one truth.
      duty: { ...dutyLiveness(), darkSinceMs: dutyDarkSince ? now() - dutyDarkSince : 0, queuedEscalations: dutyQueuedEscalations() } });
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
});
server.listen(PORT, HOST, () => console.error(`[trantor] hub on http://${HOST}:${PORT} (auth: ${AUTH_MODE}; data: ${DATA})`));
