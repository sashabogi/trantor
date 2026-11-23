// Is herdr's own claude integration installed? Session identity in the desktop app relies on it
// reporting the session at SessionStart (pane.report_agent_session), and nothing else checks it.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { codexRolloutCwd } from "./turn-usage.mjs";

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

const RESUMABLE = new Set(["claude", "codex", "gemini", "kimi", "opencode"]);
const validArg = (arg) => ![...arg].some(char => char === "'" || char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);
const validArgv = (args) => args.length > 0 && args.length <= 64
  && args.every(validArg)
  && Buffer.byteLength(args.join("\0")) <= 8192;

export function runnerResumeArgv({ agent, driver = agent, persona = agent, dir, runnerPath, model = "", effort = null, project, hub, sessionId }) {
  if (!sessionId || !RESUMABLE.has(driver)) return [];
  const args = ["node", runnerPath, persona, dir, "--agent", agent, "--persona", persona,
    "--project", project, "--hub", hub, "--resume", sessionId];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", JSON.stringify(effort));
  return validArgv(args.map(value => String(value || ""))) ? args.map(value => String(value || "")) : [];
}

export function herdrReportArgs({ pane, agent, state, sessionId = "", resumeArgv = [] }) {
  const args = ["pane", "report-agent", pane, "--source", "crew", "--agent", agent, "--state", state];
  if (sessionId && resumeArgv.length && validArgv(resumeArgv)) {
    args.push("--agent-session-id", sessionId, "--", ...resumeArgv);
  }
  return args;
}

const canonical = path => { try { return realpathSync(path); } catch { return String(path || ""); } };
const directoryNames = (path) => { try { return readdirSync(path); } catch { return []; } };

export function codexSessionId(sessionsRoot, cwd, sinceMs, { nowMs = Date.now(), lookbackDays = 14 } = {}) {
  if (!sessionsRoot || !cwd || !Number.isFinite(sinceMs)) return "";
  const want = canonical(cwd), pad = n => String(n).padStart(2, "0");
  let newest = { id: "", mtime: -1 };
  for (let i = -1; i < lookbackDays; i++) {
    const day = new Date(nowMs - i * 86400000);
    const dir = join(sessionsRoot, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    for (const name of directoryNames(dir)) {
      const match = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i.exec(name);
      if (!match) continue;
      const file = join(dir, name);
      let mtime;
      try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (mtime < sinceMs || mtime <= newest.mtime || canonical(codexRolloutCwd(file)) !== want) continue;
      newest = { id: match[1], mtime };
    }
  }
  return newest.id;
}

export function geminiSessionId(geminiRoot, cwd, sinceMs) {
  if (!geminiRoot || !cwd || !Number.isFinite(sinceMs)) return "";
  const want = canonical(cwd);
  const dirs = new Set([String(cwd), want].map(path => createHash("sha256").update(path).digest("hex")));
  try {
    const projects = JSON.parse(readFileSync(join(geminiRoot, "projects.json"), "utf8")).projects || {};
    for (const [root, name] of Object.entries(projects)) if (canonical(root) === want) dirs.add(name);
  } catch {}
  let newest = { id: "", mtime: -1 };
  for (const projectDir of dirs) {
    const parent = join(geminiRoot, "tmp", projectDir);
    try { if (canonical(readFileSync(join(parent, ".project_root"), "utf8").trim()) !== want) continue; } catch {}
    const dir = join(parent, "chats");
    for (const name of directoryNames(dir)) {
      if (!name.startsWith("session-") || (!name.endsWith(".json") && !name.endsWith(".jsonl"))) continue;
      const file = join(dir, name);
      let mtime;
      try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (mtime < sinceMs || mtime <= newest.mtime) continue;
      try {
        const text = readFileSync(file, "utf8");
        const record = JSON.parse(name.endsWith(".jsonl") ? text.split("\n")[0] : text);
        const id = String(record.sessionId || "");
        const roots = Array.isArray(record.directories) ? record.directories.map(canonical) : [];
        if (id && validArg(id) && (!roots.length || roots.includes(want))) newest = { id, mtime };
      } catch {}
    }
  }
  return newest.id;
}
