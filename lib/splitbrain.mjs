// trantor — hub split-brain detection.
//
// A project lives on exactly ONE hub (TDD §12.1). When that stops being true nothing errors: the
// crew registers on hub A, the orchestrator and the board read hub B, every seat reports healthy,
// and the work simply lands somewhere nobody is looking. It cost two full diagnosis sessions in
// crebral-health (2026-08-14 and again 2026-08-18) before anyone thought to compare the two hubs.
// Nothing on the machine was wrong; the two halves just never met.
//
// So detection is a cross-check, not a health check: probe every hub this machine knows about, ask
// each one who is LIVE on it, and compare that against the pins in ~/.agent-bus/config.json.
//
// THE TRAP THIS LIB EXISTS TO AVOID: an unsigned read of an enforce hub answers
// `{"error":"signature required"}` with HTTP 401, and `(body.peers || [])` turns that refusal into
// a confident empty list — a hub full of agents reads as deserted. That nearly got called a fleet
// outage. probeHub() therefore reports a REASON, never a silent empty roster, and analyze() carries
// unreadable hubs through to the caller as `blind` so a partial answer can never be printed as a
// clean bill of health.
import { sfetch } from "./signed-fetch.mjs";

/** Compare hub URLs the way a human would: trailing slash and loopback spelling are not identity. */
export function normalizeHub(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  return u.replace(/^http:\/\/localhost(?=[:/]|$)/i, "http://127.0.0.1");
}
export const isLocalHub = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i.test(String(url || ""));

/** Every hub this machine could be talking to: the global default, and every per-project pin. */
export function hubsFromConfig(config = {}, defaultUrl = "http://127.0.0.1:4477") {
  const seen = new Map();
  const add = (url, source) => {
    const u = normalizeHub(url);
    if (!/^https?:\/\//.test(u)) return;
    if (!seen.has(u)) seen.set(u, { url: u, sources: [] });
    seen.get(u).sources.push(source);
  };
  add(config.url || defaultUrl, "config.url");
  for (const [project, url] of Object.entries(config.hubs || {})) add(url, `pin:${project}`);
  return [...seen.values()];
}

/** Ask one hub who is live on it. Never conflates "refused us" with "nobody home". */
export async function probeHub(url, identity, { timeoutMs = 6000, fetchImpl = null } = {}) {
  const u = normalizeHub(url);
  const base = { url: u, ok: false, reason: "", authMode: "", hubVersion: "", peers: [] };
  let res, text;
  try {
    const doFetch = fetchImpl || ((p, o, id) => sfetch(p, o, id));
    res = await doFetch(`${u}/peers`, { signal: AbortSignal.timeout(timeoutMs) }, identity);
    text = await res.text();
  } catch (e) {
    return { ...base, reason: `unreachable (${e?.message || e})` };
  }
  let body;
  try { body = JSON.parse(text); } catch { return { ...base, reason: `unreadable response (HTTP ${res.status})` }; }
  // The refusal case, spelled out. Both shapes matter: an enforce hub 401s with {error}, and a
  // scope-limited identity can get a 200 whose roster is filtered — only the first is a blind spot.
  if (!res.ok || body?.error) {
    const why = body?.error || `HTTP ${res.status}`;
    return { ...base, reason: /signature|unauthor|forbidden|401|403/i.test(why) ? `not authorized (${why})` : `refused (${why})` };
  }
  if (!Array.isArray(body?.peers)) return { ...base, reason: "no peer roster in the response" };
  return { url: u, ok: true, reason: "", authMode: body.authMode || "", hubVersion: body.hubVersion || "",
    peers: body.peers.map(p => ({ session: p.session, project: p.project || "", online: !!p.online, lastSeen: p.lastSeen || 0, llm: p.llm || "" })) };
}

/**
 * Cross-check live presence against the pins.
 *
 * @param probes   probeHub() results, one per hub
 * @param config   the raw ~/.agent-bus/config.json
 * @returns {{findings: Array, blind: Array, checked: number}}
 */
export function analyze(probes = [], config = {}, defaultUrl = "http://127.0.0.1:4477") {
  const pins = Object.fromEntries(Object.entries(config.hubs || {}).map(([p, u]) => [p, normalizeHub(u)]));
  const fallback = normalizeHub(config.url || defaultUrl);
  const readable = probes.filter(p => p.ok);
  const blind = probes.filter(p => !p.ok).map(p => ({ url: p.url, reason: p.reason }));

  // project -> hubs it is LIVE on
  const liveOn = new Map();
  for (const probe of readable) {
    for (const peer of probe.peers) {
      if (!peer.online || !peer.project) continue;
      if (!liveOn.has(peer.project)) liveOn.set(peer.project, new Map());
      const byHub = liveOn.get(peer.project);
      if (!byHub.has(probe.url)) byHub.set(probe.url, []);
      byHub.get(probe.url).push(peer.session);
    }
  }

  const findings = [];
  for (const [project, byHub] of [...liveOn.entries()].sort()) {
    const hubs = [...byHub.keys()];
    const pin = pins[project] || "";
    const expected = pin || fallback;
    if (hubs.length > 1) {
      findings.push({ kind: "split", project, severity: "critical", hubs, expected,
        sessions: Object.fromEntries([...byHub].map(([h, s]) => [h, s])),
        message: `${project} has LIVE sessions on ${hubs.length} hubs at once — ${hubs.map(h => `${h} (${byHub.get(h).join(", ")})`).join(" and ")}. They cannot see each other's cards or messages.`,
        fix: pin
          ? `everything must be on ${pin}: restart the sessions on the other hub (crew: trantor down && trantor up · Claude sessions: restart them)`
          : `pin it first — trantor hub set ${project} <url> — then restart every session so they all follow the pin` });
    } else if (pin && hubs[0] !== pin) {
      findings.push({ kind: "off-pin", project, severity: "critical", hubs, expected: pin,
        sessions: Object.fromEntries([...byHub].map(([h, s]) => [h, s])),
        message: `${project} is pinned to ${pin} but its live sessions (${byHub.get(hubs[0]).join(", ")}) are on ${hubs[0]} — their work records where nobody is reading.`,
        fix: `restart them so they pick up the pin (crew: trantor down && trantor up · Claude sessions: restart them)` });
    } else if (!pin && !isLocalHub(hubs[0])) {
      findings.push({ kind: "unpinned-remote", project, severity: "warn", hubs, expected: fallback,
        sessions: Object.fromEntries([...byHub].map(([h, s]) => [h, s])),
        message: `${project} is live on ${hubs[0]} but has no pin — the next session started here falls back to ${fallback} and splits the project in two.`,
        fix: `trantor hub set ${project} ${hubs[0]}` });
    }
  }
  // A pin aimed at a hub we could not read is its own fault: sessions will route there and go quiet.
  for (const [project, url] of Object.entries(pins)) {
    const dead = blind.find(b => b.url === url);
    if (dead) findings.push({ kind: "pin-unreachable", project, severity: "critical", hubs: [], expected: url,
      message: `${project} is pinned to ${url}, which this machine cannot read (${dead.reason}) — sessions on it will look alive and record nothing here.`,
      fix: `check the hub is up and this machine is enrolled on it, or re-pin: trantor hub set ${project} <url>` });
  }
  return { findings, blind, checked: readable.length };
}

/** Probe + analyze in one call. Hubs are probed concurrently — a dead one must not stall the rest. */
export async function scan(config = {}, identity, { defaultUrl = "http://127.0.0.1:4477", timeoutMs = 6000 } = {}) {
  const hubs = hubsFromConfig(config, defaultUrl);
  const probes = await Promise.all(hubs.map(h => probeHub(h.url, identity, { timeoutMs })));
  return { ...analyze(probes, config, defaultUrl), probes };
}
