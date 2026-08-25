// trantor — the STORE CONTRACT for Phase 1. Frozen; every Phase 1 package writes through this.
//
// WHY A CONTRACT FILE AND NOT JUST "use Postgres": Phase 0 landed cleanly because lib/identity.mjs
// was frozen before four seats fanned out against it. The same discipline applies here — the schema
// and the store surface are consumed by the migration importer, the deploy scripts, and hub.mjs
// simultaneously, and contract drift between them is the failure mode that actually costs a rebuild.
//
// DESIGN, in one line: the EVENT LOG is the table; board state is a PROJECTION of it.
// That is already how the hub thinks since 0.17.54 (`state.events` is append-only and `/card`
// derives a thread by joining events). Postgres just makes the projection durable instead of
// rebuilt-in-memory-and-lost-on-restart.
//
// THE DEBT THIS PAYS OFF: the teams SQLite store hydrates only peers/messages/tasks/projectMeta/
// lessons + meta. verifyGates, balances, handoffLog, aliases, phaseMeta and focus ride IN MEMORY
// and vanish on restart. Survivable for a hub you restart deliberately; NOT survivable for an
// always-on remote service. Every field below must round-trip.

// ---------------------------------------------------------------------------------------------
// SCHEMA (authoritative). Every scoped row carries org_id — see TDD §6b. Adding a tenant column to
// an empty schema is free; adding it after 1,542 cards have migrated is surgery on live data.
// ---------------------------------------------------------------------------------------------
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orgs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  owner_pubkey TEXT NOT NULL,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  pubkey  TEXT NOT NULL,
  role    TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  added_at BIGINT NOT NULL,
  PRIMARY KEY (org_id, pubkey)
);

CREATE TABLE IF NOT EXISTS identities (
  pubkey      TEXT PRIMARY KEY,
  org_id      TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('human','agent')),
  scopes      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { "<project>": "owner"|"write"|"read" }
  enrolled_by TEXT,
  created_at  BIGINT NOT NULL,
  revoked_at  BIGINT                                 -- set, never deleted: revocation is audit
);

-- THE LOG. Append-only, never updated, never deleted except by retention. Everything else derives.
CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  org_id     TEXT NOT NULL,
  ts         BIGINT NOT NULL,
  type       TEXT NOT NULL,          -- 'created'|'moved'|… (legacy card types) or dotted: 'message', 'presence.online', 'file.claim'
  project    TEXT,
  by_session TEXT,
  task_id    BIGINT,                 -- card events ONLY (see invariant 2 below)
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_org_ts   ON events (org_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_org_proj ON events (org_id, project, ts DESC);
CREATE INDEX IF NOT EXISTS events_task     ON events (org_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_type     ON events (org_id, type, ts DESC);

-- PROJECTIONS. Rebuildable from events; never the source of truth for history.
CREATE TABLE IF NOT EXISTS tasks (
  id         BIGINT NOT NULL,
  org_id     TEXT NOT NULL,
  project    TEXT,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  assignee   TEXT,
  source     TEXT,
  difficulty TEXT,
  model      TEXT,
  phase      TEXT,
  cost_usd   DOUBLE PRECISION,
  deps       JSONB DEFAULT '[]'::jsonb,
  history    JSONB DEFAULT '[]'::jsonb,
  created    BIGINT,
  updated    BIGINT,
  extra      JSONB DEFAULT '{}'::jsonb,   -- every card field WITHOUT a column (costKind, tokens,
                                          -- count, _aid, parent, …). Without this the store
                                          -- silently DROPPED them — /economics had no costKind on
                                          -- the remote hub and the whole cost header came up empty.
  PRIMARY KEY (org_id, id)
);
-- additive migration for hubs whose tasks table predates the extra column
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS extra JSONB DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS tasks_org_proj ON tasks (org_id, project, status);

CREATE TABLE IF NOT EXISTS messages (
  id       BIGINT NOT NULL,
  org_id   TEXT NOT NULL,
  ts       BIGINT NOT NULL,
  from_session TEXT NOT NULL,
  to_session   TEXT NOT NULL,
  project  TEXT,
  text     TEXT NOT NULL,
  refs     JSONB DEFAULT '[]'::jsonb,
  re       BIGINT,                        -- the message id this one ANSWERS (a contract outcome).
                                          -- Without it /contracts cannot close the right contract
                                          -- after a restart and silently falls back to guessing
                                          -- oldest-open-first.
  PRIMARY KEY (org_id, id)
);
-- additive migration for hubs whose messages table predates the reply link
ALTER TABLE messages ADD COLUMN IF NOT EXISTS re BIGINT;
CREATE INDEX IF NOT EXISTS messages_org_to ON messages (org_id, to_session, id DESC);

CREATE TABLE IF NOT EXISTS peers (
  session         TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  pubkey          TEXT,
  project         TEXT,
  status          TEXT,
  hook_version    TEXT,
  last_seen       BIGINT,
  online          BOOLEAN DEFAULT FALSE,
  delivered_up_to BIGINT DEFAULT 0,
  PRIMARY KEY (org_id, session)
);

-- The fields that currently ride in-memory and are LOST on restart. This is the debt being paid.
CREATE TABLE IF NOT EXISTS kv (
  org_id TEXT NOT NULL,
  key    TEXT NOT NULL,        -- 'verifyGates'|'balances'|'handoffLog'|'aliases'|'phaseMeta'|'focus'|'projectMeta'|'lessons'|'orgPolicy'|'meta'|'contractReap'
  value  JSONB NOT NULL,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE IF NOT EXISTS schema_meta (version INT PRIMARY KEY, applied_at BIGINT NOT NULL);
`;

// Keys that MUST round-trip through kv. A restart that loses any of these is a failed migration.
// `proposals` (agent-proposed permissions, v0.17.68) especially: a denied proposal is a MEMORY —
// the hub refuses near-duplicate re-proposals against it, and a restart that forgets denials
// silently re-opens every door the operator closed.
// `contractReap` likewise: it records that a dispatched contract's assignee went quiet for good.
// Held only in memory it would be rebuilt from scratch on every restart, and the whole ghost backlog
// would re-announce itself — the same shape of bug as the in-memory escalation set.
export const KV_KEYS = ["verifyGates", "balances", "handoffLog", "aliases", "phaseMeta", "focus",
                        "projectMeta", "lessons", "orgPolicy", "meta", "subagentCostReset", "seq",
                        "proposals", "contractReap"];

// ---------------------------------------------------------------------------------------------
// INVARIANTS — carried forward from 0.17.54. Breaking one silently corrupts the board.
// ---------------------------------------------------------------------------------------------
// 1. Card events keep their LEGACY FLAT SHAPE and LEGACY TYPE NAMES ('created'/'moved'/'updated',
//    never 'card.created'). Every NEW event type is dotted. /history filters on that distinction.
// 2. Message events carry `refs[]`, NEVER `task_id`. task_id is the card-event key and /card must
//    keep counting card events only.
// 3. Threads are DERIVED, never stored: a card's thread = its own events ∪ messages whose refs
//    include it.
// 4. The delivery ledger (`delivered_up_to`) is MONOTONIC. A re-read never rewinds it.
// 5. Retention is TIME-based on a shared hub, not count-based. Deleting from `events` must never
//    delete a projection row — projections outlive the events that built them.

// ---------------------------------------------------------------------------------------------
// STORE SURFACE — what hub.mjs may call. Implementations: pg (remote) and json (local, existing).
// Async everywhere, so the local JSON path and the Postgres path are interchangeable.
// ---------------------------------------------------------------------------------------------
export const STORE_API = Object.freeze({
  init:            "() -> Promise<void>            // create schema if absent, apply migrations",
  close:           "() -> Promise<void>",

  appendEvent:     "(orgId, evt) -> Promise<number>   // returns event id; evt: {type,project,by,taskId?,payload}",
  readEvents:      "(orgId, {project,type,by,taskId,since,limit}) -> Promise<{events,cursor,latest}>",
  pruneEvents:     "(orgId, olderThanMs) -> Promise<number>   // TIME-based; must not touch projections",

  upsertTask:      "(orgId, task) -> Promise<void>",
  readTasks:       "(orgId, {project,status}) -> Promise<Task[]>",

  appendMessage:   "(orgId, msg) -> Promise<number>",
  readInbox:       "(orgId, session, since, {peek}) -> Promise<{messages,cursor}>",
  markDelivered:   "(orgId, session, upTo) -> Promise<void>   // MONOTONIC",

  touchPeer:       "(orgId, session, patch) -> Promise<void>",
  readPeers:       "(orgId) -> Promise<Peer[]>",
  readPeer:        "(orgId, session) -> Promise<Peer|null>",

  getKV:           "(orgId, key) -> Promise<any>",
  setKV:           "(orgId, key, value) -> Promise<void>",

  upsertIdentity:  "(orgId, identity) -> Promise<void>",
  readIdentity:    "(pubkey) -> Promise<Identity|null>   // pubkey is globally unique, org comes back on it",

  createOrg:       "({id,name,ownerPubkey}) -> Promise<void>",
  addMember:       "(orgId, pubkey, role) -> Promise<void>",
  readOrgOf:       "(pubkey) -> Promise<{orgId,role}|null>",
});

// Single-tenant local hubs use this so nothing is special-cased on the read path.
export const DEFAULT_ORG = "local";

// Cross-writer change protocol (additive to the frozen surface). EVERY writer to the store —
// the hub, the migration importer, an admin psql session — must NOTIFY this channel after a
// committed write, payload `{"src":"<writer-id>"}`. The hub LISTENs and reloads its in-memory
// projection when a notification arrives from a src other than itself. Without this, the hub's
// boot-time cache goes stale and a second writer's changes never surface until a restart.
export const CHANGE_CHANNEL = "trantor_changes";
