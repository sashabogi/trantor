/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: promote is the seam between the pure plan
 * and a live hub. State, promotions and the hub response all arrive from outside this module, so
 * the few typeof/Number.isInteger guards below ARE the boundary decode — the same justification the
 * other lib/state modules carry — not a substitute for one. */
// Trantor State P3: the promoter (TDD §4.7). One turn's delta → AT MOST ONE /task/update note,
// deduped by content hash; ext._promoted advances only after a 2xx. Never moves a card's STATUS
// and never promotes scratch (#6669). A failed POST is non-fatal and re-sends next turn.
import { createHash } from "node:crypto";
import { signedPost } from "../../hooks/lib/api.mjs";

/** CARDLOG-CONTRACT: a card-log note text is ≤ 2000 chars. The hub caps it; we never exceed it. */
export const PROMOTE_NOTE_CAP = 2000;

/** Human label per Promotion kind — the kind names from the pure plan, unchanged. */
export const PROMOTE_LABELS = {
  done: "done",
  blocker_added: "blocked",
  blocker_cleared: "unblocked",
  verify: "verify",
};

/** One note line per promotion, `<label>: <text>`. Malformed rows are skipped, never rendered. */
export function noteLines(promotions) {
  if (!Array.isArray(promotions)) return [];
  const out = [];
  for (const p of promotions) {
    if (!p || typeof p.kind !== "string" || typeof p.text !== "string") continue;
    out.push(`${PROMOTE_LABELS[p.kind] || p.kind}: ${p.text}`);
  }
  return out;
}

/** Compose the plan into one note ≤ PROMOTE_NOTE_CAP. Deterministic — the same delta always
 *  renders the same note, which is what makes content-hash dedupe meaningful.
 *  @returns {string} "" when the delta is empty, else the note */
export function composeNote(promotions, cap = PROMOTE_NOTE_CAP) {
  const lines = noteLines(promotions);
  if (!lines.length) return "";
  const note = lines.join("\n");
  if (note.length <= cap) return note;
  // Over the cap: keep the head (done lines lead — they are the record of what shipped), drop the
  // tail, and say so. A hard mid-line slice is #6528; whole-line elision is not.
  const kept = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + (kept.length ? 1 : 0);
    if (len + add <= cap) { kept.push(line); len += add; continue; }
    if (!kept.length) return `${line.slice(0, Math.max(0, cap - 1))}…`;
    break;
  }
  let out = kept.join("\n");
  const dropped = lines.length - kept.length;
  if (dropped > 0) {
    const marker = `\n… (+${dropped} more)`;
    out = out.length + marker.length <= cap ? out + marker : out.slice(0, cap - marker.length) + marker;
  }
  return out.length <= cap ? out : out.slice(0, cap);
}

/** sha256 hex of the note — the content identity. A re-run of the same delta yields the same hash. */
export function noteHash(note) {
  return createHash("sha256").update(String(note ?? ""), "utf8").digest("hex");
}

/**
 * Promote one turn's delta to the card. Pure except for the injectable `post`. Returns the input
 * `state` untouched on failure, a clone with ext._promoted = hash on 2xx.
 */
export async function promote(state, promotions, { by, project, post, timeoutMs } = {}) {
  if (!state || !Number.isInteger(state?.card)) {
    return {
      ok: false, sent: false, note: "", hash: "",
      state: state ?? null, error: "promote needs a state whose card is an integer",
    };
  }
  const note = composeNote(promotions);
  if (!note) return { ok: true, sent: false, skipped: "empty", note, hash: "", state };
  const hash = noteHash(note);
  const last = state.ext && typeof state.ext === "object" && state.ext._promoted !== undefined
    ? state.ext._promoted : undefined;
  if (typeof last === "string" && last === hash) {
    return { ok: true, sent: false, skipped: "duplicate", note, hash, state };
  }

  const session = String(by || (state.cursor && typeof state.cursor === "object" && state.cursor.by) || "").slice(0, 120);
  const payload = { id: state.card, by: session, note };
  if (project) payload.project = project;

  const send = post
    || ((pl, o) => signedPost("/task/update", pl, { project: o?.project, session: o?.session, timeoutMs: o?.timeoutMs }));
  let res;
  try { res = await send(payload, { project, session, timeoutMs }); }
  catch { res = null; }

  const status = res && Number.isInteger(res.status) ? res.status : 0;
  const confirmed = !!res && res.ok === true && status >= 200 && status < 300;
  if (!confirmed) {
    const error = res && res.json && typeof res.json === "object" && typeof res.json.error === "string"
      ? res.json.error : (res ? `hub answered ${status}` : "post threw");
    return { ok: false, sent: false, note, hash, status, error, state };
  }

  const ext = state.ext && typeof state.ext === "object" ? { ...state.ext } : {};
  const advanced = { ...state, ext: { ...ext, _promoted: hash } };
  return { ok: true, sent: true, skipped: undefined, note, hash, status, state: advanced };
}
