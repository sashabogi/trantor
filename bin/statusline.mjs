#!/usr/bin/env node
// trantor statusline — prints a tiny live indicator for the agent's status bar:
//   🟢 trantor · 3 live
// Claude Code: add to settings.json ->
//   "statusLine": { "type": "command", "command": "node /path/to/trantor/bin/statusline.mjs" }
// Reads session info as JSON on stdin (Claude Code convention); fast + fail-silent.
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";

// Signed read via the shared client (2026-07-31, agent-UX audit): unsigned /peers is a dead 401
// under enforce, which painted "trantor offline" while the hub was fine.
import { sessionContext, signedGet } from "../hooks/lib/api.mjs";
async function main() {
  let stdin = ""; try { for await (const c of process.stdin) stdin += c; } catch {}
  let cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try { const j = JSON.parse(stdin || "{}"); cwd = j.cwd || j.workspace?.current_dir || cwd; } catch {}
  const me = process.env.RELAY_SESSION || sessionContext(cwd).session;
  try {
    const r = await signedGet("/peers", { timeoutMs: 800, session: me });
    if (!r.ok) throw new Error(`hub ${r.status}`);
    const { peers } = r.json;
    const live = peers.filter(p => p.online && p.session !== me).length;
    process.stdout.write(`\x1b[38;5;43m● trantor\x1b[0m \x1b[2m· ${live} other${live === 1 ? "" : "s"} live\x1b[0m`);
  } catch {
    process.stdout.write(`\x1b[2m○ trantor offline\x1b[0m`);   // hub unreachable
  }
}
main();
