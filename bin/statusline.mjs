#!/usr/bin/env node
// agent-bus statusline — prints a tiny live indicator for the agent's status bar:
//   🟢 agent-bus · 3 live
// Claude Code: add to settings.json ->
//   "statusLine": { "type": "command", "command": "node /path/to/agent-bus/bin/statusline.mjs" }
// Reads session info as JSON on stdin (Claude Code convention); fast + fail-silent.
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const c = join(homedir(), ".agent-bus", "config.json"); if (existsSync(c)) { const u = JSON.parse(readFileSync(c, "utf8")).url; if (u) return u; } } catch {}
  return "http://127.0.0.1:4477";
}
async function main() {
  let stdin = ""; try { for await (const c of process.stdin) stdin += c; } catch {}
  let cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try { const j = JSON.parse(stdin || "{}"); cwd = j.cwd || j.workspace?.current_dir || cwd; } catch {}
  const me = process.env.RELAY_SESSION || `${hostname()}:${basename(cwd)}`;
  try {
    const r = await fetch(`${relayUrl()}/peers`, { signal: AbortSignal.timeout(800) });
    const { peers } = await r.json();
    const live = peers.filter(p => p.online && p.session !== me).length;
    process.stdout.write(`\x1b[38;5;43m● agent-bus\x1b[0m \x1b[2m· ${live} other${live === 1 ? "" : "s"} live\x1b[0m`);
  } catch {
    process.stdout.write(`\x1b[2m○ agent-bus offline\x1b[0m`);   // hub unreachable
  }
}
main();
