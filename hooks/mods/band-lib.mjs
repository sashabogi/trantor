// Pure helpers for the trantor-band pilot mod (#12091). No I/O and no Node imports on purpose:
// the mod runs in Claude Code's sandboxed module environment, and the tests import this file directly.

// The session id comes from Claude Code, but it names a file, so keep it to a safe alphabet.
export function safeId(id) {
  return String(id ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

// Context fill as a fraction, from $.session.usage().context. Null until the first API response.
export function contextFraction(context) {
  const tokens = Number(context?.tokens);
  const window = Number(context?.window);
  if (context?.tokens == null || !Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0 || tokens < 0) return null;
  return Math.min(1, tokens / window);
}

export function contextPercent(context) {
  const frac = contextFraction(context);
  return frac === null ? null : Math.round(frac * 100);
}

// The file the pilot leaves for Trantor's own code to read later.
export function contextRecord(context, ts) {
  const frac = contextFraction(context);
  if (frac === null) return null;
  return { ts, tokens: Number(context.tokens), window: Number(context.window), frac: Math.round(frac * 10000) / 10000 };
}

// The project id a checkout records in .trantor/project.json, mirroring lib/project.mjs readProjectId.
export function projectFromMarker(text) {
  try {
    const id = JSON.parse(text)?.id;
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(String(id ?? "")) && !String(id).includes("..") ? String(id) : "";
  } catch { return ""; }
}

export function basename(path) {
  return String(path ?? "").replace(/\/+$/, "").split("/").pop() || "";
}

// The newest <project>-<unix seconds>.json among a directory listing, or "" (the name handoff.mjs writes).
export function newestHandoffName(names, project) {
  if (!project) return "";
  const prefix = `${project}-`;
  let best = "";
  let bestTs = -1;
  for (const name of names || []) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (!/^\d+\.json$/.test(rest)) continue;
    const ts = Number(rest.slice(0, -5));
    if (ts > bestTs) { bestTs = ts; best = name; }
  }
  return best;
}

// "pending" (written, nobody has it), "claimed" (a fresh session holds an unexpired claim), or ""
// when it is consumed or unreadable. Mirrors hooks/lib/handoff-claims.mjs: consumed, claim.expiresAt.
export function handoffState(text, nowSeconds) {
  let record;
  try { record = JSON.parse(text); } catch { return ""; }
  if (!record || record.consumed) return "";
  return Number(record.claim?.expiresAt) > nowSeconds ? "claimed" : "pending";
}

// The band's one line. Parts that are unknown are left out; an empty result means draw nothing.
export function bandText({ percent, handoff }) {
  const parts = [];
  if (Number.isFinite(percent)) parts.push(`ctx ${percent}%`);
  if (handoff) parts.push(`handoff ${handoff}`);
  return parts.join(" · ");
}
