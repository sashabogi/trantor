#!/usr/bin/env node
// Export a live AskUserQuestion before Claude's transcript flushes it (#6533).
import {
  mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionContext } from "./lib/api.mjs";

function readStdin() {
  return new Promise(res => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 400);
  });
}

const busDir = () => process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");

function sidecarPath(sessionId) {
  const sid = String(sessionId ?? "").trim();
  if (!sid || sid === "." || sid === ".." || !/^[A-Za-z0-9._-]+$/.test(sid)) return null;
  return join(busDir(), "asks", `${sid}.json`);
}

function toolUseId(input) {
  const id = input?.tool_use_id;
  return id === undefined || id === null || String(id).trim() === "" ? null : String(id);
}

function existingOpen(path, sessionId) {
  try {
    const stored = JSON.parse(readFileSync(path, "utf8"));
    return String(stored.session_id ?? "") === String(sessionId) ? stored : null;
  } catch {
    return null;
  }
}

function sameOpen(left, right) {
  return left.session_id === right.session_id && left.project === right.project &&
    left.cwd === right.cwd && (left.tool_use_id ?? null) === right.tool_use_id &&
    JSON.stringify(left.questions) === JSON.stringify(right.questions);
}

function writeOpen(input, path) {
  if (String(input.tool_name ?? "") !== "AskUserQuestion") return;
  const questions = input.tool_input?.questions;
  if (!Array.isArray(questions)) return;
  const cwd = String(input.cwd ?? "");
  const ctx = sessionContext(cwd);
  const stored = existingOpen(path, input.session_id);
  const incomingId = toolUseId(input);
  const payload = {
    session_id: String(input.session_id),
    project: ctx.project,
    cwd,
    tool_use_id: incomingId ?? stored?.tool_use_id ?? null,
    questions,
    ts: Date.now(),
  };
  if (stored && sameOpen(stored, payload)) return;
  const dir = join(busDir(), "asks");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${String(input.session_id)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function closeTool(input, path) {
  const stored = JSON.parse(readFileSync(path, "utf8"));
  const storedId = stored.tool_use_id ?? null;
  if (storedId === null || storedId === toolUseId(input)) unlinkSync(path);
}

try {
  const raw = await readStdin();
  const input = JSON.parse(raw || "{}");
  const path = sidecarPath(input?.session_id);
  if (path) {
    const event = String(input.hook_event_name ?? "");
    if (event === "PreToolUse" || event === "PermissionRequest") writeOpen(input, path);
    else if (event === "PostToolUse" || event === "PostToolUseFailure") closeTool(input, path);
    else if (event === "Stop") {
      try { unlinkSync(path); } catch {}
    }
  }
} catch {}

// Informational state only: never approve, deny, answer, or inject context.
process.stdout.write("{}");
