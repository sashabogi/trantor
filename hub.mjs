#!/usr/bin/env node
// trantor hub — message bus + presence/status board + SSE push, so independent
// Claude Code sessions can coordinate (near-instant for watchers, cheap for idle peers).
// Binds to LOOPBACK (127.0.0.1) by default — local-first and safe (no auth yet). To let other
// machines reach it (e.g. over a Tailscale tailnet), set RELAY_HOST=0.0.0.0 — but only on a
// private network, or add auth first. See "Always-on / remote hub" in the README (roadmap).
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { verifyRequest, publicView } from "./lib/identity.mjs";
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
const FOCUS_OFFLINE_MS = Number(process.env.RELAY_FOCUS_OFFLINE_MS || ONLINE_MS);   // close a focus card once its session is offline (not the old 6h)
const REAP_INTERVAL_MS = Number(process.env.RELAY_REAP_INTERVAL_MS || 60000);       // how often the reaper sweeps (env-tunable; tests set it low)
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
  return { messages: [], peers: {}, seq: 0, tasks: [], taskSeq: 0, projectMeta: {}, lessons: [], events: [], cardEventsBackfilled: false, aliases: {}, phaseMeta: {}, verifyGates: [], verifyGateSeq: 0, balances: { ts: 0, by: "", entries: [] }, subagentCostReset: false, handoffLog: [], identities: {}, inviteTokens: {}, focus: {}, orgPolicy: {} };
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
  s.balances = loaded.balances && typeof loaded.balances === "object" ? loaded.balances : { ts: 0, by: "", entries: [] };
  s.subagentCostReset = !!loaded.subagentCostReset;
  s.handoffLog = Array.isArray(loaded.handoffLog) ? loaded.handoffLog : [];
  s.identities = loaded.identities && typeof loaded.identities === "object" ? loaded.identities : {};
  s.inviteTokens = loaded.inviteTokens && typeof loaded.inviteTokens === "object" ? loaded.inviteTokens : {};
  s.focus = loaded.focus && typeof loaded.focus === "object" ? loaded.focus : {};
  s.orgPolicy = loaded.orgPolicy && typeof loaded.orgPolicy === "object" ? loaded.orgPolicy : {};
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
function closeFocus(session) {
  const t = state.tasks.find(x => x.source === "session" && x.assignee === session && x.status !== "done");
  if (!t) return false;
  (t.history ||= []).push({ from: t.status, to: "done", by: session, ts: now() });
  if (t.history.length > 60) t.history.splice(0, 20);
  appendCardEvent("moved", t, session, t.status, "done");
  t.status = "done"; t.updated = now();
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
  const graceCut = now() - REAP_GRACE_MS;
  let changed = false;
  for (const t of state.tasks) {
    if (t.status === "done" || t.status === "stale") continue;
    if (t.source === "session") {                                  // (a) focus cards → done when session offline
      const p = state.peers[t.assignee];
      if (!p || (p.lastSeen || 0) < focusCut) { if (closeFocus(t.assignee)) changed = true; }
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
let HUB_VERSION = ""; try { HUB_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version || ""; } catch {}
// dependency-free semver compare: -1 if a<b, 0 if equal, 1 if a>b (numeric parts only)
function cmpSemver(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0), pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) < (pb[i] || 0)) return -1; if ((pa[i] || 0) > (pb[i] || 0)) return 1; }
  return 0;
}
const AUTH_HEADERS = ["x-trantor-pubkey", "x-trantor-sig", "x-trantor-ts", "x-trantor-nonce"];
const PUBLIC_ENDPOINTS = new Set(["/", "/ui", "/health", "/enroll"]);
const OWNER_ENDPOINTS = new Set(["/project/delete", "/sweep", "/reconcile", "/invite", "/import"]);
const READ_ENDPOINTS = new Set(["/peers", "/tasks", "/events", "/inbox", "/peer", "/card", "/stream", "/history", "/projects", "/catchup", "/phases", "/recent", "/handoffs", "/verify-gates", "/claims"]);
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
  return canon(String(b?.project || q?.project || "").slice(0, 80));
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
  const verified = verifyRequest({ headers: req.headers, method: req.method, path, body: raw });
  if (!verified.ok) return { ok: false, code: 401, error: verified.reason || "bad signature" };
  const nonceKey = `${verified.pubkey}:${verified.nonce}`;
  for (const [k, ts] of seenNonces) if (Math.abs(now() - ts) > 120000) seenNonces.delete(k);
  if (seenNonces.has(nonceKey)) return { ok: false, code: 401, error: "replay" };
  seenNonces.set(nonceKey, verified.ts);
  if (seenNonces.size > 10000) seenNonces.delete(seenNonces.keys().next().value);
  const identity = findIdentity(verified.pubkey);
  if (!identity) return { ok: false, code: 401, error: "unknown identity" };
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
  const last = state.events[state.events.length - 1];
  const ev = { id: (last?.id || 0) + 1, ts: now(), type, project: project || "", by: by || "", ...extra };
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
      if (pr) { if (b.model) pr.model = String(b.model).slice(0, 80); if (b.llm) pr.llm = String(b.llm).slice(0, 40); }
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
        const ev = { ...e, id: (last?.id || 0) + 1, project: proj };
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
      const peerRows = filterReadable(auth, Object.entries(state.peers), ([, v]) => v.project || "");
      return json(res, 200, { hubVersion: HUB_VERSION, authMode: AUTH_MODE, peers: peerRows.map(([s, v]) => ({ session: s, lastSeen: v.lastSeen, online: v.lastSeen > cutoff, status: v.status || "", health: healthOf(v.status), project: v.project || "",
        pubkey: v.pubkey || "", identity: v.identity || null, authWarning: v.authWarning || "",
        llm: v.llm || "", model: v.model || "", hookVersion: v.hookVersion || "", staleHooks: !!(v.lastSeen > cutoff && v.hookVersion && HUB_VERSION && cmpSemver(v.hookVersion, HUB_VERSION) < 0) })) });
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
            dirty = true; return json(res, 200, { ok: true, task: cand, deduped: true, enriched: true });
          }
          const title = String(atype || "subagent").slice(0, 180);
          const t = { id: ++state.taskSeq, project: proj0, title, assignee: `${atype}:${proj0}`,
            status: "doing", phase: "sub-agents", source: "cc-subagent", costKind: "subagent-notional",
            costUsd: null, costNote: "", effort: "", tokens: null, difficulty: "", model: "", deps: [],
            parent: parent || undefined, by: b.by || "", ts: ts0, updated: ts0,
            history: [{ to: "doing", by: b.by || "", ts: ts0 }] };
          t._fp = subFp(title); t._atype = atype; t._aid = agentId; t.count = 1; t._everStarted = true; t._inflight = 1;
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
          dirty = true; return json(res, 200, { ok: true, task: ex, deduped: true });
        }
        const bt = { id: ++state.taskSeq, project: proj0, title: String(b.title || b.agentType || "background agent").slice(0, 200),
          assignee: String(b.assignee || "").slice(0, 60), status: target, phase: "sub-agents",
          source: "cc-bg-agent", costKind: "", costUsd: null, costNote: "", effort: "", tokens: null,
          difficulty: "", model: "", deps: [], parent: b.parent ? String(b.parent).slice(0, 120) : undefined,
          by: b.by || "", ts: ts0, updated: ts0, history: [{ to: target, by: b.by || "", ts: ts0 }] };
        if (bgId) bt._aid = bgId; if (b.agentType) bt._atype = String(b.agentType).slice(0, 40);
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
      if (b.source === "cc-subagent") { t._fp = subFp(b.title); if (b.agentType) t._atype = String(b.agentType).slice(0, 40); if (b.agentId) t._aid = String(b.agentId).slice(0, 80); if (b.parent) t.parent = String(b.parent).slice(0, 120); t.count = 1; if (t.status === "doing") { t._everStarted = true; t._inflight = 1; } }
      state.tasks.push(t); if (state.tasks.length > 2000) state.tasks.splice(0, 500);
      appendCardEvent("created", t, b.by, null, st0);
      dirty = true; return json(res, 200, { ok: true, task: t });
    }
    if (req.method === "POST" && P === "/task/update") {    // move/edit a card
      const b = await body(req); const t = state.tasks.find(x => x.id === Number(b.id));
      if (!t) return json(res, 404, { error: "no such task" });
      let eventType = "updated", eventFrom = null, eventTo = null;
      if (b.status && ["todo","doing","testing","failed","done","blocked","stale"].includes(b.status) && b.status !== t.status) {
        eventType = "moved"; eventFrom = t.status; eventTo = b.status;
        (t.history ||= []).push({ from: t.status, to: b.status, by: b.by || "", ts: now() });
        if (t.history.length > 40) t.history.splice(0, 10);
        t.status = b.status;
      }
      if (b.difficulty && ["easy","medium","hard"].includes(b.difficulty)) t.difficulty = b.difficulty;
      if (b.model !== undefined) t.model = String(b.model).slice(0, 60);
      if (Array.isArray(b.deps)) t.deps = [...new Set(b.deps.map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== t.id))].slice(0, 20);
      if (b.assignee !== undefined) t.assignee = b.assignee;
      if (b.title !== undefined) t.title = String(b.title).slice(0,200);
      // the narrative line a human reads on the board ("assigned — did"), written by the cheap
      // summarizer; rides the tasks.extra column, so it survives restarts everywhere
      if (b.summary !== undefined) t.summary = String(b.summary).slice(0, 220);
      if (b.delete) { eventType = "deleted"; eventFrom = null; eventTo = null; state.tasks = state.tasks.filter(x => x.id !== t.id); }
      appendCardEvent(eventType, t, b.by, eventFrom, eventTo);
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
      if (!session || !project || !title) return json(res, 400, { error: "session, project, title required" });
      touch(session, undefined, project, undefined, auth);
      let t = state.tasks.find(x => x.source === "session" && x.assignee === session && canon(x.project) === project && x.status !== "done");
      if (t) {
        if (t.title !== title) {            // refocus: re-title in place + record the shift (keeps the trail)
          (t.history ||= []).push({ from: t.status, to: t.status, by: session, ts: now(), note: title.slice(0, 90) });
          if (t.history.length > 60) t.history.splice(0, 20);
          t.title = title; appendCardEvent("updated", t, session, null, null);
          appendEvent("focus", project, session, { taskId: t.id, title, shift: true });
        }
        t.status = "doing"; t.updated = now();
      } else {
        t = { id: ++state.taskSeq, project, title, assignee: session, status: "doing", source: "session",
          difficulty: "", model: "", deps: [], by: session, ts: now(), updated: now(),
          history: [{ to: "doing", by: session, ts: now() }] };
        state.tasks.push(t); appendCardEvent("created", t, session, null, "doing");
        appendEvent("focus", project, session, { taskId: t.id, title, shift: false });
        if (state.tasks.length > 2000) state.tasks.splice(0, state.tasks.length - 2000);
      }
      dirty = true; return json(res, 200, { ok: true, id: t.id, task: t });
    }
    if (req.method === "GET" && P === "/focus") {     // the session's open focus card (for sub-agent nesting)
      const session = String(q.session || "");
      const t = state.tasks.find(x => x.source === "session" && x.assignee === session && x.status !== "done");
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
      const msg = { id: ++state.seq, ts: now(), from: b.from || "anon", to: b.to || "all", text, project: String(b.project || fromProj || "").slice(0, 80) };
      state.messages.push(msg); if (state.messages.length > 5000) state.messages.splice(0, 1000);
      dirty = true; pushToStreams(msg);               // <-- instant push to live watchers
      // Mirror onto the unified log. `refs` = the card ids this message cites (#3701), which is what
      // lets the FEED thread a conversation under the card it's about. Deliberately NOT `taskId`:
      // that field is the card-event key, and /card must keep counting card events only.
      const refs = [...new Set((msg.text.match(/#(\d{1,7})(?![0-9])/g) || []).map(s => Number(s.slice(1))))].slice(0, 8);
      appendEvent("message", msg.project, msg.from, { msgId: msg.id, toSession: msg.to, text: msg.text.slice(0, 2000), refs });
      return json(res, 200, { ok: true, id: msg.id });
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
      return json(res, 200, { messages: msgs, cursor });
    }
    if (req.method === "GET" && P === "/poll") {
      if (!canUseInboxSession(auth, q.session)) return json(res, 403, { error: "forbidden" });
      touch(q.session, undefined, undefined, undefined, auth); const since = Number(q.since || 0);
      const waitMs = Math.min(Number(q.wait || 25), 290) * 1000;   // allow long idle-park
      const deadline = now() + waitMs;
      const tick = () => {
        const msgs = state.messages.filter(m => m.id > since && deliverable(m, q.session) && inboxReadable(auth, m, q.session));
        if (msgs.length || now() >= deadline) { touch(q.session, undefined, undefined, undefined, auth); const cursor = msgs.length ? msgs[msgs.length - 1].id : since; markDelivered(q.session, cursor); return json(res, 200, { messages: msgs, cursor }); }
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
    if (P === "/health") return json(res, 200, { ok: true, authMode: AUTH_MODE, peers: Object.keys(state.peers).length, messages: state.messages.length, streams: streams.length });
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
});
server.listen(PORT, HOST, () => console.error(`[trantor] hub on http://${HOST}:${PORT} (auth: ${AUTH_MODE}; data: ${DATA})`));
