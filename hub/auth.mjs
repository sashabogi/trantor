/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: Auth normalizes untrusted request and persisted identity shapes at their established hub boundary; this split preserves those guards unchanged. */
import { verifyRequest, verifyEndorsement } from "../lib/identity.mjs";
import { readFileSync } from "node:fs";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { publicView } from "../lib/identity.mjs";
import { IDENTITY_KINDS } from "../lib/store-contract.mjs";

export function createAuthRuntime({ state, markDirty, AUTH_MODE, SUPERSEDE_GRACE_MS, LOOPBACK_BIND, ENROLL_MODE }) {
const now = () => Date.now();
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
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); return true; }
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
let HUB_VERSION = ""; try { HUB_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || ""; } catch {}
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
// --- Cross-project guard (#6228) -----------------------------------------------------------
// scopeAllows/canRead answer "can this identity touch project P at all" — and most identities
// are minted project:"*" role:"owner" by defaultScopesFor (any non-agent kind: an orchestrator,
// genesis, a human). That is not a project fence; it is exactly the loophole the pr-os
// orchestrator walked through to register seats and post contracts into crebral-com from its
// own session, nothing it was ever working. This is the fence: does the CALLER's own project
// (its identity name's "kind:project" suffix, the same convention defaultScopesFor reads) match
// the project the request ACTS on. Only a declared `trantor policy link` (state.orgPolicy.links,
// the same store /policy reads and writes — POST /policy is itself OWNER_ENDPOINTS-gated) or the
// operator's own identity (kind "human", the key /instance/supersede already treats as owner)
// opens the door. Applies to the five endpoints that reach across sessions or mint access:
// /send, /task, /task/update, /register, /invite.
const CROSS_PROJECT_ENDPOINTS = new Set(["/send", "/task", "/task/update", "/register", "/invite"]);
function projectsLinked(a, b) {
  if (!a || !b || a === b) return true;
  return overseerPolicy().links.some(l => {
    const ps = (l.projects || []).map(p => canon(p));
    return ps.includes(a) && ps.includes(b);
  });
}
function overseerPolicy() {
  const policy = state.orgPolicy && typeof state.orgPolicy === "object" ? state.orgPolicy : {};
  return { autonomy: { "*": 1, ...(policy.autonomy || {}) }, links: Array.isArray(policy.links) ? policy.links : [] };
}
// The caller's home project, by the SAME "name suffix after the colon" rule defaultScopesFor
// uses to mint a fresh identity's default scope. An identity with no colon in its name (a bare
// human alias, or a tool identity never given a project) has no home to fence — nothing to check.
function callerProject(auth) {
  const name = String(auth?.identity?.name || "");
  return name.includes(":") ? canon(name.slice(name.lastIndexOf(":") + 1)) : "";
}
function crossProjectTarget(P, b) {
  if (P === "/send") {
    if (!b?.to || b.to === "all") return "";   // broadcast: existing hub-wide behavior, untouched
    const to = String(b.to);
    return canon(state.peers[to]?.project || (to.includes(":") ? to.slice(to.lastIndexOf(":") + 1) : ""));
  }
  if (P === "/task" || P === "/register") return canon(String(b?.project || "").slice(0, 80));
  if (P === "/task/update") {
    const t = state.tasks.find(x => x.id === Number(b?.id));
    return t?.project || "";
  }
  if (P === "/invite") {
    // an invite MINTS access into whatever project(s) its scopes name — a wildcard scope names none.
    const scopes = Array.isArray(b?.scopes) ? b.scopes : [];
    return scopes.map(s => canon(String(s?.project || ""))).find(p => p && p !== "*") || "";
  }
  return "";
}
function crossProjectGuard(auth, P, b) {
  if (!CROSS_PROJECT_ENDPOINTS.has(P) || AUTH_MODE === "off" || !auth?.identity) return { ok: true };
  if (auth.identity.kind === "human") return { ok: true };   // the operator's own key
  const home = callerProject(auth);
  if (!home) return { ok: true };
  const target = crossProjectTarget(P, b);
  if (!target || target === home || projectsLinked(home, target)) return { ok: true };
  return { ok: false, code: 403,
    error: `cross-project: ${home} may not act on ${target} — cross-project action is a breach unless the operator linked the projects. Run: trantor policy link ${home} ${target} --reason "<why>"` };
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
    state.instances[verified.pubkey] = rec; markDirty();
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

  function handleEnrollment({ req, res, P, u, b0 }) {
    if (req.method !== "POST" || P !== "/enroll") return false;
    const raw = req._rawBody || "";
    const verified = verifyRequest({ headers: req.headers, method: req.method, path: authPath(u), body: raw });
    if (!verified.ok) return json(res, 401, { error: verified.reason || "bad signature" });
    const requestedKind = String(b0.kind || "agent").slice(0, 40);
    if (!IDENTITY_KINDS.includes(requestedKind)) {
      return json(res, 400, { error: `kind must be one of: ${IDENTITY_KINDS.join(", ")}`, allowedKinds: IDENTITY_KINDS });
    }
    const existing = findIdentity(verified.pubkey);
    if (existing) return json(res, 200, { ok: true, identity: publicView(existing), scopes: existing.scopes || [] });
    let enrolledBy = "";
    let scopes = [];
    const token = String(b0.token || "");
    const bootstrap = String(process.env.RELAY_BOOTSTRAP_TOKEN || "");
    const noIdentitiesYet = Object.keys(state.identities || {}).length === 0;
    const tokenMatchesBootstrap = !!bootstrap && !!token && token.length === bootstrap.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(bootstrap));
    if (bootstrap && noIdentitiesYet && tokenMatchesBootstrap) {
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
      kind: requestedKind, pubkey: verified.pubkey, createdAt: now(), enrolledBy, scopes,
    };
    identity.scopes = scopes.length ? scopes : defaultScopesFor(identity, b0);
    state.identities[verified.pubkey] = identity;
    markDirty();
    return json(res, 200, { ok: true, identity: publicView(identity), scopes: identity.scopes });
  }

  function handleInvite({ req, res, P, auth, b0 }) {
    if (req.method !== "POST" || P !== "/invite") return false;
    if (!auth.ok) return json(res, auth.code || 401, { error: auth.error || "unauthorized" });
    const az = authorize(auth, req.method, P, "*");
    if (!az.ok) return json(res, az.code || 403, { error: az.error || "forbidden" });
    const invitedKind = String(b0.kind || "agent").slice(0, 40);
    if (!IDENTITY_KINDS.includes(invitedKind)) {
      return json(res, 400, { error: `kind must be one of: ${IDENTITY_KINDS.join(", ")}`, allowedKinds: IDENTITY_KINDS });
    }
    const scopes = (Array.isArray(b0.scopes) ? b0.scopes : []).map(cleanScope).filter(Boolean).slice(0, 20);
    if (!scopes.length) return json(res, 400, { error: "scopes required" });
    const guard = crossProjectGuard(auth, P, { scopes });
    if (!guard.ok) return json(res, guard.code, { error: guard.error });
    const ttlSec = Math.min(Math.max(Number(b0.ttlSec) || 86400, 1), 30 * 86400);
    const token = randomBytes(24).toString("hex");
    state.inviteTokens[token] = { scopes, kind: invitedKind, expiresAt: now() + ttlSec * 1000, used: false,
      createdBy: auth.identity?.pubkey || "", createdAt: now() };
    markDirty();
    return json(res, 200, { ok: true, token, scopes, expiresAt: state.inviteTokens[token].expiresAt });
  }

  return {
    PUBLIC_ENDPOINTS, authPath, authenticate, authorize, body, rawBody, json,
    canon, cleanScope, defaultScopesFor, findIdentity, scopeAllows, canRead,
    projectFromRequest, crossProjectGuard, filterReadable, filterDiscoverable,
    inboxReadable, canUseInboxSession, overseerPolicy, subFp, PROPOSAL_CAP,
    propFp, HUB_VERSION, cmpSemver, handleEnrollment, handleInvite,
  };
}
