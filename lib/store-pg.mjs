// trantor Phase 1 Postgres store.
// Implements the frozen STORE_API from ./store-contract.mjs. The hub still keeps its existing
// in-memory projection while running; this store is the durable backing when RELAY_STORE=pg.
import { SCHEMA_SQL, SCHEMA_VERSION, KV_KEYS, DEFAULT_ORG } from "./store-contract.mjs";

const asJson = (v, fallback) => (v === undefined ? fallback : v);
const ms = (v, fallback = Date.now()) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const num = (v) => (v == null ? v : Number(v));

function stripEventPayload(evt = {}) {
  const payload = { ...(evt.payload && typeof evt.payload === "object" ? evt.payload : {}) };
  for (const [k, v] of Object.entries(evt)) {
    if (["id", "ts", "type", "project", "by", "by_session", "taskId", "task_id", "payload"].includes(k)) continue;
    payload[k] = v;
  }
  return payload;
}

function eventFromRow(row) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const ev = {
    id: Number(row.id),
    ts: Number(row.ts),
    type: row.type,
    project: row.project || "",
    by: row.by_session || "",
    ...payload,
  };
  if (row.task_id != null) ev.taskId = Number(row.task_id);
  return ev;
}

function taskFromRow(row) {
  return {
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
      `INSERT INTO tasks(id, org_id, project, title, status, assignee, source, difficulty, model, phase, cost_usd, deps, history, created, updated)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)
       ON CONFLICT(org_id, id) DO UPDATE SET
         project=EXCLUDED.project, title=EXCLUDED.title, status=EXCLUDED.status, assignee=EXCLUDED.assignee,
         source=EXCLUDED.source, difficulty=EXCLUDED.difficulty, model=EXCLUDED.model, phase=EXCLUDED.phase,
         cost_usd=EXCLUDED.cost_usd, deps=EXCLUDED.deps, history=EXCLUDED.history, created=EXCLUDED.created, updated=EXCLUDED.updated`,
      [
        Number(task.id), orgId, task.project || "", task.title || "", task.status || "todo",
        task.assignee || "", task.source || "", task.difficulty || "", task.model || "", task.phase || "",
        typeof task.costUsd === "number" ? task.costUsd : null,
        JSON.stringify(Array.isArray(task.deps) ? task.deps : []),
        JSON.stringify(Array.isArray(task.history) ? task.history : []),
        ms(task.ts || task.created, 0), ms(task.updated || task.ts, 0),
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
       INSERT INTO messages(id, org_id, ts, from_session, to_session, project, text, refs)
       SELECT id, $1, $2, $3, $4, $5, $6, $7::jsonb FROM next_id RETURNING id`,
      [orgId, ms(msg.ts), msg.from || msg.from_session || "anon", msg.to || msg.to_session || "all", msg.project || "", String(msg.text ?? ""), JSON.stringify(refs)],
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
          `INSERT INTO tasks(id, org_id, project, title, status, assignee, source, difficulty, model, phase, cost_usd, deps, history, created, updated)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)
           ON CONFLICT(org_id, id) DO UPDATE SET
             project=EXCLUDED.project, title=EXCLUDED.title, status=EXCLUDED.status, assignee=EXCLUDED.assignee,
             source=EXCLUDED.source, difficulty=EXCLUDED.difficulty, model=EXCLUDED.model, phase=EXCLUDED.phase,
             cost_usd=EXCLUDED.cost_usd, deps=EXCLUDED.deps, history=EXCLUDED.history, created=EXCLUDED.created, updated=EXCLUDED.updated`,
          [
            Number(t.id), orgId, t.project || "", t.title || "", t.status || "todo",
            t.assignee || "", t.source || "", t.difficulty || "", t.model || "", t.phase || "",
            typeof t.costUsd === "number" ? t.costUsd : null,
            JSON.stringify(Array.isArray(t.deps) ? t.deps : []),
            JSON.stringify(Array.isArray(t.history) ? t.history : []),
            ms(t.ts || t.created, 0), ms(t.updated || t.ts, 0),
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
          `INSERT INTO messages(id, org_id, ts, from_session, to_session, project, text, refs)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT(org_id, id) DO UPDATE SET ts=EXCLUDED.ts, from_session=EXCLUDED.from_session, to_session=EXCLUDED.to_session,
             project=EXCLUDED.project, text=EXCLUDED.text, refs=EXCLUDED.refs`,
          [Number(m.id), orgId, ms(m.ts), m.from || "anon", m.to || "all", m.project || "", String(m.text ?? ""), JSON.stringify(Array.isArray(m.refs) ? m.refs : [])],
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
      const kv = {
        verifyGates: state.verifyGates || [],
        balances: state.balances || { ts: 0, by: "", entries: [] },
        handoffLog: state.handoffLog || [],
        aliases: state.aliases || {},
        phaseMeta: state.phaseMeta || {},
        focus: state.focus || {},
        projectMeta: state.projectMeta || {},
        lessons: state.lessons || [],
        orgPolicy: state.orgPolicy || {},
        meta: {
          taskSeq: Number(state.taskSeq || 0),
          verifyGateSeq: Number(state.verifyGateSeq || 0),
          cardEventsBackfilled: !!state.cardEventsBackfilled,
          inviteTokens: state.inviteTokens || {},
        },
        subagentCostReset: !!state.subagentCostReset,
        seq: Number(state.seq || 0),
      };
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

  async loadSnapshot(orgId) {
    const [tasks, peersRows, eventsRows, messagesRows, identitiesRows, kvRows] = await Promise.all([
      this.pool.query("SELECT * FROM tasks WHERE org_id=$1 ORDER BY id ASC", [orgId]),
      this.pool.query("SELECT * FROM peers WHERE org_id=$1 ORDER BY session ASC", [orgId]),
      this.pool.query("SELECT * FROM events WHERE org_id=$1 ORDER BY id ASC", [orgId]),
      this.pool.query("SELECT * FROM messages WHERE org_id=$1 ORDER BY id ASC", [orgId]),
      this.pool.query("SELECT * FROM identities WHERE org_id=$1 ORDER BY created_at ASC", [orgId]),
      this.pool.query("SELECT key, value FROM kv WHERE org_id=$1", [orgId]),
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
      balances: kv.balances && typeof kv.balances === "object" ? kv.balances : { ts: 0, by: "", entries: [] },
      subagentCostReset: !!kv.subagentCostReset,
      handoffLog: Array.isArray(kv.handoffLog) ? kv.handoffLog : [],
      identities,
      inviteTokens: meta.inviteTokens && typeof meta.inviteTokens === "object" ? meta.inviteTokens : {},
      focus: kv.focus && typeof kv.focus === "object" ? kv.focus : {},
      orgPolicy: kv.orgPolicy && typeof kv.orgPolicy === "object" ? kv.orgPolicy : {},
    };
  }
}

export function createPgStore(options = {}) {
  return new PgStore(options);
}

export default createPgStore;
