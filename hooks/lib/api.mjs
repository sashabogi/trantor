// trantor — the ONE signed-HTTP client every hook and the MCP server speak to the hub through (TDD §8).
// Wraps lib/signed-fetch.mjs (#3916) with hub URL resolution per project (§12.1), session identity
// (the same derivation mcp.mjs uses) and the Ed25519 keypair. FAIL-OPEN IS A CONTRACT (acceptance §9
// #10): getJSON/signedPost never throw; no key means unsigned, and only the hub knows its RELAY_AUTH policy.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId, resolveHub } from "../../lib/project.mjs";
import { loadOrCreate, loadOrCreateInstance } from "../../lib/identity.mjs";
import { sfetchJson } from "../../lib/signed-fetch.mjs";

export const DEFAULT_TIMEOUT_MS = 1500;

// Hub URL, PER-PROJECT (TDD §12.1): env RELAY_URL, then config `hubs[project]`, then the legacy global
// `url`, then the local default. Never throws, keeping hooks fail-open.
export function relayUrl(project) {
  return resolveHub(project || sessionContext().project);
}

// The session identity name + project, resolved EXACTLY as mcp.mjs / every prior hook did, so the
// keypair we load is the one the relay already registered this peer under. An explicit RELAY_SESSION
// (or RELAY_PROJECT) overrides — used by tests and by crew seats that inherit the env from the runner.
export function sessionContext(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const project = resolveProject(dir);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);
  return { session, project, projectDir: dir };
}

// THE PROJECT A REQUEST IS ABOUT is not always the hook process's cwd (a session launched from a
// non-project dir pinned every card to the wrong hub), so the project travels WITH the request: explicit > payload > query > cwd.
function projectFromQuery(pathOrUrl) {
  const m = String(pathOrUrl).match(/[?&]project=([^&]*)/);
  try { return m ? decodeURIComponent(m[1]) : ""; } catch { return m ? m[1] : ""; }
}
function projectOf(explicit, payload, pathOrUrl) {
  if (explicit) return explicit;
  // Only the payload's own project field is read; a truthy non-object payload has no such field
  // and falls through to the query string exactly as the old object guard made it do.
  if (payload && payload.project) return String(payload.project);
  return projectFromQuery(pathOrUrl);
}
// The signing identity for a request about `project`. An explicit RELAY_SESSION/RELAY_AGENT still
// wins (crew seats inherit them); otherwise the peer is named for the project being written, not
// for wherever the hook happens to be running.
function sessionFor(project) {
  if (process.env.RELAY_SESSION) return process.env.RELAY_SESSION;
  const p = project || sessionContext().project;
  return process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${p}` : `${hostId()}:${p}`;
}

// The keypair for a session name, memoised per process. loadOrCreate is itself idempotent + atomic,
// but a hook may sign several requests in one run — avoid re-reading the file each time.
const _idCache = new Map();
export function loadIdentity(session) {
  if (!session) return null;
  const cached = _idCache.get(session);
  if (cached) return cached;
  const id = loadOrCreate(session, "agent");
  _idCache.set(session, id);
  return id;
}

// The ENDORSED instance identity for (session, instanceId) — docs/INSTANCE-KEYS-CONTRACT.md.
// Hooks pass the harness session_id as instanceId (stable across one Claude Code session, distinct
// across baton twins); the MCP server passes a random id minted at boot. Falls back to the durable
// identity if the instance can't be minted (unwritable keys dir) — signing must never break a hook.
export function loadInstance(session, instanceId) {
  if (!session || !instanceId) return loadIdentity(session);
  const key = `${session}\x00${instanceId}`;
  const cached = _idCache.get(key);
  if (cached) return cached;
  const durable = loadIdentity(session);
  const inst = loadOrCreateInstance(durable, instanceId) || durable;
  _idCache.set(key, inst);
  return inst;
}

// Best-effort, once-per-key enrollment (TDD §7.4). /enroll is unauthenticated because it is how an
// identity is born; stamped per session name so the round trip is not repeated. Fail-open: the hub decides.
function enrolledPath(session) {
  const busDir = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
  return join(busDir, "keys", `${String(session).replace(/[^A-Za-z0-9_.-]/g, "_")}.enrolled`);
}
export async function ensureEnrolled(session, identity, project, { kind = "agent" } = {}) {
  if (!identity?.pubkey) return;
  const hub = relayUrl(project);
  const stamp = enrolledPath(session);
  // The stamp records the HUB as well as the key. It used to record only the key, so a session
  // enrolled on one hub was considered enrolled everywhere — and its first request to a second
  // hub went out as an unknown identity.
  const mark = `${identity.pubkey}\t${hub}`;
  try { if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === mark) return; } catch {}
  try {
    // sfetchJson is the FROZEN single call-site shape (lib/signed-fetch.mjs): it stringifies the
    // payload, sets content-type, and signs — so every hook signs identically with zero hand-rolling.
    const r = await sfetchJson(`${hub}/enroll`, {
      method: "POST",
      payload: { pubkey: identity.pubkey, name: session, kind },
      identity,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (r.ok) {
      try { mkdirSync(join((process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus")), "keys"), { recursive: true }); } catch {}
      try { writeFileSync(stamp, mark, { mode: 0o600 }); } catch {}
    }
  } catch {}
}

// Accept either a full URL (rare — a caller that already built one) or a hub-relative path. We do
// NOT fold the origin into the signature (signed-fetch signs path+query only), so a request proxied
// through a different host still verifies.
function toUrl(pathOrUrl, project) {
  return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${relayUrl(project || projectFromQuery(pathOrUrl))}${pathOrUrl}`;
}

// Unsigned GET → { ok, status, json|null }. Never throws. Reads stay UNSIGNED on purpose: signing /peers
// and /catchup scopes them to the reader's own project and breaks discovery; signedGet is for enforce-mode reads.

/**
 * The shape every fail-open read returns when the request never got an answer. `status` stays 0 for
 * existing callers; `timedOut` and `reason` are additive, since a timeout and an outage need opposite responses.
 */
function failure(e, timeoutMs) {
  const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError" || e?.code === "ABORT_ERR";
  return {
    ok: false, status: 0, json: null, timedOut,
    reason: timedOut ? `timed out after ${timeoutMs}ms` : (e?.message || "unreachable"),
  };
}

export async function getJSON(pathOrUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, project } = {}) {
  const url = toUrl(pathOrUrl, projectOf(project, null, pathOrUrl));
  try {
    const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    // parse the body on FAILURE too — a refusal's payload (denial note, queue guidance,
    // validation message) is often the caller's teaching moment, not just a status code
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      let errJson = null; try { errJson = errText ? JSON.parse(errText) : null; } catch {}
      return { ok: false, status: r.status, json: errJson };
    }
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: true, status: r.status, json };
  } catch (e) { return failure(e, timeoutMs); }
}

// Signed GET → { ok, status, json|null }. Never throws. For reads that MUST work under RELAY_AUTH=enforce
// (project-scoped reads like /overseer/context); roster-style reads stay on getJSON, see above.
export async function signedGet(pathOrUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, session, instance, project } = {}) {
  const proj = projectOf(project, null, pathOrUrl);
  const sess = session || sessionFor(proj);
  const durable = loadIdentity(sess);
  const id = instance ? loadInstance(sess, instance) : durable;
  await ensureEnrolled(sess, durable, proj);     // instances never enroll — the DURABLE key does
  try {
    const r = await sfetchJson(toUrl(pathOrUrl, proj), {
      method: "GET",
      identity: id,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // parse the body on FAILURE too — a refusal's payload (denial note, queue guidance,
    // validation message) is often the caller's teaching moment, not just a status code
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      let errJson = null; try { errJson = errText ? JSON.parse(errText) : null; } catch {}
      return { ok: false, status: r.status, json: errJson };
    }
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: true, status: r.status, json };
  } catch (e) { return failure(e, timeoutMs); }
}

// Signed POST → { ok, status, json|null }. Never throws.
export async function signedPost(pathOrUrl, payload, { timeoutMs = DEFAULT_TIMEOUT_MS, session, instance, project } = {}) {
  const proj = projectOf(project, payload, pathOrUrl);
  const sess = session || sessionFor(proj);
  const durable = loadIdentity(sess);
  const id = instance ? loadInstance(sess, instance) : durable;
  await ensureEnrolled(sess, durable, proj);     // instances never enroll — the DURABLE key does
  try {
    // sfetchJson (FROZEN) stringifies the payload + signs with `id` in one call — the single shape
    // every client uses (lib/signed-fetch.mjs). We pass our memoised identity so it doesn't re-load.
    const r = await sfetchJson(toUrl(pathOrUrl, proj), {
      method: "POST",
      payload,
      identity: id,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // parse the body on FAILURE too — a refusal's payload (denial note, queue guidance,
    // validation message) is often the caller's teaching moment, not just a status code
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      let errJson = null; try { errJson = errText ? JSON.parse(errText) : null; } catch {}
      return { ok: false, status: r.status, json: errJson };
    }
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: true, status: r.status, json };
  } catch (e) { return failure(e, timeoutMs); }
}
