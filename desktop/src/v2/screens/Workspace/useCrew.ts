// Crew controls for the 2.0 Workspace: the classic crew CLI bridge, start, stop and swap (#13987).
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { availableAgent, crewApi, startFailureReason, type CrewApi, type CrewCatalog } from "../../../features/workspace/crewControlApi";
import type { AgentStatus } from "../../../features/settings/agents/agentSettings";

/** `quiet`: a muted line that stays until dismissed (no red, no auto-clear). */
export type Notice = { text: string; failed: boolean; quiet?: boolean } | null;

export type Crew = {
  /** Agents that are installed, enabled and have quota: what Add seat and Swap can offer. */
  available: AgentStatus[];
  unavailableReason?: (exclude?: string) => string;
  notice: Notice;
  busy: boolean;
  start: (seat: string) => Promise<void>;
  stop: (seat: string) => Promise<void>;
  stopHelper: (pane: string) => Promise<void>;
  swap: (seat: string, replacement: string) => Promise<void>;
  dismiss: () => void;
};

export function unavailableAgentReason(catalog: CrewCatalog | null, exclude?: string): string {
  if (!catalog) return "Reading installed agents";
  const agents = catalog.agents.filter(a => a.id !== exclude);
  if (!agents.length) return exclude ? "No other agents are configured" : "No agents are configured";
  const installed = agents.filter(a => a.installed);
  if (!installed.length) return "No agent CLI is installed. Open Settings > Accounts to set one up.";
  const enabled = installed.filter(a => a.enabled);
  if (!enabled.length) return "Installed agents are disabled. Enable one in Settings > Agents.";
  return "Enabled agents have no usable quota. Check their plans in Settings > Accounts.";
}

export function useCrew(project: string, onChanged: () => void, api: CrewApi = crewApi): Crew {
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CrewCatalog | null>(null);
  // #13987 drill: the screen is not remounted on a project switch, so a notice is owned by the project that raised it.
  const [owned, setOwned] = useState<{ project: string; notice: Notice }>({ project, notice: null });
  const notice = owned.project === project ? owned.notice : null;
  const setNotice = useCallback((n: Notice) => setOwned({ project, notice: n }), [project]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setCatalog(null);
    setCatalogError(null);
    api.catalog(project).then(c => { if (alive) setCatalog(c); })
      .catch(e => { if (alive) { const text = `Seat catalog unavailable for ${project}: ${e instanceof Error ? e.message : String(e)}`; setCatalogError(text); setNotice({ text, failed: false, quiet: true }); } });
    return () => { alive = false; };
  }, [api, project, setNotice]);
  useEffect(() => {
    if (!notice || notice.failed || notice.quiet) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  const run = useCallback(async (seat: string, verb: string, go: () => Promise<{ ok: boolean; reason?: string }>) => {
    setBusy(true);
    setNotice({ text: `${seat} · ${verb}…`, failed: false });
    try {
      const r = await go();
      if (r.ok) setNotice({ text: `${seat} · done`, failed: false });
      else {
        const why = await api.why(project, seat).catch(() => null);
        setNotice({ text: `${seat} · ${startFailureReason(seat, r.reason, why)}`, failed: true });
      }
    } catch (e) {
      setNotice({ text: `${seat} · ${String(e)}`, failed: true });
    } finally {
      setBusy(false);
      onChanged();
    }
  }, [api, project, onChanged, setNotice]);

  const launchOf = (seat: string) => catalog?.agents.find(a => a.id === seat)?.launch ?? seat;
  return {
    available: catalog ? catalog.agents.filter(a => availableAgent(a, catalog.balances)) : [],
    unavailableReason: exclude => catalogError ?? unavailableAgentReason(catalog, exclude),
    notice, busy,
    start: seat => run(seat, "starting", () => api.action(project, "up", launchOf(seat))),
    stop: seat => run(seat, "stopping", () => api.action(project, "down", seat)),
    stopHelper: pane => run(pane, "stopping", async () => {
      await invoke<string>("workspace_cli", { project, args: ["helper", "stop", pane, "--json"] });
      return { ok: true };
    }),
    swap: (seat, replacement) => run(seat, "swapping", () => api.action(project, "swap", seat, launchOf(replacement))),
    dismiss: () => setNotice(null),
  };
}
