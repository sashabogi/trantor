#!/usr/bin/env node
// trantor Stop / UserPromptSubmit hook (#9814) — a pane session whose turn ENDS on a question to
// the operator is waiting, not idle. The app maps a peer status of "blocked …" to needs-you, so at
// Stop we stamp "blocked · awaiting operator" when the final assistant paragraph ends in "?" or an
// ask sidecar is still open (#7776); it clears on the next prompt or a convergent no-question Stop.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sessionContext, signedPost } from "./lib/api.mjs";
import { endsWithOperatorQuestion, lastAssistantText } from "./lib/await-operator.mjs";

const TIMEOUT_MS = Number(process.env.RELAY_AWAIT_OPERATOR_TIMEOUT_MS || 1500);
const AWAITING_STATUS = "blocked · awaiting operator";

const busDir = () => process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
const stampPath = (session) =>
  join(busDir(), `await-operator-${String(session).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
// Same sanitising as ask-sidecar.mjs's sidecarPath: a session id is a file name, nothing more.
const sidecarPath = (sid) => {
  const s = String(sid ?? "").trim();
  return s && s !== "." && s !== ".." && /^[A-Za-z0-9._-]+$/.test(s) ? join(busDir(), "asks", `${s}.json`) : null;
};

function readStdin() {
  return new Promise(res => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 400);
  });
}

// The restore vocabulary is mcp.mjs's boot registration ("active in <project>"), which the app
// reads as idle — exactly what a session that just got its answer is.
async function clearStamp(session, project) {
  try { unlinkSync(stampPath(session)); } catch {}
  await signedPost("/register", { session, project, status: `active in ${project}` }, { session, timeoutMs: TIMEOUT_MS });
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}
  const event = String(input.hook_event_name ?? "");
  const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Mirror the other hooks: a home-directory session isn't project work and isn't on the bus.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) return;
  if (process.env.TRANTOR_SEAT) return;   // the runner owns a crew seat's status vocabulary
  const { session, project } = sessionContext(projectDir);
  const stamped = existsSync(stampPath(session));

  if (event === "UserPromptSubmit") {
    if (stamped) await clearStamp(session, project);
    return;
  }
  if (event !== "Stop") return;

  const sidecar = sidecarPath(input.session_id);
  const viaSidecar = sidecar !== null && existsSync(sidecar);
  const asked = viaSidecar || endsWithOperatorQuestion(lastAssistantText(input.transcript_path));
  if (!asked) {
    if (stamped) await clearStamp(session, project);   // the turn kept moving; the wait is over
    return;
  }
  const r = await signedPost("/register", { session, project, status: AWAITING_STATUS }, { session, timeoutMs: TIMEOUT_MS });
  if (r.ok) {
    try {
      mkdirSync(busDir(), { recursive: true });
      writeFileSync(stampPath(session), JSON.stringify({ ts: Date.now(), via: viaSidecar ? "ask-sidecar" : "question" }));
    } catch {}
  }
}

main().catch(() => {}).finally(() => {
  try { process.stdout.write("{}"); } catch {}
  process.exit(0);
});
