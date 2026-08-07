#!/usr/bin/env node
// trantor PostToolUse(TodoList) — Kimi Code port of the TodoWrite mirror. Mirrors the session's
// todo list onto its project board as cards, so SOLO work (no crew fired up) shows up live and
// accrues timeline history. Kimi's TodoList tool takes {todos:[{title,status}]} with
// status ∈ pending|in_progress|done; the hub reconciles Claude's shape ({content,status}) with
// status ∈ pending|in_progress|completed — we map title→content and done→completed.
// Fail-silent by contract: a bad hub, a home-dir session, or any error must never break the flow.
import { readPayload, payloadCwd, isHomeSession, identity, relayUrl, toolInput, toolName, debugHook } from "./lib/common.mjs";

function mapStatus(s) {
  const v = String(s || "").toLowerCase();
  if (v === "done" || v === "completed" || v === "complete") return "completed";
  if (v === "in_progress" || v === "in-progress" || v === "doing") return "in_progress";
  return "pending";
}

async function main() {
  const payload = await readPayload(200);
  debugHook("PostToolUse:todo-sync", payload);
  const projectDir = payloadCwd(payload);
  if (isHomeSession(projectDir)) return;

  const tn = toolName(payload);
  if (tn && tn !== "TodoList") return;   // the matcher should scope us, but be safe
  const todos = toolInput(payload).todos;
  if (!Array.isArray(todos) || !todos.length) return;

  const { project, session } = identity(projectDir);

  try {
    await fetch(`${relayUrl()}/todos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session, project, by: session,
        todos: todos.map(t => ({ content: String(t?.content ?? t?.title ?? "").slice(0, 200), status: mapStatus(t?.status) }))
          .filter(t => t.content),
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {}
}

main().catch(() => {}).finally(() => process.exit(0));
