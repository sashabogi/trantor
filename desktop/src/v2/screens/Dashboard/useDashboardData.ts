// The Dashboard's data: one place that polls what the screen shows, reusing the classic hooks (#13986).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  knownProjects, localSessions, type Economics, type HubClient, type LocalSession, type MachinesHealthReport,
  type Message, type OverseerStatus,
} from "../../../shared/api/client";
import { usePendingHolds } from "../../../shared/FileHolds";
import { usePendingProposals } from "../../../shared/Proposals";
import { usePeers } from "../../../shared/presence";
import { hasSeen, onSeenChange } from "../../../shared/seen";
import { useTasks } from "../../../shared/tasks";
import { orchRestorables, type RestorableSession } from "../../../features/workspace/herdr";
import { dismissedSessionsApi } from "../../../features/workspace/dismissedSessions";
import { visibleRestorables } from "../../../features/workspace/restorables";

const SLOW_MS = 60_000;
const NO_MESSAGES: Message[] = [];
export type Interrupted = { rows: RestorableSession[]; drop: (project: string) => void };

/** Poll `load` on mount and every `ms`; a failed pull keeps the last value, an older hub just stays empty. */
function usePoll<T>(load: () => Promise<T>, deps: unknown[], ms: number, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    let alive = true;
    const pull = () => load().then(v => { if (alive) setValue(v); }).catch(() => {});
    void pull();
    const t = setInterval(() => void pull(), ms);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names the deps
  }, deps);
  return value;
}

function useMe(client: HubClient): string {
  const [me, setMe] = useState("");
  useEffect(() => {
    let alive = true;
    void invoke<string>("identity_name", { base: client.baseUrl }).then(n => { if (alive) setMe(n); }).catch(() => {});
    return () => { alive = false; };
  }, [client]);
  return me;
}

/** Messages to the human that are still unseen: what classic Inbox calls "needs an answer". */
function useHumanMessages(client: HubClient, me: string): Message[] {
  const [, bump] = useState(0);
  useEffect(() => onSeenChange(() => bump(n => n + 1)), []);
  const all = usePoll(
    () => (me ? client.inbox(me).then(r => (r.messages ?? []).filter(m => m.to === me)) : Promise.resolve([])),
    [client, me], 30_000, NO_MESSAGES);
  return all.filter(m => !hasSeen(m.id));
}

function useInterrupted(): Interrupted {
  const [rows, setRows] = useState<RestorableSession[]>([]);
  useEffect(() => {
    let alive = true;
    void Promise.all([orchRestorables(), dismissedSessionsApi.list().catch(() => [])])
      .then(([fresh, dismissed]) => { if (alive) setRows(visibleRestorables(fresh, dismissed)); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return { rows, drop: project => setRows(r => r.filter(x => x.project !== project)) };
}

export function useDashboardData(client: HubClient) {
  const me = useMe(client);
  const cards = useTasks(client);
  const peers = usePeers(client).peers ?? [];
  const proposals = usePendingProposals(client);
  const holds = usePendingHolds(client);
  const messages = useHumanMessages(client, me);
  const econ = usePoll<Economics | null>(() => client.economics(), [client], SLOW_MS, null);
  const machines = usePoll<MachinesHealthReport | null>(() => client.machinesHealth(), [client], SLOW_MS, null);
  const overseer = usePoll<OverseerStatus | null>(() => client.overseerStatus(), [client], SLOW_MS, null);
  const open = usePoll<LocalSession[]>(() => localSessions(), [], 30_000, []);
  const known = usePoll<string[]>(() => knownProjects(), [], 5 * SLOW_MS, []);
  const interrupted = useInterrupted();
  return { me, cards, peers, proposals, holds, messages, econ, machines, overseer, open, known, interrupted };
}

export type DashboardData = ReturnType<typeof useDashboardData>;
