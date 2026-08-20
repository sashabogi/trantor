#!/usr/bin/env node
// Kimi dialect bridge: adapt Kimi hook payloads to the canonical Claude Code hooks.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const CHILD_TIMEOUT_MS = Number(process.env.KIMI_BRIDGE_CHILD_TIMEOUT_MS || 25_000);
const DATA_DIR = process.env.AGENT_BUS_DIR || process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");

const event = String(process.argv[2] || "");
const hookPath = String(process.argv[3] || "");

function resolveHookPath(path) {
  if (!path || isAbsolute(path)) return path;
  return fileURLToPath(new URL(path, import.meta.url));
}

function readStdin(timeoutMs = 100) {
  return new Promise(res => {
    let d = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", c => { d += c; });
      process.stdin.on("end", () => res(d));
      process.stdin.resume();
    } catch { res(d); }
    setTimeout(() => res(d), timeoutMs);
  });
}

function safeSession(session) {
  return String(session || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function stashPath(session) {
  return join(DATA_DIR, `kimi-stash-${safeSession(session)}.txt`);
}

function ensureDataDir() {
  try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function writeStash(session, text) {
  try {
    ensureDataDir();
    writeFileSync(stashPath(session), String(text || ""));
  } catch {}
}

function takeStash(session) {
  try {
    const p = stashPath(session);
    if (!existsSync(p)) return "";
    const text = readFileSync(p, "utf8");
    rmSync(p, { force: true });
    return text.trim();
  } catch { return ""; }
}

function debugHook(payload) {
  if (process.env.TRANTOR_DEBUG_HOOKS !== "1") return;
  try {
    ensureDataDir();
    appendFileSync(join(DATA_DIR, "kimi-hook-debug.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), event, payload }) + "\n");
  } catch {}
}

function joinParts(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function extractPrompt(payload) {
  if (!payload || typeof payload !== "object") return "";
  for (const key of ["prompt", "text", "user_prompt", "message", "input_text", "input"]) {
    const text = joinParts(payload[key]);
    if (text) return text;
  }
  return "";
}

function toolInput(payload) {
  const value = payload?.tool_input ?? payload?.toolInput ?? payload?.input;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toolName(payload) {
  return String(payload?.tool_name || payload?.toolName || payload?.tool || "");
}

function canonicalToolName(name) {
  return name === "TodoList" ? "TodoWrite" : name;
}

function normalizePayload(payload) {
  const out = { ...(payload && typeof payload === "object" ? payload : {}) };
  if (event) out.hook_event_name = event;

  const prompt = extractPrompt(out);
  if (prompt) out.prompt = prompt;

  const name = canonicalToolName(toolName(out));
  if (name) out.tool_name = name;

  const input = toolInput(out);
  if (Object.keys(input).length) out.tool_input = input;

  return out;
}

function runCanonical(payload) {
  return new Promise((resolve, reject) => {
    if (!hookPath) return reject(new Error("missing canonical hook path"));
    const resolvedHookPath = resolveHookPath(hookPath);
    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || homedir();
    const child = spawn(process.execPath, [resolvedHookPath], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      reject(new Error(`canonical hook timed out after ${CHILD_TIMEOUT_MS}ms`));
    }, CHILD_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

function parseEnvelope(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function contextFromEnvelope(envelope) {
  return String(envelope?.hookSpecificOutput?.additionalContext || "");
}

function blockReason(envelope, stderr) {
  if (envelope?.decision === "block" || envelope?.continue === false) {
    return String(envelope?.reason || envelope?.message || stderr || "blocked by canonical hook").trim();
  }
  return "";
}

function printContextForKimi(payload, ctx) {
  const session = payload.session_id || payload.session || "";
  if (event === "SessionStart") {
    writeStash(session, ctx);
    return;
  }
  if (event === "UserPromptSubmit") {
    const stash = takeStash(session);
    const combined = [stash, ctx].filter(Boolean).join("\n");
    if (combined) process.stdout.write(combined);
    return;
  }
  if (ctx && (event === "PostToolUse" || event === "PreToolUse" || event === "Stop")) {
    process.stdout.write(ctx);
  }
}

try {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch {}
  debugHook(payload);

  const translated = normalizePayload(payload);
  const result = await runCanonical(translated);
  if (result.status && result.status !== 0) {
    throw new Error(`canonical hook exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }

  const envelope = parseEnvelope(result.stdout);
  const reason = blockReason(envelope, result.stderr);
  if (reason) {
    process.stderr.write(reason + "\n");
    process.exit(2);
  }

  printContextForKimi(translated, contextFromEnvelope(envelope));
  process.exit(0);
} catch (err) {
  process.stderr.write(`[trantor] kimi bridge fail-open: ${err?.message || err}\n`);
  process.exit(0);
}
