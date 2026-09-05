/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: State normalization is the persisted-data boundary; these checks preserve the legacy decoder byte-for-byte during a structural-only split. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createPersistHealth } from "../lib/persist-health.mjs";
import { DEFAULT_ORG } from "../lib/store-contract.mjs";

export async function createStoreRuntime({ STORE_KIND, PG_URL, ORG_ID, DATA }) {
function emptyState() {
  return { messages: [], peers: {}, seq: 0, tasks: [], taskSeq: 0, projectMeta: {}, lessons: [], events: [], cardEventsBackfilled: false, aliases: {}, phaseMeta: {}, verifyGates: [], verifyGateSeq: 0, proposals: [], proposalSeq: 0, balances: { ts: 0, by: "", entries: [] }, subagentCostReset: false, handoffLog: [], identities: {}, inviteTokens: {}, focus: {}, orgPolicy: {}, instances: {}, dutySession: "", contractReap: {}, eventSeq: 0 };
}

const CARD_LOG_MAX = 40;
const CARD_LOG_TEXT_MAX = 2000;
const CARD_LOG_BY_MAX = 120;
const stripNulText = (value) => String(value ?? "").replace(/\u0000/g, "");
function normalizeTaskLog(t) {
  if (!Array.isArray(t.log)) { if (t.log !== undefined) delete t.log; return false; }
  const before = JSON.stringify(t.log);
  t.log = t.log
    .filter(e => e && typeof e === "object" && typeof e.text === "string")
    .map(e => ({
      ts: Number.isFinite(Number(e.ts)) && Number(e.ts) > 0 ? Math.floor(Number(e.ts)) : Date.now(),
      by: String(e.by || "").slice(0, CARD_LOG_BY_MAX),
      text: stripNulText(e.text).slice(0, CARD_LOG_TEXT_MAX),
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
    text: stripNulText(text).slice(0, CARD_LOG_TEXT_MAX),
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
      // #6170: `kind` must be carried across the load. This normalizer rebuilds every peer from an
      // explicit field list, so a field missing here is dropped no matter how faithfully the store
      // returned it — which is exactly what happened: the column was added, Postgres held the right
      // values, and the kinds still came back empty on the first live restart. llm/model stay
      // out on purpose: those ARE in-memory presence, re-supplied by the next heartbeat.
      : { lastSeen: v.lastSeen || 0, status: v.status || "", project: v.project || "", pubkey: v.pubkey || "", identity: v.identity || null, authWarning: v.authWarning || "", hookVersion: v.hookVersion || "", kind: v.kind || "", deliveredUpTo: v.deliveredUpTo || v.delivered_up_to || 0, _on: v._on === true || v.online === true };
  }
  return s;
}

let durableStore = null;
let state = emptyState();
if (STORE_KIND === "pg" || STORE_KIND === "postgres") {
  try {
    const { createPgStore } = await import("../lib/store-pg.mjs");
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
const persistHealth = createPersistHealth({
  baseMs: process.env.RELAY_PERSIST_RETRY_BASE_MS,
  maxMs: process.env.RELAY_PERSIST_RETRY_MAX_MS,
  logIntervalMs: process.env.RELAY_PERSIST_LOG_INTERVAL_MS,
});
const snapshotState = () => JSON.parse(JSON.stringify({ ...state, cardEvents: state.events.filter(e => ["created", "moved", "updated"].includes(e?.type)) }));
// This hub's writer id: saveDelta stamps it into every NOTIFY so we can tell our own change
// notifications apart from a second writer's (importer, admin psql, another hub instance).
const HUB_SRC = `hub-${process.pid}-${randomBytes(4).toString("hex")}`;
// What the DB currently holds, as of our last successful persist. saveDelta diffs against this and
// writes ONLY the difference — it never deletes rows it has not seen, so a second writer's rows
// survive our persist ticks (the old saveSnapshot wholesale delete+rewrite destroyed them).
let lastPersisted = durableStore ? snapshotState() : null;
if (runTaskBootMigrations()) dirty = true;
const recordPersistFailure = (kind, error) => {
  dirty = true;
  const failure = persistHealth.failed(error);
  if (failure.shouldLog) {
    process.stderr.write(`[trantor] ${kind} persist failing: ${failure.health.retries} retries over ${failure.health.failingSinceMs}ms; last error: ${failure.health.lastError}\n`);
  }
};
const persist = () => {
  if (!dirty || persisting || !persistHealth.canAttempt()) return;
  if (durableStore) {
    const snapshot = snapshotState();
    dirty = false; persisting = true;
    durableStore.saveDelta(ORG_ID, lastPersisted, snapshot, { src: HUB_SRC }).then(() => {
      lastPersisted = snapshot;
      persistHealth.succeeded();
    }).catch(e => {
      recordPersistFailure("Postgres", e);
    }).finally(() => {
      persisting = false;
    });
    return;
  }
  try {
    writeFileSync(DATA, JSON.stringify(snapshotState()));
    dirty = false;
    persistHealth.succeeded();
  } catch (e) {
    recordPersistFailure("JSON", e);
  }
};
const persistTickMs = Math.min(1000, Math.max(10, Number(process.env.RELAY_PERSIST_RETRY_BASE_MS) || 1000));
setInterval(persist, persistTickMs).unref?.();

  const markDirty = () => { dirty = true; };
  const replaceState = loaded => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, normalizeState(loaded));
  };
  let reloadTimer = null;
  let reloading = false;
  let reloadAgain = false;
  let onReload = () => {};
  const scheduleReload = () => {
    if (reloadTimer || reloading) { reloadAgain = reloading; return; }
    reloadTimer = setTimeout(() => { reloadTimer = null; reload(); }, 250);
  };
  const reload = async () => {
    if (!durableStore || reloading) { reloadAgain = reloading; return false; }
    reloading = true;
    let loaded = false;
    try {
    for (let i = 0; i < 100 && (dirty || persisting); i++) {
      persist();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
      if (dirty || persisting) {
        reloadAgain = true;
      } else {
        replaceState(await durableStore.loadSnapshot(ORG_ID));
        lastPersisted = snapshotState();
        loaded = true;
        onReload();
      }
    } catch (error) {
      process.stderr.write(`[trantor] store reload failed: ${error.message || error}\n`);
    } finally {
      reloading = false;
      if (reloadAgain) { reloadAgain = false; scheduleReload(); }
    }
    return loaded;
  };
  const startChangeSubscription = callback => {
    onReload = typeof callback === "function" ? callback : onReload;
    if (!durableStore?.subscribeChanges) return;
    durableStore.subscribeChanges(payload => {
      if (payload && payload.src === HUB_SRC) return;
      scheduleReload();
    }).catch(error => process.stderr.write(`[trantor] LISTEN ${error.message || error} — external writes will NOT surface until restart\n`));
  };

  return {
    state, durableStore, persist, persistHealth, markDirty, reload, startChangeSubscription,
    HUB_SRC, appendTaskLog, appendTaskNote, cleanChecklist, stripNulText,
  };
}
