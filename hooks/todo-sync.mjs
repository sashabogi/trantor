#!/usr/bin/env node
// trantor PostToolUse(TodoWrite) — mirror the session's todo list onto its project board as cards,
// so SOLO work (no crew fired up) shows up live and accrues timeline history. The hub reconciles by
// todo text (pending/in_progress/completed -> todo/doing/done). Fail-silent by contract: a bad hub,
// a home-dir session, or any error must never block or break the tool flow.
import { homedir } from "node:os";
import { resolveProject, hostId } from "../lib/project.mjs";
import { signedPost } from "./lib/api.mjs";
function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 200); });
}

async function main() {
  // stdin FIRST: input.cwd is the session's own directory and it decides both the project and the
  // hub, so it has to be read before either is resolved.
  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}"); } catch { return; }
  const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Mirror sessionstart/heartbeat: home-directory sessions aren't project work — don't card them
  // (would spawn a phantom "<username>" board). Opt in with RELAY_SESSION/RELAY_PROJECT.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) return;
  if (input.tool_name && input.tool_name !== "TodoWrite") return;   // the matcher should scope us, but be safe
  const todos = input.tool_input?.todos;
  if (!Array.isArray(todos) || !todos.length) return;

  // Identity EXACTLY as mcp.mjs/heartbeat resolve it, so we card the same peer the relay registered.
  // This said `basename(projectDir)` and `hostname()`, which is not the same thing at all:
  // resolveProject keys off the GIT ROOT (a subdirectory forked its own lane) and hostId is the
  // stable machine id, where hostname() drifts to "MacBook-Pro-M1.local" on some networks and
  // splits one machine into two peers.
  const project = resolveProject(projectDir);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);

  await signedPost("/todos", { session, project, by: session, todos: todos.map(t => ({ content: t.content, status: t.status })) });
}

// Never block or break the tool flow: swallow everything, always exit clean.
main().catch(() => {}).finally(() => process.exit(0));
