// Retirement for ORCHESTRATOR panes (#8017). The reaper owns crew seats and tracking rows; an
// orchestrator pane belongs to nobody, so an untouched one stays a wakeable target carrying
// week-old context. This decides which panes may retire and performs the retirement with the
// machinery that already exists — the handoff writer, the session map, herdr.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { busDir, readConfig, orchSessionsPath, clearOrchSession, checkoutFor } from "./project.mjs";

export const DEFAULT_RETIRE_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

/** Where a deliberate retirement is recorded. Its absence is what makes a gone pane a CRASH. */
export function retiredLedgerPath(bus = busDir()) { return join(bus, "retired-panes.jsonl"); }

// Idle age alone never retires anything, so the threshold is only ever half the decision. 0 or a
// negative value disables retirement outright — the operator's off switch.
export function retireHours({ env = process.env, config = readConfig() } = {}) {
  const raw = env.TRANTOR_PANE_RETIRE_HOURS ?? config?.paneRetireHours;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RETIRE_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_RETIRE_HOURS;
}

export function retireEnabled(hours) { return Number.isFinite(hours) && hours > 0; }

/** Every project→session row in the orchestrator map. One row per project, TAB separated. */
export function orchSessionRows(path = orchSessionsPath()) {
  try {
    return readFileSync(path, "utf8").split("\n").flatMap(line => {
      const [project, sid] = line.split("\t");
      return project && sid && sid.trim() ? [{ project: project.trim(), sid: sid.trim() }] : [];
    });
  } catch { return []; }
}

/** The transcript for a session id, wherever its project slug lives (a renamed dir keeps the old). */
export function transcriptFor(sid, { claudeProjectsDir = join(homedir(), ".claude", "projects") } = {}) {
  if (!sid) return "";
  try {
    for (const d of readdirSync(claudeProjectsDir)) {
      const t = join(claudeProjectsDir, d, `${sid}.jsonl`);
      if (existsSync(t)) return t;
    }
  } catch {}
  return "";
}

/** How long since this pane's thread was last written to. No transcript = no evidence = null. */
export function idleMsFor(transcript, now = Date.now()) {
  try { return Math.max(0, now - statSync(transcript).mtimeMs); } catch { return null; }
}

// LIVENESS DECIDES, age only qualifies. Every one of these holds a pane open at ANY age: a pane
// mid-deploy read exactly like its five idle siblings on the morning this card was written.
export function livenessHold({ turnInFlight = false, agentStatus = "", openContracts = 0, transcriptMissing = false, processState = "unknown" } = {}) {
  if (transcriptMissing) return "no transcript on disk — nothing to hand off, and nothing proves it idle";
  // A turn only counts as in flight while something is still running it. A transcript frozen
  // mid-turn whose process is provably gone is a corpse, and a corpse is not work (#6668).
  if (turnInFlight && processState !== "dead") return "mid-turn: the transcript's last row still owes a result";
  if (["working", "busy"].includes(String(agentStatus))) return `herdr reports the agent ${agentStatus}`;
  if (openContracts > 0) return `${openContracts} contract(s) in flight`;
  return "";
}

/** The whole decision for one pane: retire, or hold with a reason a person can read. */
export function retireDecision(pane, { hours, now = Date.now() } = {}) {
  const idleMs = pane.idleMs;
  const hold = livenessHold(pane);
  if (hold) return { ...pane, retire: false, reason: hold };
  if (idleMs === null) return { ...pane, retire: false, reason: "idle age unknown" };
  const thresholdMs = hours * HOUR_MS;
  if (idleMs < thresholdMs) return { ...pane, retire: false, reason: `idle ${humanHours(idleMs)} — under the ${hours}h threshold` };
  return { ...pane, retire: true, reason: `idle ${humanHours(idleMs)}, no turn in flight, no open contract` };
}

export function humanHours(ms) {
  const h = ms / HOUR_MS;
  return h < 1 ? `${Math.round(ms / 60000)}m` : `${h.toFixed(h < 10 ? 1 : 0)}h`;
}

/** Has this project's pane already been retired? The ledger is the retired/crashed discriminator. */
export function retiredRows(path = retiredLedgerPath()) {
  try {
    return readFileSync(path, "utf8").split("\n").flatMap(l => {
      if (!l.trim()) return [];
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch { return []; }
}

export function isRetired(sid, path = retiredLedgerPath()) {
  return !!sid && retiredRows(path).some(r => r?.sid === sid);
}

export function recordRetirement(entry, path = retiredLedgerPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
    return true;
  } catch { return false; }
}

// ---- the live inputs -------------------------------------------------------
function herdrJson(args, exec = execFileSync) {
  try { return JSON.parse(exec("herdr", args, { encoding: "utf8", timeout: 15000 })); } catch { return null; }
}

/** herdr's view of this session: its pane id and what the agent is doing right now. */
export function herdrAgentFor(sid, { exec = execFileSync } = {}) {
  const agents = herdrJson(["agent", "list"], exec)?.result?.agents;
  if (!Array.isArray(agents)) return { pane: "", status: "", proven: false };
  const found = agents.find(a => a?.agent_session?.value === sid);
  return { pane: found?.pane_id || "", status: found?.agent_status || "", proven: true };
}

export function crewWindowsPath(bus = busDir()) { return join(bus, "crew-windows.txt"); }

/** The orchestrator pane herdr hosts for a project — last `orch` row wins, as the baton resolves it. */
export function orchPaneRow(project, path = crewWindowsPath()) {
  let pane = "";
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const f = line.split("\t");
      if (f[0] === project && f[1] === "orch" && f[3] && f[3].trim()) pane = f[3].trim();
    }
  } catch {}
  return pane;
}

/** Forget the tracked orch row for a retired pane, so no later `up`/`open` treats it as live. */
export function dropOrchRow(project, path = crewWindowsPath()) {
  try {
    if (!existsSync(path)) return false;
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const kept = rows.filter(r => { const f = r.split("\t"); return !(f[0] === project && f[1] === "orch"); });
    if (kept.length === rows.length) return false;
    writeFileSync(path, kept.length ? kept.join("\n") + "\n" : "");
    return true;
  } catch { return false; }
}

/** Gather every orchestrator pane with the facts the decision needs. */
export function collectPanes({
  rows = orchSessionRows(), now = Date.now(), turnInFlight, sessionProcessState = () => "unknown",
  herdrAgent = herdrAgentFor, contracts = () => 0, hostId = "",
} = {}) {
  return rows.map(({ project, sid }) => {
    const transcript = transcriptFor(sid);
    const agent = herdrAgent(sid);
    return {
      project, sid, transcript, pane: agent.pane || orchPaneRow(project),
      agentStatus: agent.status,
      idleMs: idleMsFor(transcript, now),
      transcriptMissing: !transcript,
      turnInFlight: transcript ? !!turnInFlight(transcript) : false,
      processState: sessionProcessState(sid),
      openContracts: contracts(hostId ? `${hostId}:${project}` : project),
    };
  });
}

// ---- the act ---------------------------------------------------------------
// Order matters and is not negotiable: the handoff and the checkpoint are written FIRST, so a
// failure anywhere after them still leaves the thread recoverable by `claude --resume <sid>`.
export async function retirePane(pane, {
  now = Date.now(), by = "retire", dry = false, exec = execFileSync,
  writeHandoff, buildSummary, clearMap = clearOrchSession, ledger = retiredLedgerPath(),
} = {}) {
  const steps = [];
  const projectDir = checkoutFor(pane.project) || "";
  if (dry) {
    return { ...pane, dry: true, steps: ["handoff", "checkpoint", "unmap", "close-pane"], projectDir };
  }
  let handoffFile = "";
  const summary = buildSummary(pane.transcript);
  const written = writeHandoff({
    projectDir: projectDir || pane.project, projectName: pane.project, sessionId: pane.sid,
    transcript: pane.transcript, trigger: "idle-retire", summary, force: true,
  });
  handoffFile = written?.file || "";
  steps.push(handoffFile ? "handoff" : `handoff-skipped:${written?.reason || "unknown"}`);

  // The checkpoint IS this row: it names the session id, so the conversation is resumable long
  // after the pane is gone, and its presence is what tells a later boot the pane was retired.
  const entry = {
    ts: now, project: pane.project, sid: pane.sid, pane: pane.pane || "",
    idleMs: pane.idleMs, reason: pane.reason || "", handoff: handoffFile,
    resume: `claude --resume ${pane.sid}`, by, retired: true,
  };
  steps.push(recordRetirement(entry, ledger) ? "checkpoint" : "checkpoint-failed");

  steps.push(clearMap(pane.project, by) ? "unmap" : "unmap-noop");

  // Closing the pane is what stops herdr restoring it at the next boot: a pane that is no longer
  // in the layout has nothing to resurrect, while a crashed one is still there.
  if (pane.pane) {
    const closed = herdrJson(["pane", "close", pane.pane], exec);
    steps.push(closed && !closed.error ? "close-pane" : "close-pane-failed");
    if (dropOrchRow(pane.project)) steps.push("drop-orch-row");
  } else steps.push("close-pane-skipped:no-pane-id");

  return { ...pane, steps, handoff: handoffFile, projectDir, entry };
}
