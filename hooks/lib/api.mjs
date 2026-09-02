// trantor — the ONE signed-HTTP client every hook and the MCP server speak to the hub through
// (TDD §8). Before this existed, each of the 12 hooks hand-rolled its own relayUrl(), identity
// derivation, and a bare `fetch` wrapped in try/catch. That worked, but it was 12 copies of the
// same shape AND it sent every request UNSIGNED — which is the hole Phase 0 closes: a request
// must be provably attributable to a keypair (TDD §7.3), so /send's self-asserted `from` can no
// longer be forged by any local process (the 2026-07-28 RCE).
//
// This module wraps lib/signed-fetch.mjs (the frozen interface contract from #3916) with three
// things every caller needs and none of them should re-implement:
//   1. hub URL resolution, per-project (env RELAY_URL → config.json hubs[project] → config.json
//      url → 127.0.0.1:4477) — TDD §12.1: a project lives on exactly one hub
//   2. session identity resolution (RELAY_SESSION → RELAY_AGENT:project → hostId:project) — the
//      SAME derivation mcp.mjs uses, so we sign as the peer the relay registered
//   3. the Ed25519 keypair for that name (loadOrCreate: atomic, 0600, race-safe)
//
// FAIL-OPEN IS A CONTRACT, NOT A CONVENIENCE (acceptance §9 #10). A hook runs inside the user's
// tool loop; if it throws or hangs it breaks their session. So getJSON/signedPost NEVER throw —
// not on a down hub, not on a timeout, not on an unreadable key file. They resolve to
// { ok:false, status:0, json:null } and let the caller proceed exactly as it did when its own
// try/catch swallowed a bare fetch. Signing itself is fail-open too: no key → the request goes
// unsigned and the HUB decides what to do under its RELAY_AUTH policy (off|warn|enforce). The
// client never makes that call, because only the hub knows the policy.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId, resolveHub } from "../../lib/project.mjs";
import { loadOrCreate, loadOrCreateInstance } from "../../lib/identity.mjs";
import { sfetchJson } from "../../lib/signed-fetch.mjs";

export const DEFAULT_TIMEOUT_MS = 1500;

// Hub URL, PER-PROJECT (TDD §12.1): a project resolves to exactly one hub; codependent projects
// share one. Env RELAY_URL wins (tests / explicit override / crew seats), then the per-project
// `hubs` map in the shared config, then the legacy global `url`, then the local default. Reading
// the config here means a hook works the moment `trantor` has been run once. resolveHub never
// throws, keeping hooks fail-open.
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

// THE PROJECT A REQUEST IS ABOUT, which is not always the project the hook process is standing in.
//
// This distinction cost two diagnosis sessions. A hook stamps its payload with the project from
// Claude's session cwd (`input.cwd`), but the hub URL used to come from the HOOK PROCESS's cwd.
// Launch a session from ~/development and those disagree: every card says "crebral-health" and
// every one of them lands on the LOCAL hub, because "development" has no pin and falls through to
// the global default. Nothing errors, the seat looks healthy, and half the work records where
// nobody reads. So: the project travels WITH the request, explicit > payload > query > cwd.
function projectFromQuery(pathOrUrl) {
  const m = String(pathOrUrl).match(/[?&]project=([^&]*)/);
  try { return m ? decodeURIComponent(m[1]) : ""; } catch { return m ? m[1] : ""; }
}
function projectOf(explicit, payload, pathOrUrl) {
  if (explicit) return explicit;
  if (payload && typeof payload === "object" && payload.project) return String(payload.project);
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

// Best-effort, once-per-key enrollment (TDD §7.4). /enroll is unauthenticated BY NECESSITY — it is
// how an identity is BORN — so we POST the pubkey in the body and stamp it to a file keyed by the
// session name so we never repeat the round trip while the key is unchanged. Under RELAY_AUTH=enforce
// the hub rejects signed writes from unknown pubkeys, so this MUST precede a write; under warn it is
// harmless (the hub TOFUs on loopback either way). A hub that is down, or that refuses (non-loopback
// bind), is silently ignored — fail-open: the signed request still goes out and the hub decides.
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

// Unsigned GET → { ok, status, json|null }. Never throws.
//
// WHY READS STAY UNSIGNED: the card signs WRITES ("signed POST") — that is what closes the 2026-07-28
// hole (/send's self-asserted `from`). The hub's read scope-filtering (filterReadable, #3917) now
// exempts direct messages (m.to === session), so /inbox COULD be signed — BUT signing /peers and
// /catchup filters them to the reader's OWN project only, which breaks cross-project session
// discovery (sessionstart's "independent sessions find each other across machines" purpose) and the
// /peers roster. So reads stay unsigned: accepted+flagged under the default `warn` mode, and the
// roster stays global. Flipping individual reads to signed later is a one-liner once a read needs
// enforce-mode attribution (add a signedGet that passes `identity` through sfetchJson with GET).
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
  } catch { return { ok: false, status: 0, json: null }; }
}

// Signed GET → { ok, status, json|null }. Never throws. The "one-liner" the getJSON comment
// promised: for reads that MUST work under RELAY_AUTH=enforce (which 401s unsigned reads).
// First user: the overseer-warn hook's /overseer/context — a project-scoped read, so the
// enforce hub's own-project scope filtering is the correct behavior, not a loss. Roster-style
// reads (/peers, /catchup cross-project discovery) stay on getJSON on purpose — see above.
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
  } catch { return { ok: false, status: 0, json: null }; }
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
  } catch { return { ok: false, status: 0, json: null }; }
}
