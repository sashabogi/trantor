#!/usr/bin/env node
import http from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertNoSecrets } from "./lib/scrub.mjs";
import { DEFAULT_ORG } from "./lib/store-contract.mjs";
import { createStoreRuntime } from "./hub/store.mjs";
import { createAuthRuntime } from "./hub/auth.mjs";
import { createEventRuntime } from "./hub/events.mjs";
import { createReaper } from "./hub/reaper.mjs";
import { createDuty } from "./hub/duty.mjs";
import { createOverseer } from "./hub/overseer.mjs";
import { runStoreMigrations } from "./hub/migrations.mjs";
import { derivePhases } from "./hub/phases.mjs";
import { routeAdmin } from "./hub/routes/admin.mjs";
import { routeCards } from "./hub/routes/cards.mjs";
import { routeInsights } from "./hub/routes/insights.mjs";
import { routeMessages } from "./hub/routes/messages.mjs";

const PORT = Number(process.env.RELAY_PORT || 4477);
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const DATA_DIR = process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");
const DATA = process.env.RELAY_STATE || join(DATA_DIR, "bus.json");
const RAW_STORE_KIND = String(process.env.RELAY_STORE || "").toLowerCase();
const PG_URL = process.env.RELAY_DATABASE_URL || process.env.POSTGRES_URL ||
  ((RAW_STORE_KIND === "pg" || RAW_STORE_KIND === "postgres") ? process.env.DATABASE_URL : "");
const STORE_KIND = RAW_STORE_KIND || (PG_URL ? "pg" : "json");
const ORG_ID = process.env.RELAY_ORG_ID || DEFAULT_ORG;
const AUTH_MODE = ["off", "warn", "enforce"].includes(process.env.RELAY_AUTH) ? process.env.RELAY_AUTH : "warn";
const ENROLL_MODE = process.env.RELAY_ENROLL || "tofu";
const ONLINE_MS = Number(process.env.RELAY_ONLINE_MS || 5 * 60 * 1000);
const PEER_TTL_DEFAULT_MS = 21600000;
const peerTtlRaw = Number(process.env.RELAY_PEER_TTL_MS || PEER_TTL_DEFAULT_MS);
const PEER_TTL_MS = Math.max(Number.isFinite(peerTtlRaw) ? peerTtlRaw : PEER_TTL_DEFAULT_MS, ONLINE_MS);
const REAP_GRACE_MS = Number(process.env.RELAY_REAP_GRACE_MS || 15 * 60 * 1000);
const SUPERSEDE_GRACE_MS = Number(process.env.RELAY_SUPERSEDE_GRACE_MS || REAP_GRACE_MS);
const TODO_STALE_DEFAULT_MS = 14 * 24 * 60 * 60 * 1000;
const TODO_STALE_MS = Number.isFinite(Number(process.env.RELAY_TODO_STALE_MS))
  ? Math.max(0, Number(process.env.RELAY_TODO_STALE_MS)) : TODO_STALE_DEFAULT_MS;
const FOCUS_OFFLINE_MS = Number(process.env.RELAY_FOCUS_OFFLINE_MS || ONLINE_MS);
const FOCUS_IDLE_MS = Number(process.env.RELAY_FOCUS_IDLE_MS || 6 * 60 * 60 * 1000);
const REAP_INTERVAL_MS = Number(process.env.RELAY_REAP_INTERVAL_MS || 60000);
const CONTRACT_ABANDON_MS = Number(process.env.RELAY_CONTRACT_ABANDON_MS || 60 * 60 * 1000);
const CONTRACT_WINDOW_MS = Number(process.env.RELAY_CONTRACT_WINDOW_MS || 24 * 60 * 60 * 1000);
const OVERSEER_TICK_MS = Number(process.env.RELAY_OVERSEER_TICK_MS || 30 * 1000);

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const hostName = String(HOST || "").toLowerCase();
const LOOPBACK_BIND = hostName === "localhost" || hostName === "::1" || hostName === "[::1]" || hostName.startsWith("127.");
if (!LOOPBACK_BIND && AUTH_MODE !== "enforce") {
  process.stderr.write(`[trantor] refusing non-loopback bind ${HOST}:${PORT} with RELAY_AUTH=${AUTH_MODE}; use RELAY_AUTH=enforce\n`);
  process.exit(1);
}

const store = await createStoreRuntime({ STORE_KIND, PG_URL, ORG_ID, DATA });
const authRuntime = createAuthRuntime({
  state: store.state, markDirty: store.markDirty, AUTH_MODE, SUPERSEDE_GRACE_MS,
  LOOPBACK_BIND, ENROLL_MODE,
});
const events = createEventRuntime({ state: store.state, markDirty: store.markDirty, AUTH_MODE, ONLINE_MS, canon: authRuntime.canon });
runStoreMigrations({ ...store, subFp: authRuntime.subFp });
if (process.argv.includes("--smoke")) {
  await store.durableStore?.close?.();
  process.stderr.write(`[trantor] hub smoke ok (store: ${STORE_KIND})\n`);
  process.exit(0);
}
const reaper = createReaper({
  state: store.state, markDirty: store.markDirty, canon: authRuntime.canon,
  now: events.now, appendCardEvent: events.appendCardEvent, appendEvent: events.appendEvent,
  appendTaskLog: store.appendTaskLog, sweepPresence: events.sweepPresence, ONLINE_MS, PEER_TTL_MS, FOCUS_OFFLINE_MS,
  FOCUS_IDLE_MS, REAP_GRACE_MS, TODO_STALE_MS, REAP_INTERVAL_MS,
  CONTRACT_ABANDON_MS, CONTRACT_WINDOW_MS,
});
const duty = createDuty({
  state: store.state, now: events.now, appendEvent: events.appendEvent,
  markDirty: store.markDirty, pushToStreams: events.pushToStreams, OVERSEER_TICK_MS,
});
const overseer = createOverseer({
  state: store.state, fileClaims: events.fileClaims, now: events.now,
  appendEvent: events.appendEvent, markDirty: store.markDirty, duty,
});
store.startChangeSubscription(() => events.pushEventToStreams({ ts: Date.now(), type: "hub.reload", project: "", by: "" }));

let UI = "";
try { UI = readFileSync(new URL("./ui.html", import.meta.url), "utf8"); } catch {}
const context = {
  ...store, ...authRuntime, ...events, ...reaper, duty, overseer, derivePhases,
  hubSend: duty.hubSend, assertNoSecrets, UI, AUTH_MODE, ONLINE_MS,
  REAP_GRACE_MS, CONTRACT_WINDOW_MS,
};
const routes = [routeAdmin, routeCards, routeInsights, routeMessages];

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const q = Object.fromEntries(u.searchParams);
  const P = u.pathname;
  try {
    const b0 = req.method === "POST" ? await authRuntime.body(req) : {};
    if (authRuntime.handleEnrollment({ req, res, P, u, b0 })) return;
    const auth = authRuntime.PUBLIC_ENDPOINTS.has(P)
      ? { ok: true, mode: AUTH_MODE, trusted: false }
      : await authRuntime.authenticate(req, authRuntime.authPath(u));
    if (authRuntime.handleInvite({ req, res, P, auth, b0 })) return;
    if (!auth.ok) return authRuntime.json(res, auth.code || 401, { error: auth.error || "unauthorized" });
    const authorization = authRuntime.authorize(auth, req.method, P, authRuntime.projectFromRequest(P, q, b0));
    if (!authorization.ok) return authRuntime.json(res, authorization.code || 403, { error: authorization.error || "forbidden" });
    for (const route of routes) if (await route({ req, res, q, P, auth, ctx: context })) return;
    authRuntime.json(res, 404, { error: "not found" });
  } catch (error) {
    authRuntime.json(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => console.error(`[trantor] hub on http://${HOST}:${PORT} (auth: ${AUTH_MODE}; data: ${DATA})`));
