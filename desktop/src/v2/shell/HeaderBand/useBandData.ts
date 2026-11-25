// #14256: independent sources keep one unavailable service from blanking the header.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileHold, HubClient, Proposal } from "../../../shared/api/client";
import { usePeers } from "../../../shared/presence";
import { usePendingProposals } from "../../../shared/Proposals";
import { usePendingHolds } from "../../../shared/FileHolds";
import { useScopeGit } from "../../screens/Code/useScopeGit";
import { laneRows } from "./SeatLanes";

export type CiStatus = {
  sha: string | null; tag: string | null;
  ci: { state: "running" | "green" | "red" | null; failing?: string; url?: string } | null;
};

function usePoll<T>(read: () => Promise<T>, delay: (value: T | null) => number): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let last: T | null = null;
    setValue(null);
    const load = async () => {
      try {
        const next = await read();
        if (active) { last = next; setValue(next); }
      } catch { /* #14256: retain the last successful sample during a transient outage. */ }
      if (active) timer = setTimeout(load, delay(last));
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [read, delay]);
  return value;
}

const everyThirtySeconds = () => 30_000;
export const ciPollDelay = (value: CiStatus | null) => value?.ci?.state === "running" ? 60_000 : 300_000;

export function usePhaseData(client: HubClient, project: string) {
  return usePoll(useCallback(() => client.phases(project), [client, project]), everyThirtySeconds);
}

export function useLaneData(client: HubClient, project: string) {
  const turns = usePoll(useCallback(() => client.turns({ project, since: Date.now() - 3_600_000 }), [client, project]), everyThirtySeconds);
  const { peers } = usePeers(client);
  const [now, setNow] = useState(Date.now);
  const [workingSince, setWorkingSince] = useState<Record<string, number>>({});
  useEffect(() => {
    const working = laneRows(peers ?? [], turns ?? [], project).filter(lane => lane.status === "working");
    setWorkingSince(previous => Object.fromEntries(working.map(lane => [lane.persona, previous[lane.persona] ?? Date.now()])));
  }, [peers, turns, project]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  return { turns: turns ?? [], peers: peers ?? [], now, workingSince };
}

export function useHealthData(project: string) {
  const { state } = useScopeGit(project, null);
  const status = usePoll(useCallback(async (): Promise<CiStatus> => JSON.parse(await invoke<string>("ci_status", { project })), [project]), ciPollDelay);
  return { snap: state.kind === "ok" ? state.snap : null, status };
}

export function pendingIds(project: string, proposals: Proposal[], holds: FileHold[]): string[] {
  return [
    ...proposals.filter(p => p.project === project && p.status === "pending").map(p => `proposal:${p.id}`),
    ...holds.filter(h => h.project === project && h.status === "pending").map(h => `hold:${h.id}`),
  ];
}

export function useNeedsData(client: HubClient, project: string) {
  const proposals = usePendingProposals(client);
  const holds = usePendingHolds(client);
  return pendingIds(project, proposals, holds);
}

export function useRisePulse(ids: string[]) {
  const previous = useRef({ count: 0, seen: new Set<string>() });
  const [pulse, setPulse] = useState(0);
  const signature = JSON.stringify(ids);
  useEffect(() => {
    const current: string[] = JSON.parse(signature);
    const history = previous.current;
    if (current.length > history.count && current.some(id => !history.seen.has(id))) setPulse(p => p + 1);
    current.forEach(id => history.seen.add(id));
    history.count = current.length;
  }, [signature]);
  return pulse;
}
