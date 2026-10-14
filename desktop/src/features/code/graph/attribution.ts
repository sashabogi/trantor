import { brandFor } from "../../../shared/Avatar";

export type AgentHistory = { agent: string; commits: number; lastAt: string; instances: string[] };
export type FileAttribution = { path: string; agents: AgentHistory[]; dominant: string };
export type Attribution = {
  head: string;
  files: FileAttribution[];
  agents: { agent: string; commits: number }[];
  coverage: { total: number; rules: { rule: string; commits: number; percent: number }[] };
};

export function aggregateAgents(rows: readonly (readonly AgentHistory[])[]): AgentHistory[] {
  const totals = new Map<string, AgentHistory>();
  for (const agents of rows) for (const row of agents) {
    const prev = totals.get(row.agent);
    totals.set(row.agent, {
      agent: row.agent,
      commits: (prev?.commits ?? 0) + row.commits,
      lastAt: prev && Date.parse(prev.lastAt) > Date.parse(row.lastAt) ? prev.lastAt : row.lastAt,
      instances: [...new Set([...(prev?.instances ?? []), ...row.instances])].sort(),
    });
  }
  return [...totals.values()].sort((a, b) => b.commits - a.commits || a.agent.localeCompare(b.agent));
}

export function agentColor(agent: string): string {
  return brandFor(agent === "orchestrator" ? "claude" : agent)?.hex ?? "var(--color-tr-muted)";
}

export function whoFill(agents: readonly AgentHistory[]): string {
  return `color-mix(in srgb, ${agentColor(agents[0]?.agent ?? "unknown")} 22%, transparent)`;
}

export function whoTitle(agents: readonly AgentHistory[], cluster = false): string {
  if (!agents.length) return "no attributed history";
  return agents.map(row => `${row.agent}: ${row.commits} ${cluster ? "file changes" : "commits"} · last ${row.lastAt} · ${row.instances.join(", ")}`).join("\n");
}
