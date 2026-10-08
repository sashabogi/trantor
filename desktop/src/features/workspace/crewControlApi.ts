import { invoke } from "@tauri-apps/api/core";
import type { AgentSettingsStatus, AgentStatus } from "../settings/agents/agentSettings";

export type SeatWhy = { state: string; why: string; advice: string };
export type CrewResult = { ok: boolean; action: string; seat: string; to?: string; reason?: string };
export type CrewAction = "up" | "down" | "swap";
export type Balance = { provider: string; ok: boolean; remaining?: number; remainingPct?: number; currency?: string; error?: string };
export type CrewCatalog = { agents: AgentStatus[]; balances: Balance[] };
export type CliRunner = (project: string, args: string[]) => Promise<string>;
const runCliJson: CliRunner = (project, args) => invoke<string>("workspace_cli", { project, args });

// SAFETY: these are the installed CLI's JSON response contracts; malformed JSON rejects the call.
const decode = <T,>(raw: string): T => JSON.parse(raw) as T;
export function createCrewApi(run: CliRunner = runCliJson) {
  return {
    async catalog(project: string): Promise<CrewCatalog> {
      const [settings, balances] = await Promise.all([
        run(project, ["agent-settings", "status", "--json"]),
        run(project, ["balances", "--json"]),
      ]);
      return { agents: decode<AgentSettingsStatus>(settings).agents, balances: decode<{ balances: Balance[] }>(balances).balances };
    },
    async why(project: string, seat: string) {
      return decode<SeatWhy>(await run(project, ["seat-why", seat, "--json"]));
    },
    async action(project: string, action: CrewAction, seat: string, replacement?: string) {
      if (!seat || (action === "swap" && !replacement)) throw new Error("A seat and swap destination are required");
      const args = action === "swap" ? [action, seat, replacement!, "--json"] : [action, seat, "--json"];
      return decode<CrewResult>(await run(project, args));
    },
  };
}
export type CrewApi = ReturnType<typeof createCrewApi>;
export const crewApi = createCrewApi();
export const canStart = (state: string) => state === "parked" || state === "no-runner" || state.startsWith("dead-");
export function balanceFor(agent: AgentStatus, balances: Balance[]) {
  const provider = agent.launch.split(":")[1]?.split("/")[0] ?? agent.id;
  return balances.find(b => b.provider === provider || (provider === "zai-coding-plan" && b.provider === "zai"));
}
export function quotaLabel(balance?: Balance) {
  if (!balance) return "quota unknown";
  if (!balance.ok) return balance.error || "quota unavailable";
  if (balance.remainingPct != null) return `${balance.remainingPct}% left`;
  if (balance.remaining != null) return `${balance.remaining} ${balance.currency ?? "credits"} left`;
  return "quota unknown";
}
export function availableAgent(agent: AgentStatus, balances: Balance[]) {
  const b = balanceFor(agent, balances);
  return agent.installed && agent.enabled && (!b || (b.ok && (b.remainingPct == null || b.remainingPct > 0) && (b.remaining == null || b.remaining > 0)));
}
export function parkReason(why: SeatWhy) {
  const reason = why.why.match(/PARKED \(([^)]+)\)/)?.[1] ?? why.why;
  const reset = why.advice.match(/\(in ([^)]+)\)/)?.[1];
  return `${reason}${reset ? ` · resets in ${reset}` : " · no reset timer"}`;
}
