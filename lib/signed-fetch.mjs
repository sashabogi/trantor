// trantor: a signing drop-in for fetch, one call-site shape for every client (mcp.mjs, hooks, bin/*,
// the runner). FAIL-OPEN IS A CONTRACT: no identity or an unreadable key file sends the request
// UNSIGNED, and the hub decides under RELAY_AUTH, because only the hub knows the policy.
import { signRequest, loadOrCreate, instanceHeaders } from "./identity.mjs";

// Sign over path + query only. The origin is not in the canonical string: the same request proxied
// through a different host must still verify, and the hub knows its own address.
function pathOf(url) {
  try { const u = new URL(url); return u.pathname + (u.search || ""); }
  catch { return String(url); }
}

// `body` must be the EXACT bytes given to fetch — sign what is sent, never a re-serialisation.
export function signedHeaders(identity, url, opts = {}) {
  if (!identity?.privkey) return {};
  try {
    const v1 = signRequest(identity, {
      method: (opts.method || "GET").toUpperCase(),
      path: pathOf(url),
      body: opts.body,
    });
    // An INSTANCE identity (docs/INSTANCE-KEYS-CONTRACT.md) carries its endorsement; the extra
    // headers ride along and the hub attributes the request to the durable identity. A plain
    // durable identity contributes nothing here — v1 wire format unchanged.
    return { ...v1, ...instanceHeaders(identity) };
  } catch { return {}; }                       // never let signing break a caller
}

export function sfetch(url, opts = {}, identity) {
  const extra = signedHeaders(identity, url, opts);
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...extra } });
}

// Convenience for the many callers that POST JSON and want identity resolved from a session name.
export function sfetchJson(url, { method = "POST", payload, identity, name, kind = "agent", ...rest } = {}) {
  const id = identity || (name ? loadOrCreate(name, kind) : null);
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return sfetch(url, { ...rest, method, headers: { "content-type": "application/json", ...(rest.headers || {}) }, body }, id);
}
