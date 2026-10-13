// #11559: seats run long cards in ONE opencode session (#6134's design), and opencode only
// auto-compacts when the context is FULL - far past 100K on big-limit models. The knob is the
// top-level `compaction` block (schema: opencode.ai/config.json), injected per seat via
// OPENCODE_CONFIG_CONTENT (override: TRANTOR_OC_COMPACTION), which MERGES with the operator's global config.

export const OC_COMPACTION_ENV = "TRANTOR_OC_COMPACTION";

// The seat default: compaction on, old tool outputs pruned, a small recent window preserved.
// `reserved` is the buffer subtracted from the model's window before opencode calls the context
// full, so a larger value fires compaction earlier. Override the whole block with
// TRANTOR_OC_COMPACTION=<json>, or set it to "off" to ship no config content at all.
export const OC_COMPACTION_DEFAULT = {
  auto: true,
  prune: true,
  tail_turns: 4,
  preserve_recent_tokens: 24_000,
  reserved: 64_000,
};

/// A JSON string for OPENCODE_CONFIG_CONTENT, or "" when nothing should be injected: "off" opts
/// out, invalid JSON opts out loudly at the caller (never arms a half-parsed block), custom JSON
/// is wrapped as { compaction: <the value> } so the env stays one knob.
export function ocCompactionContent(env = process.env) {
  const raw = String(env[OC_COMPACTION_ENV] || "").trim();
  if (raw === "off") return "";
  if (!raw) return JSON.stringify({ compaction: OC_COMPACTION_DEFAULT });
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return ""; }
  // SAFETY: the operator's raw JSON arrives here untyped — a bare number, string or null must
  // opt OUT (no config), never arm a half-shaped compaction block at every opencode seat.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  return JSON.stringify({ compaction: parsed });
}
