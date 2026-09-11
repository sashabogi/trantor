// #7430: the duty runner pre-flights every escalation recipient BEFORE it becomes a mandatory
// nudge. A recipient observed busy is a no-op (prompt rule 4a agrees), a recipient that is not a
// socket-nudgeable local interactive session is terminal, and a resolver that cannot see at all
// throws so lib/duty-nudges.mjs fails OPEN to a standing nudge.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { busDir, hostId } from "./project.mjs";

const BUSY_STATUSES = new Set(["working", "busy"]);

export function recipientVerdict(recipient, { localHost, mapped, agents }) {
  // Remote hosts and crew slugs (`glm:trantor`) have no socket here: the hub delivers their mail
  // through their own runners, so a nudge from this machine is neither possible nor needed.
  if (!String(recipient || "").startsWith(`${localHost}:`)) return "unknown";
  const project = recipient.slice(localHost.length + 1);
  const panes = (Array.isArray(agents) ? agents : []).filter(agent =>
    agent?.agent === "claude"
    && (agent.agent_session?.value === mapped || String(agent.cwd || "").split("/").pop() === project));
  // Zero or ambiguous panes both mean "no single local session to nudge" (#7429 agrees).
  if (panes.length !== 1) return "unknown";
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

/**
 * Build the `resolveRecipient` for claimDutyNudges. The herdr agent list is cached briefly so a
 * batch of recipients costs one exec; a herdr failure always THROWS (fail open) — only a healthy
 * observation may declare a recipient busy or terminal.
 */
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
