// trantor Phase 1 Postgres store.
// Implements the frozen STORE_API from ./store-contract.mjs. The hub still keeps its existing
// in-memory projection while running; this store is the durable backing when RELAY_STORE=pg.
import { SCHEMA_SQL, SCHEMA_VERSION, KV_KEYS, DEFAULT_ORG, CHANGE_CHANNEL } from "./store-contract.mjs";

const asJson = (v, fallback) => (v === undefined ? fallback : v);
const ms = (v, fallback = Date.now()) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const num = (v) => (v == null ? v : Number(v));

const EVENT_COLUMN_KEYS = ["id", "ts", "type", "project", "by", "by_session", "taskId", "task_id", "payload"];
function stripEventPayload(evt = {}) {
  const payload = { ...(evt.payload && typeof evt.payload === "object" ? evt.payload : {}) };
  // The nested payload gets the same treatment as the top level. It used to be copied in wholesale,
  // so a column key riding inside it (an `id` from an imported event) was stored and then clobbered
  // the real column on the way back out.
  for (const k of EVENT_COLUMN_KEYS) delete payload[k];
  for (const [k, v] of Object.entries(evt)) {
    if (EVENT_COLUMN_KEYS.includes(k)) continue;
    payload[k] = v;
  }
  return payload;
}

// The COLUMNS are the truth; the payload is only the fields that have no column. Spreading payload
// LAST let a stored `id` overwrite the row id, and that silently killed the append-only log for 18
// days: 1198 rows (8706..9903 on the production hub) carried a shadow payload id, so on load the
// array tail reported id 4655 instead of 9903, appendEvent then minted 4656 and every insert after
// that hit ON CONFLICT (id) DO NOTHING. Payload first, columns after: a column can never be clobbered.
function eventFromRow(row) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const ev = {
    ...payload,
    id: Number(row.id),
    ts: Number(row.ts),
    type: row.type,
    project: row.project || "",
    by: row.by_session || "",
  };
  if (row.task_id != null) ev.taskId = Number(row.task_id);
  return ev;
}

// Task fields WITH a column. Everything else on a card rides in `extra` — the columns win on
// conflict so a stale extra blob can never shadow projected state.
const TASK_COLUMN_KEYS = new Set([
  "id", "project", "title", "status", "assignee", "source", "difficulty", "model", "phase",
  "costUsd", "cost_usd", "deps", "history", "ts", "created", "updated",
]);

export function taskExtra(t = {}) {
  const extra = {};
  for (const [k, v] of Object.entries(t)) if (!TASK_COLUMN_KEYS.has(k) && v !== undefined) extra[k] = v;
  return extra;
}

function taskFromRow(row) {
  const extra = row.extra && typeof row.extra === "object" ? row.extra : {};
  return {
    ...extra,
    id: Number(row.id),
    project: row.project || "",
    title: row.title || "",
    status: row.status || "todo",
    assignee: row.assignee || "",
    source: row.source || "",
    difficulty: row.difficulty || "",
    model: row.model || "",
    phase: row.phase || "",
    costUsd: row.cost_usd == null ? null : Number(row.cost_usd),
    deps: Array.isArray(row.deps) ? row.deps : [],
    history: Array.isArray(row.history) ? row.history : [],
    ts: row.created == null ? 0 : Number(row.created),
    updated: row.updated == null ? 0 : Number(row.updated),
  };
}

function msgFromRow(row) {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    from: row.from_session || "",
    to: row.to_session || "",
    project: row.project || "",
    text: row.text || "",
    refs: Array.isArray(row.refs) ? row.refs : [],
    // absent rather than 0/null when there is no reply link, so `if (m.re)` reads the same as it
    // does on a message the hub minted this session.
    re: row.re == null ? undefined : Number(row.re),
  };
}

function peerFromRow(row) {
  return {
    session: row.session,
    pubkey: row.pubkey || "",
    project: row.project || "",
    status: row.status || "",
    hookVersion: row.hook_version || "",
    lastSeen: row.last_seen == null ? 0 : Number(row.last_seen),
    online: !!row.online,
    deliveredUpTo: row.delivered_up_to == null ? 0 : Number(row.delivered_up_to),
  };
}

function identityFromRow(row) {
  if (!row) return null;
  return {
    pubkey: row.pubkey,
    orgId: row.org_id || "",
    name: row.name || "",
    kind: row.kind || "agent",
    scopes: row.scopes && typeof row.scopes === "object" ? row.scopes : {},
    enrolledBy: row.enrolled_by || "",
    createdAt: row.created_at == null ? 0 : Number(row.created_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    revoked: row.revoked_at != null,
  };
}

// The kv projection of hub state — shared by saveSnapshot and saveDelta so the two can never drift.
function kvFromState(state) {
  return {
    verifyGates: state.verifyGates || [],
    balances: state.balances || { ts: 0, by: "", entries: [] },
    handoffLog: state.handoffLog || [],
    aliases: state.aliases || {},
    phaseMeta: state.phaseMeta || {},
    focus: state.focus || {},
    projectMeta: state.projectMeta || {},
    lessons: state.lessons || [],
    orgPolicy: state.orgPolicy || {},
    proposals: state.proposals || [],
    contractReap: state.contractReap || {},
    meta: {
      taskSeq: Number(state.taskSeq || 0),
      verifyGateSeq: Number(state.verifyGateSeq || 0),
      proposalSeq: Number(state.proposalSeq || 0),
      cardEventsBackfilled: !!state.cardEventsBackfilled,
      eventSeq: Number(state.eventSeq || 0),
      inviteTokens: state.inviteTokens || {},
      instances: state.instances || {},
    },
    subagentCostReset: !!state.subagentCostReset,
    seq: Number(state.seq || 0),
  };
}

// Diff two entity lists by id: what must be upserted, what must be deleted. Rows the hub has never
// seen (present in NEITHER list — e.g. written by the migration importer or another hub) are
// untouched by construction: that is the property that makes multi-writer safe.
function diffById(prevArr, nextArr, idOf) {
  const prevMap = new Map();
  for (const x of prevArr || []) prevMap.set(idOf(x), JSON.stringify(x));
  const upserts = [];
  const nextIds = new Set();
  for (const x of nextArr || []) {
    const id = idOf(x);
    nextIds.add(id);
    const p = prevMap.get(id);
    if (p === undefined || p !== JSON.stringify(x)) upserts.push(x);
  }
  const deletes = [];
  for (const id of prevMap.keys()) if (!nextIds.has(id)) deletes.push(id);
  return { upserts, deletes };
}

export class PgStore {
  constructor(options = {}) {
    this.url = options.url || process.env.RELAY_DATABASE_URL || process.env.DATABASE_URL || "";
    this.pool = options.pool || null;
    this.ownsPool = !options.pool;
  }

  async init() {
    if (!this.pool) {
      if (!this.url) throw new Error("Postgres store selected but RELAY_DATABASE_URL/DATABASE_URL is not set");
      let mod;
      try { mod = await import("pg"); }
      catch (e) { throw new Error(`Postgres store requires the optional 'pg' package: ${e.message}`); }
      const Pool = mod.Pool || mod.default?.Pool;
      if (!Pool) throw new Error("Postgres store could not load pg.Pool");
      this.pool = new Pool({ connectionString: this.url });
    }
    await this.pool.query(SCHEMA_SQL);
    await this.pool.query(
      "INSERT INTO schema_meta(version, applied_at) VALUES($1,$2) ON CONFLICT(version) DO NOTHING",
      [SCHEMA_VERSION, Date.now()],
    );
    await this.createOrg({ id: DEFAULT_ORG, name: "Local", ownerPubkey: "local-owner" });
  }

  async close() {
    this._closed = true;
    if (this._listenRetry) clearTimeout(this._listenRetry);
    if (this._listenClient) { try { this._listenClient.release(true); } catch {} this._listenClient = null; }
    if (this.pool && this.ownsPool) await this.pool.end();
  }

  async appendEvent(orgId, evt) {
    const r = await this.pool.query(
      `INSERT INTO events(org_id, ts, type, project, by_session, task_id, payload)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
      [
        orgId,
        ms(evt.ts),
        String(evt.type || ""),
        evt.project || "",
        evt.by ?? evt.by_session ?? "",
        evt.taskId ?? evt.task_id ?? null,
        JSON.stringify(stripEventPayload(evt)),
      ],
    );
    return Number(r.rows[0].id);
  }

  async readEvents(orgId, filters = {}) {
    const limit = Math.min(Math.max(Number(filters.limit || 300), 0), 5000);
    const vals = [orgId];
    const where = ["org_id=$1"];
    if (filters.project) { vals.push(filters.project); where.push(`project=$${vals.length}`); }
    if (filters.by) { vals.push(filters.by); where.push(`by_session=$${vals.length}`); }
    if (filters.since) { vals.push(Number(filters.since)); where.push(`id>$${vals.length}`); }
    const types = String(filters.type || "").split(",").map(s => s.trim()).filter(Boolean);
    if (types.length) {
      const parts = [];
      for (const t of types) {
        vals.push(t.endsWith(".") ? `${t}%` : t);
        parts.push(t.endsWith(".") ? `type LIKE $${vals.length}` : `type=$${vals.length}`);
      }
      where.push(`(${parts.join(" OR ")})`);
    }
    if (filters.taskId != null) {
      vals.push(Number(filters.taskId));
      where.push(`(task_id=$${vals.length} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(payload->'refs') AS r(v) WHERE r.v=$${vals.length}::text))`);
    }
    vals.push(limit);
    const r = await this.pool.query(
      `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${vals.length}`,
      vals,
    );
    const events = r.rows.map(eventFromRow).reverse();
    const latest = await this.pool.query("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE org_id=$1", [orgId]);
    return { events, cursor: events.length ? events[events.length - 1].id : Number(filters.since || 0), latest: Number(latest.rows[0].id) };
  }

  async pruneEvents(orgId, olderThanMs) {
    const r = await this.pool.query("DELETE FROM events WHERE org_id=$1 AND ts<$2", [orgId, Number(olderThanMs)]);
    return r.rowCount || 0;
  }

  async upsertTask(orgId, task) {
    await this.pool.query(
      `INSERT INTO tasks(id, org_id, project, title, status, assignee, source, difficulty, model, phase, cost_usd, deps, history, created, updated, extra)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16::jsonb)
       ON CONFLICT(org_id, id) DO UPDATE SET
         project=EXCLUDED.project, title=EXCLUDED.title, status=EXCLUDED.status, assignee=EXCLUDED.assignee,
         source=EXCLUDED.source, difficulty=EXCLUDED.difficulty, model=EXCLUDED.model, phase=EXCLUDED.phase,
         cost_usd=EXCLUDED.cost_usd, deps=EXCLUDED.deps, history=EXCLUDED.history, created=EXCLUDED.created, updated=EXCLUDED.updated, extra=EXCLUDED.extra`,
      [
        Number(task.id), orgId, task.project || "", task.title || "", task.status || "todo",
        task.assignee || "", task.source || "", task.difficulty || "", task.model || "", task.phase || "",
        typeof task.costUsd === "number" ? task.costUsd : null,
        JSON.stringify(Array.isArray(task.deps) ? task.deps : []),
        JSON.stringify(Array.isArray(task.history) ? task.history : []),
        ms(task.ts || task.created, 0), ms(task.updated || task.ts, 0), JSON.stringify(taskExtra(task)),
      ],
    );
  }

  async readTasks(orgId, filters = {}) {
    const vals = [orgId];
    const where = ["org_id=$1"];
    if (filters.project) { vals.push(filters.project); where.push(`project=$${vals.length}`); }
    if (filters.status) { vals.push(filters.status); where.push(`status=$${vals.length}`); }
    const r = await this.pool.query(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY id ASC`, vals);
    return r.rows.map(taskFromRow);
  }

  async appendMessage(orgId, msg) {
    const refs = Array.isArray(msg.refs) ? msg.refs : [];
    const r = await this.pool.query(
      `WITH next_id AS (SELECT COALESCE(MAX(id),0)+1 AS id FROM messages WHERE org_id=$1)
       INSERT INTO messages(id, org_id, ts, from_session, to_session, project, text, refs, re)
       SELECT id, $1, $2, $3, $4, $5, $6, $7::jsonb, $8 FROM next_id RETURNING id`,
      [orgId, ms(msg.ts), msg.from || msg.from_session || "anon", msg.to || msg.to_session || "all", msg.project || "", String(msg.text ?? ""), JSON.stringify(refs), Number(msg.re) > 0 ? Number(msg.re) : null],
    );
    return Number(r.rows[0].id);
  }

  async readInbox(orgId, session, since = 0, options = {}) {
    const r = await this.pool.query(
      `SELECT * FROM messages
       WHERE org_id=$1 AND id>$2 AND (to_session=$3 OR to_session='all') AND from_session<>$3
       ORDER BY id ASC`,
      [orgId, Number(since || 0), session],
    );
    const messages = r.rows.map(msgFromRow);
    const cursor = messages.length ? messages[messages.length - 1].id : Number(since || 0);
    if (!options.peek) await this.markDelivered(orgId, session, cursor);
    return { messages, cursor };
  }

  async markDelivered(orgId, session, upTo) {
    const n = Number(upTo || 0);
    if (!session || !n) return;
    await this.pool.query(
      `INSERT INTO peers(session, org_id, last_seen, delivered_up_to)
       VALUES($1,$2,0,$3)
       ON CONFLICT(org_id, session) DO UPDATE SET delivered_up_to=GREATEST(peers.delivered_up_to, EXCLUDED.delivered_up_to)`,
      [session, orgId, n],
    );
  }

  async touchPeer(orgId, session, patch = {}) {
    if (!session || session === "all") return;
    await this.pool.query(
      `INSERT INTO peers(session, org_id, pubkey, project, status, hook_version, last_seen, online, delivered_up_to)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(org_id, session) DO UPDATE SET
         pubkey=COALESCE(EXCLUDED.pubkey, peers.pubkey),
         project=COALESCE(NULLIF(EXCLUDED.project,''), peers.project),
         status=COALESCE(EXCLUDED.status, peers.status),
         hook_version=COALESCE(NULLIF(EXCLUDED.hook_version,''), peers.hook_version),
         last_seen=EXCLUDED.last_seen,
         online=EXCLUDED.online,
         delivered_up_to=GREATEST(peers.delivered_up_to, EXCLUDED.delivered_up_to)`,
      [
        session, orgId, patch.pubkey || null, patch.project || "", patch.status ?? null,
        patch.hookVersion || patch.hook_version || "", ms(patch.lastSeen || patch.last_seen),
        patch.online ?? true, Number(patch.deliveredUpTo || patch.delivered_up_to || 0),
      ],
    );
  }

  async readPeers(orgId) {
    const r = await this.pool.query("SELECT * FROM peers WHERE org_id=$1 ORDER BY session ASC", [orgId]);
    return r.rows.map(peerFromRow);
  }

  async readPeer(orgId, session) {
    const r = await this.pool.query("SELECT * FROM peers WHERE org_id=$1 AND session=$2", [orgId, session]);
    return r.rows[0] ? peerFromRow(r.rows[0]) : null;
  }

  async getKV(orgId, key) {
    const r = await this.pool.query("SELECT value FROM kv WHERE org_id=$1 AND key=$2", [orgId, key]);
    return r.rows[0]?.value ?? null;
  }

  async setKV(orgId, key, value) {
    await this.pool.query(
      `INSERT INTO kv(org_id, key, value) VALUES($1,$2,$3::jsonb)
       ON CONFLICT(org_id, key) DO UPDATE SET value=EXCLUDED.value`,
      [orgId, key, JSON.stringify(value ?? null)],
    );
  }

  async upsertIdentity(orgId, identity) {
    await this.pool.query(
      `INSERT INTO identities(pubkey, org_id, name, kind, scopes, enrolled_by, created_at, revoked_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       ON CONFLICT(pubkey) DO UPDATE SET
         org_id=EXCLUDED.org_id, name=EXCLUDED.name, kind=EXCLUDED.kind, scopes=EXCLUDED.scopes,
         enrolled_by=EXCLUDED.enrolled_by, revoked_at=EXCLUDED.revoked_at`,
      [
        identity.pubkey, orgId, identity.name || identity.pubkey, identity.kind || "agent",
        JSON.stringify(identity.scopes || {}), identity.enrolledBy || identity.enrolled_by || "",
        ms(identity.createdAt || identity.created_at), identity.revokedAt || identity.revoked_at || null,
      ],
    );
  }

  async readIdentity(pubkey) {
    const r = await this.pool.query("SELECT * FROM identities WHERE pubkey=$1", [pubkey]);
    return identityFromRow(r.rows[0]);
  }

  async createOrg({ id, name, ownerPubkey }) {
    await this.pool.query(
      "INSERT INTO orgs(id, name, owner_pubkey, created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
      [id, name || id, ownerPubkey || "", Date.now()],
    );
  }

  async addMember(orgId, pubkey, role) {
    await this.pool.query(
      `INSERT INTO org_members(org_id, pubkey, role, added_at) VALUES($1,$2,$3,$4)
       ON CONFLICT(org_id, pubkey) DO UPDATE SET role=EXCLUDED.role`,
      [orgId, pubkey, ["owner", "admin", "member"].includes(role) ? role : "member", Date.now()],
    );
  }

  async readOrgOf(pubkey) {
    const r = await this.pool.query(
      "SELECT org_id, role FROM org_members WHERE pubkey=$1 ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END LIMIT 1",
      [pubkey],
    );
    return r.rows[0] ? { orgId: r.rows[0].org_id, role: r.rows[0].role } : null;
  }

  async saveSnapshot(orgId, state) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM tasks WHERE org_id=$1", [orgId]);
      await c.query("DELETE FROM events WHERE org_id=$1", [orgId]);
      await c.query("DELETE FROM messages WHERE org_id=$1", [orgId]);
      await c.query("DELETE FROM peers WHERE org_id=$1", [orgId]);
      for (const t of state.tasks || []) {
        await c.query(
          `INSERT INTO tasks(id, org_id, project, title, status, assignee, source, difficulty, model, phase, cost_usd, deps, history, created, updated, extra)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16::jsonb)
           ON CONFLICT(org_id, id) DO UPDATE SET
             project=EXCLUDED.project, title=EXCLUDED.title, status=EXCLUDED.status, assignee=EXCLUDED.assignee,
             source=EXCLUDED.source, difficulty=EXCLUDED.difficulty, model=EXCLUDED.model, phase=EXCLUDED.phase,
             cost_usd=EXCLUDED.cost_usd, deps=EXCLUDED.deps, history=EXCLUDED.history, created=EXCLUDED.created, updated=EXCLUDED.updated, extra=EXCLUDED.extra`,
          [
            Number(t.id), orgId, t.project || "", t.title || "", t.status || "todo",
            t.assignee || "", t.source || "", t.difficulty || "", t.model || "", t.phase || "",
            typeof t.costUsd === "number" ? t.costUsd : null,
            JSON.stringify(Array.isArray(t.deps) ? t.deps : []),
            JSON.stringify(Array.isArray(t.history) ? t.history : []),
            ms(t.ts || t.created, 0), ms(t.updated || t.ts, 0), JSON.stringify(taskExtra(t)),
          ],
        );
      }
      await c.query(
        "DELETE FROM tasks WHERE org_id=$1 AND NOT (id = ANY($2::bigint[]))",
        [orgId, (state.tasks || []).map(t => Number(t.id)).filter(Number.isFinite)],
      );
      for (const e of state.events || []) {
        await c.query(
          `INSERT INTO events(id, org_id, ts, type, project, by_session, task_id, payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT(id) DO NOTHING`,
          [Number(e.id), orgId, ms(e.ts), e.type || "", e.project || "", e.by || "", e.taskId ?? null, JSON.stringify(stripEventPayload(e))],
        );
      }
      await c.query(
        "DELETE FROM events WHERE org_id=$1 AND NOT (id = ANY($2::bigint[]))",
        [orgId, (state.events || []).map(e => Number(e.id)).filter(Number.isFinite)],
      );
      await c.query("SELECT setval(pg_get_serial_sequence('events','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM events), 1), true)");
      for (const m of state.messages || []) {
        await c.query(
          `INSERT INTO messages(id, org_id, ts, from_session, to_session, project, text, refs, re)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
           ON CONFLICT(org_id, id) DO UPDATE SET ts=EXCLUDED.ts, from_session=EXCLUDED.from_session, to_session=EXCLUDED.to_session,
             project=EXCLUDED.project, text=EXCLUDED.text, refs=EXCLUDED.refs, re=EXCLUDED.re`,
          [Number(m.id), orgId, ms(m.ts), m.from || "anon", m.to || "all", m.project || "", String(m.text ?? ""), JSON.stringify(Array.isArray(m.refs) ? m.refs : []), Number(m.re) > 0 ? Number(m.re) : null],
        );
      }
      await c.query(
        "DELETE FROM messages WHERE org_id=$1 AND NOT (id = ANY($2::bigint[]))",
        [orgId, (state.messages || []).map(m => Number(m.id)).filter(Number.isFinite)],
      );
      for (const [session, p] of Object.entries(state.peers || {})) {
        await c.query(
          `INSERT INTO peers(session, org_id, pubkey, project, status, hook_version, last_seen, online, delivered_up_to)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(org_id, session) DO UPDATE SET pubkey=EXCLUDED.pubkey, project=EXCLUDED.project, status=EXCLUDED.status,
             hook_version=EXCLUDED.hook_version, last_seen=EXCLUDED.last_seen, online=EXCLUDED.online, delivered_up_to=GREATEST(peers.delivered_up_to, EXCLUDED.delivered_up_to)`,
          [session, orgId, p.pubkey || "", p.project || "", p.status || "", p.hookVersion || "", Number(p.lastSeen || 0), p._on === true || p.online === true, Number(p.deliveredUpTo || 0)],
        );
      }
      await c.query(
        "DELETE FROM peers WHERE org_id=$1 AND NOT (session = ANY($2::text[]))",
        [orgId, Object.keys(state.peers || {})],
      );
      for (const id of Object.values(state.identities || {})) {
        await c.query(
          `INSERT INTO identities(pubkey, org_id, name, kind, scopes, enrolled_by, created_at, revoked_at)
           VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
           ON CONFLICT(pubkey) DO UPDATE SET
             org_id=EXCLUDED.org_id, name=EXCLUDED.name, kind=EXCLUDED.kind, scopes=EXCLUDED.scopes,
             enrolled_by=EXCLUDED.enrolled_by, revoked_at=EXCLUDED.revoked_at`,
          [
            id.pubkey, orgId, id.name || id.pubkey, id.kind || "agent",
            JSON.stringify(id.scopes || {}), id.enrolledBy || id.enrolled_by || "",
            ms(id.createdAt || id.created_at), id.revokedAt || id.revoked_at || null,
          ],
        );
      }
      const kv = kvFromState(state);
      for (const key of KV_KEYS) {
        await c.query(
          `INSERT INTO kv(org_id, key, value) VALUES($1,$2,$3::jsonb)
           ON CONFLICT(org_id, key) DO UPDATE SET value=EXCLUDED.value`,
          [orgId, key, JSON.stringify(kv[key] ?? null)],
        );
      }
      await c.query("COMMIT");
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      c.release();
    }
  }

  // Incremental persist: write only what changed between two snapshots of hub state.
  // WHY THIS EXISTS (the boot-cache blocker): saveSnapshot deletes the org's rows wholesale and
  // rewrites them from hub memory — so any row a second writer added is silently destroyed on the
  // next dirty tick, and at steady state the remote hub was rewriting every event/task/message row
  // once per second. saveDelta touches ONLY rows the hub itself has seen (see diffById), which is
  // what makes an external writer (importer, admin psql, a second hub) survivable.
  // Events stay append-only: INSERT ... ON CONFLICT DO NOTHING — the hub never edits an event, and
  // an id collision with an external writer must not clobber the external row.
  // Emits NOTIFY on CHANGE_CHANNEL inside the transaction (delivered on commit) so other hubs
  // reload; `src` lets a hub ignore its own notifications.
  async saveDelta(orgId, prev, next, { src = "" } = {}) {
    prev = prev || {};
    const tasks = diffById(prev.tasks, next.tasks, t => Number(t.id));
    const events = diffById(prev.events, next.events, e => Number(e.id));
    const messages = diffById(prev.messages, next.messages, m => Number(m.id));
    const peers = diffById(
      Object.entries(prev.peers || {}).map(([session, p]) => ({ session, ...p })),
      Object.entries(next.peers || {}).map(([session, p]) => ({ session, ...p })),
      p => p.session,
    );
    const identities = diffById(Object.values(prev.identities || {}), Object.values(next.identities || {}), i => i.pubkey);
    const prevKv = kvFromState(prev), nextKv = kvFromState(next);
    const kvChanged = KV_KEYS.filter(k => JSON.stringify(prevKv[k] ?? null) !== JSON.stringify(nextKv[k] ?? null));

    const changed = tasks.upserts.length + tasks.deletes.length + events.upserts.length + events.deletes.length
      + messages.upserts.length + messages.deletes.length + peers.upserts.length + peers.deletes.length
      + identities.upserts.length + kvChanged.length;
    if (!changed) return 0;

    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      for (const t of tasks.upserts) {
        await c.query(
          `INSERT INTO tasks(id, org_id, project, title, status, assignee, source, difficulty, model, phase, cost_usd, deps, history, created, updated, extra)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16::jsonb)
           ON CONFLICT(org_id, id) DO UPDATE SET
             project=EXCLUDED.project, title=EXCLUDED.title, status=EXCLUDED.status, assignee=EXCLUDED.assignee,
             source=EXCLUDED.source, difficulty=EXCLUDED.difficulty, model=EXCLUDED.model, phase=EXCLUDED.phase,
             cost_usd=EXCLUDED.cost_usd, deps=EXCLUDED.deps, history=EXCLUDED.history, created=EXCLUDED.created, updated=EXCLUDED.updated, extra=EXCLUDED.extra`,
          [
            Number(t.id), orgId, t.project || "", t.title || "", t.status || "todo",
            t.assignee || "", t.source || "", t.difficulty || "", t.model || "", t.phase || "",
            typeof t.costUsd === "number" ? t.costUsd : null,
            JSON.stringify(Array.isArray(t.deps) ? t.deps : []),
            JSON.stringify(Array.isArray(t.history) ? t.history : []),
            ms(t.ts || t.created, 0), ms(t.updated || t.ts, 0), JSON.stringify(taskExtra(t)),
          ],
        );
      }
      if (tasks.deletes.length) await c.query("DELETE FROM tasks WHERE org_id=$1 AND id = ANY($2::bigint[])", [orgId, tasks.deletes]);
      for (const e of events.upserts) {
        const r = await c.query(
          `INSERT INTO events(id, org_id, ts, type, project, by_session, task_id, payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [Number(e.id), orgId, ms(e.ts), e.type || "", e.project || "", e.by || "", e.taskId ?? null, JSON.stringify(stripEventPayload(e))],
        );
        // DO NOTHING protects a foreign row, but it also swallows a REAL append when the id collides.
        // That is what hid the dead log for 18 days: every event was dropped and nothing said a word.
        // A conflict here is never routine, so say so.
        if (r?.rowCount === 0) {
          this.onDroppedEvent?.({ id: Number(e.id), type: e.type || "", orgId });
        }
      }
      if (events.deletes.length) await c.query("DELETE FROM events WHERE org_id=$1 AND id = ANY($2::bigint[])", [orgId, events.deletes]);
      if (events.upserts.length) await c.query("SELECT setval(pg_get_serial_sequence('events','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM events), 1), true)");
      for (const m of messages.upserts) {
        await c.query(
          `INSERT INTO messages(id, org_id, ts, from_session, to_session, project, text, refs, re)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
           ON CONFLICT (org_id, id) DO UPDATE SET ts=EXCLUDED.ts, from_session=EXCLUDED.from_session, to_session=EXCLUDED.to_session,
             project=EXCLUDED.project, text=EXCLUDED.text, refs=EXCLUDED.refs, re=EXCLUDED.re`,
          [Number(m.id), orgId, ms(m.ts), m.from || "anon", m.to || "all", m.project || "", String(m.text ?? ""), JSON.stringify(Array.isArray(m.refs) ? m.refs : []), Number(m.re) > 0 ? Number(m.re) : null],
        );
      }
      if (messages.deletes.length) await c.query("DELETE FROM messages WHERE org_id=$1 AND id = ANY($2::bigint[])", [orgId, messages.deletes]);
      for (const p of peers.upserts) {
        await c.query(
          `INSERT INTO peers(session, org_id, pubkey, project, status, hook_version, last_seen, online, delivered_up_to)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(org_id, session) DO UPDATE SET pubkey=EXCLUDED.pubkey, project=EXCLUDED.project, status=EXCLUDED.status,
             hook_version=EXCLUDED.hook_version, last_seen=EXCLUDED.last_seen, online=EXCLUDED.online, delivered_up_to=GREATEST(peers.delivered_up_to, EXCLUDED.delivered_up_to)`,
          [p.session, orgId, p.pubkey || "", p.project || "", p.status || "", p.hookVersion || "", Number(p.lastSeen || 0), p._on === true || p.online === true, Number(p.deliveredUpTo || 0)],
        );
      }
      if (peers.deletes.length) await c.query("DELETE FROM peers WHERE org_id=$1 AND session = ANY($2::text[])", [orgId, peers.deletes]);
      for (const id of identities.upserts) {
        await c.query(
          `INSERT INTO identities(pubkey, org_id, name, kind, scopes, enrolled_by, created_at, revoked_at)
           VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
           ON CONFLICT(pubkey) DO UPDATE SET
             org_id=EXCLUDED.org_id, name=EXCLUDED.name, kind=EXCLUDED.kind, scopes=EXCLUDED.scopes,
             enrolled_by=EXCLUDED.enrolled_by, revoked_at=EXCLUDED.revoked_at`,
          [
            id.pubkey, orgId, id.name || id.pubkey, id.kind || "agent",
            JSON.stringify(id.scopes || {}), id.enrolledBy || id.enrolled_by || "",
            ms(id.createdAt || id.created_at), id.revokedAt || id.revoked_at || null,
          ],
        );
      }
      for (const key of kvChanged) {
        await c.query(
          `INSERT INTO kv(org_id, key, value) VALUES($1,$2,$3::jsonb)
           ON CONFLICT(org_id, key) DO UPDATE SET value=EXCLUDED.value`,
          [orgId, key, JSON.stringify(nextKv[key] ?? null)],
        );
      }
      await c.query("SELECT pg_notify($1, $2)", [CHANGE_CHANNEL, JSON.stringify({ src, orgId })]);
      await c.query("COMMIT");
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      c.release();
    }
    return changed;
  }

  // LISTEN on the change channel with a dedicated connection. `handler` receives the parsed
  // NOTIFY payload ({src, orgId}). Reconnects with backoff if the connection drops — a hub that
  // silently stops listening is a hub that silently goes stale again.
  async subscribeChanges(handler) {
    const connect = async () => {
      const c = await this.pool.connect();
      this._listenClient = c;
      c.on("notification", (n) => {
        let payload = {};
        try { payload = JSON.parse(n.payload || "{}"); } catch {}
        try { handler(payload); } catch {}
      });
      const onDrop = () => {
        if (this._listenClient !== c) return;
        this._listenClient = null;
        try { c.release(true); } catch {}
        if (!this._closed) this._listenRetry = setTimeout(() => connect().catch(() => {}), 5000);
      };
      c.once("error", onDrop);
      c.once("end", onDrop);
      await c.query(`LISTEN ${CHANGE_CHANNEL}`);
    };
    await connect();
  }

  // For writers that mutate the store outside saveDelta (the importer, admin scripts).
  async notifyChanges(src = "") {
    await this.pool.query("SELECT pg_notify($1, $2)", [CHANGE_CHANNEL, JSON.stringify({ src })]);
  }

  async loadSnapshot(orgId) {
    const [tasks, peersRows, eventsRows, messagesRows, identitiesRows, kvRows, eventMaxRow] = await Promise.all([
      this.pool.query("SELECT * FROM tasks WHERE org_id=$1 ORDER BY id ASC", [orgId]),
      this.pool.query("SELECT * FROM peers WHERE org_id=$1 ORDER BY session ASC", [orgId]),
      this.pool.query("SELECT * FROM events WHERE org_id=$1 ORDER BY id ASC", [orgId]),
      this.pool.query("SELECT * FROM messages WHERE org_id=$1 ORDER BY id ASC", [orgId]),
      this.pool.query("SELECT * FROM identities WHERE org_id=$1 ORDER BY created_at ASC", [orgId]),
      this.pool.query("SELECT key, value FROM kv WHERE org_id=$1", [orgId]),
      // The authoritative high-water mark for event ids. Deriving it from the loaded array is what
      // broke: a clobbered tail reported a lower id than the table actually held. Ask the table.
      // Deliberately NOT scoped to org: the events primary key is (id) alone, so the id space is
      // global and a per-org max would still collide across orgs.
      this.pool.query("SELECT COALESCE(MAX(id),0) AS max_id FROM events"),
    ]);
    const kv = Object.fromEntries(kvRows.rows.map(r => [r.key, r.value]));
    const peers = {};
    for (const row of peersRows.rows) {
      const p = peerFromRow(row);
      peers[p.session] = { ...p, _on: p.online };
      delete peers[p.session].session;
      delete peers[p.session].online;
    }
    const identities = {};
    for (const row of identitiesRows.rows) {
      const id = identityFromRow(row);
      identities[id.pubkey] = id;
    }
    const meta = kv.meta && typeof kv.meta === "object" ? kv.meta : {};
    const verifyGates = Array.isArray(kv.verifyGates) ? kv.verifyGates : [];
    const proposals = Array.isArray(kv.proposals) ? kv.proposals : [];
    return {
      messages: messagesRows.rows.map(msgFromRow),
      peers,
      seq: Number(kv.seq || Math.max(0, ...messagesRows.rows.map(r => Number(r.id)))) || 0,
      tasks: tasks.rows.map(taskFromRow),
      taskSeq: Number(meta.taskSeq || Math.max(0, ...tasks.rows.map(r => Number(r.id)))) || 0,
      projectMeta: kv.projectMeta && typeof kv.projectMeta === "object" ? kv.projectMeta : {},
      lessons: Array.isArray(kv.lessons) ? kv.lessons : [],
      events: eventsRows.rows.map(eventFromRow),
      cardEventsBackfilled: !!meta.cardEventsBackfilled,
      aliases: kv.aliases && typeof kv.aliases === "object" ? kv.aliases : {},
      phaseMeta: kv.phaseMeta && typeof kv.phaseMeta === "object" ? kv.phaseMeta : {},
      verifyGates,
      verifyGateSeq: Number(meta.verifyGateSeq || Math.max(0, ...verifyGates.map(g => Number(g.id)))) || 0,
      proposals,
      proposalSeq: Number(meta.proposalSeq || Math.max(0, ...proposals.map(p => Number(p.id)))) || 0,
      balances: kv.balances && typeof kv.balances === "object" ? kv.balances : { ts: 0, by: "", entries: [] },
      subagentCostReset: !!kv.subagentCostReset,
      handoffLog: Array.isArray(kv.handoffLog) ? kv.handoffLog : [],
      identities,
      inviteTokens: meta.inviteTokens && typeof meta.inviteTokens === "object" ? meta.inviteTokens : {},
      instances: meta.instances && typeof meta.instances === "object" ? meta.instances : {},
      focus: kv.focus && typeof kv.focus === "object" ? kv.focus : {},
      orgPolicy: kv.orgPolicy && typeof kv.orgPolicy === "object" ? kv.orgPolicy : {},
      contractReap: kv.contractReap && typeof kv.contractReap === "object" ? kv.contractReap : {},
      eventSeq: Math.max(Number(eventMaxRow?.rows?.[0]?.max_id || 0), Number(meta.eventSeq || 0)),
    };
  }
}

export function createPgStore(options = {}) {
  return new PgStore(options);
}

export default createPgStore;
