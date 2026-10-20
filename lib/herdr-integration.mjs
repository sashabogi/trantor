// Is herdr's own claude integration installed? Session identity in the desktop app relies on it
// reporting the session at SessionStart (pane.report_agent_session), and nothing else checks it.
import { spawnSync } from "node:child_process";

export const HERDR_CLAUDE_INSTALL = "herdr integration install claude";

/** Decide from `herdr integration status` output (pure; `ran` false = herdr would not start).
 *  Returns { state: absent | installed | outdated | missing | unknown, detail }; an unrecognised
 *  shape is "unknown", never an error. */
export function claudeIntegrationState({ ran, status = 0, stdout = "" } = {}) {
  if (!ran) return { state: "absent", detail: "herdr is not installed" };
  if (status !== 0) return { state: "unknown", detail: `herdr integration status exited ${status}` };
  const line = String(stdout).split("\n").map((l) => l.trim()).find((l) => l.startsWith("claude:"));
  if (!line) return { state: "unknown", detail: "no claude line in the herdr integration status output" };
  const rest = line.slice("claude:".length).trim();
  if (/^not installed\b/i.test(rest)) return { state: "missing", detail: rest };
  if (/^outdated\b/i.test(rest)) return { state: "outdated", detail: rest };
  if (/^current\b/i.test(rest)) return { state: "installed", detail: rest };
  return { state: "unknown", detail: rest };
}

/** Run the read-only probe. A missing binary, a timeout or a crash all fold into the decision. */
export function probeClaudeIntegration(run = spawnSync) {
  const r = run("herdr", ["integration", "status"], { encoding: "utf8", timeout: 5000 });
  if (r.error?.code === "ENOENT") return claudeIntegrationState({ ran: false });
  if (r.error) return { state: "unknown", detail: String(r.error.message || r.error) };
  return claudeIntegrationState({ ran: true, status: r.status ?? 1, stdout: r.stdout });
}
