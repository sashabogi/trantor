// trantor — the STORE CONTRACT for Phase 1, frozen: the EVENT LOG is the table, board state is a
// PROJECTION of it, and every field below must round-trip (docs/CONTRACT-lib.md §store contract).

// ---------------------------------------------------------------------------------------------
// SCHEMA (authoritative). Every scoped row carries org_id — see TDD §6b. Adding a tenant column to
// an empty schema is free; adding it after 1,542 cards have migrated is surgery on live data.
// ---------------------------------------------------------------------------------------------
export const SCHEMA_VERSION = 1;
export const IDENTITY_KINDS = Object.freeze(["human", "agent", "tool"]);

const IDENTITY_KINDS_SQL = IDENTITY_KINDS.map(kind => `'${kind}'`).join(",");

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
  kind        TEXT NOT NULL CHECK (kind IN (${IDENTITY_KINDS_SQL})),
  scopes      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { "<project>": "owner"|"write"|"read" }
  enrolled_by TEXT,
  created_at  BIGINT NOT NULL,
  revoked_at  BIGINT                                 -- set, never deleted: revocation is audit
);

-- 2026-09-03: installs created under CHECK (kind IN ('human','agent')) widen on boot; the genesis
-- identity enrols as 'tool' (#6068) and the narrower check poisoned every persist delta for 13 min.
ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_kind_check;
ALTER TABLE identities ADD CONSTRAINT identities_kind_check CHECK (kind IN (${IDENTITY_KINDS_SQL}));


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
  wake     BOOLEAN,                       -- false = the SENDER declared this context, not a
                                          -- contract (#7079). NULL is "not said", which reads as
                                          -- a normal contract: an old row must never turn into
                                          -- an ack because the column arrived after it did.
  kind     TEXT,                          -- receipt / status / "": a report owes nothing back.
  PRIMARY KEY (org_id, id)
);
-- additive migration for hubs whose messages table predates the reply link
ALTER TABLE messages ADD COLUMN IF NOT EXISTS re BIGINT;
-- additive migration for hubs whose messages table predates the ack flag and message kind (#7140):
-- without them every hub restart reloaded each outstanding ack as a blocking contract.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wake BOOLEAN;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT;
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
  kind            TEXT,                  -- #6170: WHAT this session is — 'agent' (crew seat),
                                         -- 'orch', 'genesis', 'tool'. The overseer's crew
                                         -- exemption reads it (#6075/#6148), so when a restart
                                         -- forgot it the hub warned about its own crew.
  PRIMARY KEY (org_id, session)
);
-- additive migration for hubs whose peers table predates the kind column (#6170)
ALTER TABLE peers ADD COLUMN IF NOT EXISTS kind TEXT;
-- DELIBERATELY no CHECK on peers.kind, unlike identities.kind above. The hub accepts whatever a
-- client stamps (hub.mjs /register takes any string up to 40 chars) and the vocabulary grows with
-- the product — 'genesis' arrived in #6068, 'orch' in #6075. #6169 is the cost of getting this
-- wrong in the other direction: a CHECK narrower than the values in flight poisoned every persist
-- delta for 13 minutes. A column that stores what it is given cannot fail that way.

-- The fields that currently ride in-memory and are LOST on restart. This is the debt being paid.
CREATE TABLE IF NOT EXISTS kv (
  org_id TEXT NOT NULL,
  key    TEXT NOT NULL,        -- 'verifyGates'|'balances'|'handoffLog'|'aliases'|'phaseMeta'|'focus'|'projectMeta'|'lessons'|'orgPolicy'|'meta'|'contractReap'
  value  JSONB NOT NULL,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE IF NOT EXISTS schema_meta (version INT PRIMARY KEY, applied_at BIGINT NOT NULL);
`;

// Keys that MUST round-trip through kv. `proposals`: a denied proposal is a memory the hub refuses
// re-proposals against. `contractReap`: forgetting it re-announces the whole ghost backlog.
export const KV_KEYS = ["verifyGates", "balances", "handoffLog", "aliases", "phaseMeta", "focus",
                        "projectMeta", "lessons", "orgPolicy", "meta", "subagentCostReset", "seq",
                        "proposals", "contractReap"];

// INVARIANTS carried forward from 0.17.54 (docs/CONTRACT-lib.md §store invariants): legacy flat card
// events, `refs[]` on messages, derived threads, monotonic delivery ledger, time-based retention.

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

// Cross-writer change protocol: EVERY writer NOTIFYs this channel after a committed write with
// `{"src":"<writer-id>"}`; the hub LISTENs and reloads its projection on a foreign src.
export const CHANGE_CHANNEL = "trantor_changes";
