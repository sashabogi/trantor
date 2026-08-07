// trantor/kimi — shared helpers for the Kimi Code port of the trantor hooks.
// Kimi Code hook payloads mirror Claude's conventions ({hook_event_name, session_id, cwd,
// tool_input, …}) but several event-specific field names are undocumented, so every reader
// here is defensive: try the documented name first, then the likely aliases. Set
// TRANTOR_DEBUG_HOOKS=1 (on the `kimi` process env) to dump every raw payload to
// ~/.agent-bus/kimi-hook-debug.jsonl — the first live session then reveals the true shapes.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { resolveProject, hostId } from "../../../lib/project.mjs";

export const DATA_DIR = process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");

export function readStdin(timeoutMs = 100) {
  return new Promise(res => {
    let d = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", c => (d += c));
      process.stdin.on("end", () => res(d));
    } catch { res(d); }
    setTimeout(() => res(d), timeoutMs);
  });
}

export async function readPayload(timeoutMs = 100) {
  const raw = await readStdin(timeoutMs);
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

export function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    if (existsSync(cfg)) { const u = JSON.parse(readFileSync(cfg, "utf8")).url; if (u) return u; }
  } catch {}
  return "http://127.0.0.1:4477";
}

export function nowSec() {
  try { return Number(execSync("date +%s", { encoding: "utf8" }).trim()) || 0; } catch { return 0; }
}

// The project directory the SESSION is working in. Kimi hook payloads carry `cwd` (documented
// base field). Never fall back to process.cwd() for project identity: plugin hooks run with
// cwd = the plugin's managed copy, which would spawn a phantom "trantor" project on the board.
export function payloadCwd(payload) {
  return String(payload?.cwd || process.env.CLAUDE_PROJECT_DIR || "");
}

// Identity resolution — mirrors mcp.mjs / the Claude hooks EXACTLY so the hook-side peer is the
// same peer the relay MCP server registers: RELAY_SESSION wins; else RELAY_AGENT brand per
// project ("kimi:<project>"); else host:project.
export function identity(cwd) {
  const project = resolveProject(cwd);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);
  return { project, session };
}

// Home-directory sessions aren't project work — registering them spawns a phantom "<username>"
// board. Opt in deliberately with RELAY_SESSION / RELAY_PROJECT.
export function isHomeSession(cwd) {
  return !process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && (!cwd || cwd === homedir());
}

export async function jget(u, timeoutMs = 2500) {
  const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
  return r.json();
}

export function jpost(u, body, timeoutMs = 2500) {
  return fetch(u, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => {});
}

// Strip control chars from untrusted text that will be printed on stdout and possibly injected
// into the model's context. Keeps tab/newline/CR.
export function sanitize(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0);
    const bad = (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f || c === 0x2028 || c === 0x2029;
    out += bad ? " " : ch;
  }
  return out;
}

// The user's prompt text from a UserPromptSubmit payload. LIVE-CAPTURED 2026-08-07
// (kimi_code_cli 0.34.0, TRANTOR_DEBUG_HOOKS): `prompt` is an ARRAY of content parts —
// [{type:"text",text:"…"}] — NOT a string. The original string-only check on `prompt` is why
// focus cards were dead (36 Claude session cards, 0 Kimi). Accept string OR parts-array on
// every candidate key, `prompt` first since that's the proven live name.
export function extractPrompt(payload) {
  if (!payload || typeof payload !== "object") return "";
  const joinParts = v => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      return v.map(p => (p && typeof p === "object" && typeof p.text === "string") ? p.text : (typeof p === "string" ? p : ""))
        .filter(Boolean).join("\n");
    }
    return "";
  };
  for (const k of ["prompt", "text", "user_prompt", "message", "input_text", "input"]) {
    const t = joinParts(payload[k]);
    if (t) return t;
  }
  return "";
}

// tool_input from a PreToolUse/PostToolUse payload (documented name first, then aliases).
export function toolInput(payload) {
  const ti = payload?.tool_input ?? payload?.toolInput ?? payload?.input;
  return (ti && typeof ti === "object") ? ti : {};
}

export function toolName(payload) {
  return String(payload?.tool_name || payload?.toolName || payload?.tool || "");
}

// Raw-payload capture for field discovery — enabled with TRANTOR_DEBUG_HOOKS=1 on the `kimi`
// process env. One JSON line per firing: {at, event, payload}.
export function debugHook(event, payload) {
  if (process.env.TRANTOR_DEBUG_HOOKS !== "1") return;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, "kimi-hook-debug.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), event, payload }) + "\n");
  } catch {}
}

// Pending startup-context stash. Kimi's SessionStart is observation-only — whether its stdout
// reaches the model's context is unverified — so sessionstart ALSO writes the context block
// here and prompt-focus (UserPromptSubmit, whose stdout IS documented to append to context)
// injects it on the session's first real prompt, then deletes it. Belt & braces: whichever
// path Kimi honors, the roster/handoff lands exactly once.
export function stashPath(session) {
  const safe = String(session || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(DATA_DIR, `kimi-startup-${safe}.txt`);
}

export function writeStash(session, text) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(stashPath(session), String(text || ""));
  } catch {}
}

export function takeStash(session) {
  try {
    const p = stashPath(session);
    if (!existsSync(p)) return "";
    const t = readFileSync(p, "utf8");
    try { appendFileSync(p + ".consumed", t); } catch {}
    try { writeFileSync(p, ""); } catch {}
    return t.trim();
  } catch { return ""; }
}

export { resolveProject, hostId, dirname, join, homedir };
