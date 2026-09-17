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
    left.event === right.event && (left.visible_ts ?? null) === right.visible_ts &&
    JSON.stringify(left.questions) === JSON.stringify(right.questions);
}

// The declaration the Chat chips render from (#7776): the first question, its options as offered,
// and whether several may be picked. Chips never invent an option that is not in this list.
function declaredAsk(questions) {
  const first = questions[0] ?? {};
  const question = String(first.question ?? "");
  if (!question) return null;
  const options = (Array.isArray(first.options) ? first.options : [])
    .map(o => ({ label: String(o?.label ?? ""), description: String(o?.description ?? "") }))
    .filter(o => o.label)
    .map(o => o.description ? o : { label: o.label });
  return { question, options, multi: first.multiSelect === true };
}

function writeAtomic(sessionId, path, payload) {
  const dir = join(busDir(), "asks");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${String(sessionId)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function writeOpen(input, path) {
  if (String(input.tool_name ?? "") !== "AskUserQuestion") return;
  const questions = input.tool_input?.questions;
  if (!Array.isArray(questions)) return;
  const cwd = String(input.cwd ?? "");
  const ctx = sessionContext(cwd);
  const stored = existingOpen(path, input.session_id);
  const incomingId = toolUseId(input);
  const now = Date.now();
  const permissionVisible = String(input.hook_event_name ?? "") === "PermissionRequest";
  const visibleTs = stored?.visible_ts ?? (permissionVisible ? now : null);
  const payload = {
    session_id: String(input.session_id),
    project: ctx.project,
    cwd,
    tool_use_id: incomingId ?? stored?.tool_use_id ?? null,
    kind: "AskUserQuestion",
    ask: declaredAsk(questions),
    questions,
    event: visibleTs === null ? "PreToolUse" : "PermissionRequest",
    visible_ts: visibleTs,
    ts: stored?.ts ?? now,
  };
  if (stored && sameOpen(stored, payload)) return;
  writeAtomic(input.session_id, path, payload);
}

// A relay_ask is the turn-ending ask (#7756): the question is out on the bus and the session
// idles at its prompt until the answer lands, so the sidecar stays open past Stop and closes on
// the next prompt. It offers no options: the card shows the question, chips show nothing.
const isRelayAsk = name => /(^|__)relay_ask$/.test(String(name ?? ""));

function writeRelayAsk(input, path) {
  const question = String(input.tool_input?.question ?? "").trim();
  if (!question) return;
  const cwd = String(input.cwd ?? "");
  const now = Date.now();
  writeAtomic(input.session_id, path, {
    session_id: String(input.session_id),
    project: sessionContext(cwd).project,
    cwd,
    tool_use_id: toolUseId(input),
    kind: "relay_ask",
    ask: { question, options: [], multi: false },
    questions: [{ question, header: "ask", multiSelect: false, options: [] }],
    event: "PreToolUse",
    visible_ts: now,
    ts: now,
  });
}

function closeTool(input, path) {
  const stored = JSON.parse(readFileSync(path, "utf8"));
  const storedId = stored.tool_use_id ?? null;
  if (storedId === null || storedId === toolUseId(input)) unlinkSync(path);
}

function closeTurn(path) {
  let stored = null;
  try { stored = JSON.parse(readFileSync(path, "utf8")); } catch {}
  if (stored?.kind === "relay_ask") return;
  try { unlinkSync(path); } catch {}
}

try {
  const raw = await readStdin();
  const input = JSON.parse(raw || "{}");
  const path = sidecarPath(input?.session_id);
  if (path) {
    const event = String(input.hook_event_name ?? "");
    if (event === "PreToolUse" && isRelayAsk(input.tool_name)) writeRelayAsk(input, path);
    else if (event === "PreToolUse" || event === "PermissionRequest") writeOpen(input, path);
    else if (event === "PostToolUse" || event === "PostToolUseFailure") closeTool(input, path);
    else if (event === "Stop") closeTurn(path);
    else if (event === "UserPromptSubmit") {
      try { unlinkSync(path); } catch {}
    }
  }
} catch {}

// Informational state only: never approve, deny, answer, or inject context.
process.stdout.write("{}");
