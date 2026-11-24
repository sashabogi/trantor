// Crew controls for the 2.0 Workspace: the classic crew CLI bridge, start, stop and swap (#13987).
import { useCallback, useEffect, useState } from "react";
import { availableAgent, crewApi, startFailureReason, type CrewApi, type CrewCatalog } from "../../../features/workspace/crewControlApi";
import type { AgentStatus } from "../../../features/settings/agents/agentSettings";

export type Notice = { text: string; failed: boolean } | null;

export type Crew = {
  /** Agents that are installed, enabled and have quota: what Add seat and Swap can offer. */
  available: AgentStatus[];
  notice: Notice;
  busy: boolean;
  start: (seat: string) => Promise<void>;
  stop: (seat: string) => Promise<void>;
  swap: (seat: string, replacement: string) => Promise<void>;
  dismiss: () => void;
};

export function useCrew(project: string, onChanged: () => void, api: CrewApi = crewApi): Crew {
  const [catalog, setCatalog] = useState<CrewCatalog | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.catalog(project).then(c => { if (alive) setCatalog(c); })
      .catch(e => { if (alive) setNotice({ text: `Seat catalog unavailable: ${String(e)}`, failed: true }); });
    return () => { alive = false; };
  }, [api, project]);
  useEffect(() => {
    if (!notice || notice.failed) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

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
  }, [api, project, onChanged]);

  const launchOf = (seat: string) => catalog?.agents.find(a => a.id === seat)?.launch ?? seat;
  return {
    available: catalog ? catalog.agents.filter(a => availableAgent(a, catalog.balances)) : [],
    notice, busy,
    start: seat => run(seat, "starting", () => api.action(project, "up", launchOf(seat))),
    stop: seat => run(seat, "stopping", () => api.action(project, "down", seat)),
    swap: (seat, replacement) => run(seat, "swapping", () => api.action(project, "swap", seat, launchOf(replacement))),
    dismiss: () => setNotice(null),
  };
}
