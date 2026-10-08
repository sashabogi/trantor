// #7430: preflight skips busy or nonlocal recipients; uncertain local discovery leaves duty a nudge.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { busDir, hostId } from "./project.mjs";

const BUSY_STATUSES = new Set(["working", "busy"]);

// #11109: the recorded session outranks cwd; stale panes often share the orchestrator's directory.
export function recipientPanes(project, mapped, agents) {
  const claude = (Array.isArray(agents) ? agents : []).filter(agent => agent?.agent === "claude");
  const exact = mapped ? claude.filter(agent => agent.agent_session?.value === mapped) : [];
  return exact.length ? exact : claude.filter(agent => String(agent.cwd || "").split("/").pop() === project);
}

export function recipientVerdict(recipient, { localHost, mapped, agents }) {
  // Remote hosts and crew slugs (`glm:trantor`) have no socket here: the hub delivers their mail
  // through their own runners, so a nudge from this machine is neither possible nor needed.
  if (!String(recipient || "").startsWith(`${localHost}:`)) return "unknown";
  const project = recipient.slice(localHost.length + 1);
  const panes = recipientPanes(project, mapped, agents);
  // #11109: uncertain local discovery must reach duty's ListAgents, never a permanent terminal mark.
  if (panes.length !== 1) return mapped || panes.length ? "unresolved" : "unknown";
  return BUSY_STATUSES.has(panes[0].agent_status) ? "busy" : "idle";
}

function defaultListAgents() {
  return new Promise((resolve, reject) => {
    execFile("herdr", ["agent", "list"], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
      });
  });
}

function defaultReadText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

// The resolveRecipient for claimDutyNudges (#7430): the herdr agent list is cached briefly so a
// batch of recipients costs one exec; a herdr failure always THROWS (fail open), only a healthy
// observation may declare a recipient busy or terminal.
export function dutyRecipientResolver({
  localHost = hostId(), bus = busDir(), listAgents = defaultListAgents, readText = defaultReadText,
} = {}) {
  let cache = { at: 0, agents: [] };
  return async recipient => {
    // Remote recipients are decided without touching herdr: no local sources, no local wait.
    if (!String(recipient || "").startsWith(`${localHost}:`)) return "unknown";
    const project = recipient.slice(localHost.length + 1);
    const mapped = readText(join(bus, "orch-sessions.txt")).split("\n")
      .find(line => line.split("\t")[0] === project)?.split("\t")[1]?.trim() || "";
    if (Date.now() - cache.at > 2000) {
      const agents = await listAgents();   // throws on failure: the caller fails open
      cache = { at: Date.now(), agents: Array.isArray(agents?.result?.agents) ? agents.result.agents : [] };
    }
    return recipientVerdict(recipient, { localHost, mapped, agents: cache.agents });
  };
}
