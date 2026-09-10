/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: assemble may be handed a state straight off a sidecar read (TDD §4.1 readState → assemble), so the type of every field is exactly what cannot be assumed; renderState decodes it at the boundary into prompt bytes rather than trusting the caller to have validated. */
// Trantor State P5 — assemble (TDD §4.6): preamble + STATE + TAIL + OBS, built fresh each turn. The bytes
// before STATE_DELIM are the caller's preamble and NOTHING else, or prefix caching never engages.
import { CAPS, RUNTIME_EXT_KEYS } from "./schema.mjs";

/** Fixed block headers. The runner's preamble must never contain STATE_DELIM — it is the prefix
 *  boundary the invariant (and the test) is defined on. */
export const STATE_DELIM = "\n===== STATE =====\n";
export const TAIL_DELIM = "\n===== CARD LOG =====\n";
export const OBS_DELIM = "\n===== LAST OBSERVATION =====\n";

/** Crude but standard chars-per-token estimate. The caps are budgets, not tokenizer counts —
 *  exact counts would need a model-specific tokenizer this repo does not carry, and a 4:1
 *  underestimate of the ceiling is the safe direction for an O(1) claim. */
const CHARS_PER_TOKEN = 4;

/** Cap a string to ~cap tokens, KEEPING THE END: the recent lines of gate output and card log are the
 *  live context, the head is the stale part (§4.8). */
export function capTokens(text, cap, what) {
  const s = typeof text === "string" ? text : "";
  const budget = Math.max(1, cap * CHARS_PER_TOKEN);
  if (s.length <= budget) return s;
  const mark = `…[${what} truncated to the last CAPS.${cap} tokens]\n`;
  // The marker is INSIDE the budget — the returned string is never longer than the cap it names.
  // A cap too small to hold the marker drops the marker rather than the cap.
  if (mark.length >= budget) return s.slice(s.length - budget);
  return mark + s.slice(s.length - (budget - mark.length));
}

/** The state as the seat reads it: one compact, deterministic block bounded by the schema's caps;
 *  runtime-owned `ext` keys stay private. A null or broken state renders as "" and never throws. */
export function renderState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "";
  const rows = [];
  if (typeof state.task === "string" && state.task) rows.push(`task: ${state.task}`);
  for (const [list, label] of [["done", "done"], ["in_flight", "in flight"], ["next", "next"], ["blockers", "blockers"]]) {
    const items = Array.isArray(state[list]) ? state[list] : [];
    if (!items.length) continue;
    const more = list === "done" && state.done_count ? ` (+${state.done_count} compacted)` : "";
    rows.push(`${label} (${items.length}${more}):`);
    for (const i of items) {
      if (!i || typeof i !== "object") continue;
      rows.push(`  ${i.id} ${i.text}${Array.isArray(i.paths) && i.paths.length ? ` [${i.paths.join(", ")}]` : ""}`);
    }
  }
  const files = state.files && typeof state.files === "object" && !Array.isArray(state.files) ? state.files : {};
  const paths = Object.keys(files);
  if (paths.length) {
    const verified = paths.filter(p => files[p] && files[p].verified === true);
    rows.push(`files: ${paths.length} touched, ${verified.length} verified${verified.length ? `: ${verified.join(", ")}` : ""}`);
  }
  const verify = state.verify && typeof state.verify === "object" && !Array.isArray(state.verify)
    ? Object.entries(state.verify) : [];
  if (verify.length) rows.push(`verify: ${verify.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (state.cursor && typeof state.cursor === "object") rows.push(`turn ${state.cursor.turn}, rev ${state.rev}`);
  const ext = state.ext && typeof state.ext === "object" && !Array.isArray(state.ext)
    ? Object.keys(state.ext).filter(k => !RUNTIME_EXT_KEYS.includes(k)) : [];
  if (ext.length) rows.push(`ext: ${JSON.stringify(Object.fromEntries(ext.map(k => [k, state.ext[k]])))}`);
  if (typeof state.notes === "string" && state.notes) rows.push(`notes: ${state.notes}`);
  return rows.join("\n");
}

/** One step's prompt: deterministic and O(1) in turn count, since the state is capped by the schema
 *  (§3.1) and tail/observation by capTokens.
 *  @param {{ preamble?: string, state?: object|null, tail?: string, observation?: string }} parts
 *  @returns {string} */
export function assemble({ preamble = "", state = null, tail = "", observation = "" } = {}) {
  const pre = typeof preamble === "string" ? preamble : "";
  return pre
    + STATE_DELIM + renderState(state)
    + TAIL_DELIM + capTokens(tail, CAPS.TAIL_TOKENS, "card log")
    + OBS_DELIM + capTokens(observation, CAPS.OBS_TOKENS, "observation");
}
