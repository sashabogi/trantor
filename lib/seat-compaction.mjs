// #11559: seats run long cards in one opencode session (#6134), and opencode auto-compacts only at
// window − reserved — there is NO absolute-threshold knob (opencode.ai/config.json,
// additionalProperties:false; calculateCeiling in packages/core/src/session/compaction.ts). So the
// seat target "compact near 100K" is reached by sizing reserved from the model's window.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OC_COMPACTION_ENV = "TRANTOR_OC_COMPACTION";
// The context level a seat card should stay near: on a 1M-window model reserved becomes 900K
// so auto-compact fires at ~100K, not the ~936K a fixed 64K buffer leaves.
export const OC_COMPACT_AT = 100_000;
// The buffer floor: kept when the model's window is unknown, or smaller than would still
// leave OC_COMPACT_AT free.
export const OC_RESERVED_FLOOR = 64_000;

// The seat default: compaction on, old tool outputs pruned, a small recent window preserved.
// Override the whole block with TRANTOR_OC_COMPACTION=<json>, or set it to "off" to ship no
// config content at all.
export const OC_COMPACTION_DEFAULT = {
  auto: true,
  prune: true,
  tail_turns: 4,
  preserve_recent_tokens: 24_000,
  reserved: OC_RESERVED_FLOOR,
};

// reservedForContext(window) — the buffer that makes opencode compact near OC_COMPACT_AT, or
// undefined when the window is unknown/invalid (the caller keeps the floor default).
export function reservedForContext(window) {
  if (!Number.isFinite(window) || window <= 0) return undefined;
  return Math.max(OC_RESERVED_FLOOR, window - OC_COMPACT_AT);
}

/// A JSON string for OPENCODE_CONFIG_CONTENT, or "" when nothing should be injected: "off" opts
/// out, invalid JSON opts out loudly at the caller (never arms a half-parsed block), custom JSON
/// is wrapped as { compaction: <the value> } so the env stays one knob. Given the model's catalog
/// window the DEFAULT block's reserved is sized; a custom TRANTOR_OC_COMPACTION wins verbatim.
export function ocCompactionContent(env = process.env, window = undefined) {
  const raw = String(env[OC_COMPACTION_ENV] || "").trim();
  if (raw === "off") return "";
  if (!raw) {
    const reserved = reservedForContext(window) ?? OC_COMPACTION_DEFAULT.reserved;
    return JSON.stringify({ compaction: { ...OC_COMPACTION_DEFAULT, reserved } });
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return ""; }
  // SAFETY: the operator's raw JSON arrives here untyped — a bare number, string or null must
  // opt OUT (no config), never arm a half-shaped compaction block at every opencode seat.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  return JSON.stringify({ compaction: parsed });
}

export const SEAT_MCP_ENV = "TRANTOR_SEAT_MCP";

// The user's opencode config object, or null: $OPENCODE_CONFIG else ~/.config/opencode/opencode.json
// (then .jsonc with whole-line // comments stripped). Fails open on anything unreadable.
export function readOpencodeUserConfig(env = process.env, home = homedir()) {
  const dir = join(home, ".config", "opencode");
  const files = env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : [join(dir, "opencode.json"), join(dir, "opencode.jsonc")];
  for (const f of files) {
    try {
      const raw = readFileSync(f, "utf8");
      return JSON.parse(f.endsWith(".jsonc") ? raw.replace(/^\s*\/\/.*$/gm, "") : raw);
    } catch {}
  }
  return null;
}

// #11854: a seat only needs the relay server; every other MCP server in the user's config pays its
// tool definitions on every model step. Returns { mcp: { name: { enabled: false } } } or null.
export function seatMcpOverlay(userConfig, env = process.env) {
  if (String(env[SEAT_MCP_ENV] || "").trim() === "all") return null;
  const mcp = userConfig?.mcp;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return null;
  const off = Object.keys(mcp).filter((n) => n !== "relay");
  return off.length ? { mcp: Object.fromEntries(off.map((n) => [n, { enabled: false }])) } : null;
}

// The OPENCODE_CONFIG_CONTENT for an opencode seat: compaction JSON plus the MCP overlay, "" if neither.
export function seatConfigContent(compactionJson, mcpOverlay) {
  if (!mcpOverlay) return compactionJson;
  let base = {};
  try { base = compactionJson ? JSON.parse(compactionJson) : {}; } catch {}
  return JSON.stringify({ ...base, ...mcpOverlay });
}

// The one per-turn runner line: what the injected block will actually do for this seat.
export function ocCompactionLogLine(window = undefined) {
  const reserved = reservedForContext(window);
  if (reserved === undefined) return `compaction: reserved=${OC_RESERVED_FLOOR} (floor — model window unknown)`;
  return `compaction: reserved=${reserved} — auto-compact fires near ${OC_COMPACT_AT} tokens (window ${window} − reserved; opencode has no absolute-threshold knob)`;
}
