// One place the Agents screen reads from: peers, cards, plans, machines, and who is waiting on the human (#13992).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Card, HubClient, Peer } from "../../../shared/api/client";
import { usePeers } from "../../../shared/presence";
import { useTasks } from "../../../shared/tasks";
import { useMachinesHealth } from "../../../features/fleet/MachineHealth";
import { useBalances } from "../../shell/useBalances";
import { sessionsNeedingYou, toSeatViews, type SeatView } from "./model";

const POLL_MS = 20_000;

function useNeedsYou(client: HubClient): Set<string> {
  const [needs, setNeeds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const pull = () => Promise.all([
      client.proposals({ status: "pending" }).then(r => r.proposals ?? []).catch(() => []),
      client.holds().then(r => r.holds ?? []).catch(() => []),
    ]).then(([p, h]) => { if (alive) setNeeds(sessionsNeedingYou(p, h)); });
    void pull();
    const t = setInterval(() => void pull(), POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [client]);
  return needs;
}

export type AgentsData = {
  peers: Peer[] | null;
  error: string | null;
  views: SeatView[];
  cards: Card[];
  balances: ReturnType<typeof useBalances>;
  machines: ReturnType<typeof useMachinesHealth>;
  /** After a crew action: re-derive presence at once; peers land on the next presence event or poll. */
  refresh: () => void;
};

export function useAgentsData(client: HubClient): AgentsData {
  const { peers, error } = usePeers(client);
  const cards = useTasks(client);
  const balances = useBalances(client);
  const machines = useMachinesHealth(client);
  const needs = useNeedsYou(client);
  // Presence decays with the clock, so re-derive on a tick as well as on new peers.
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(n => n + 1), []);
  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 15_000); return () => clearInterval(t); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const views = useMemo(() => toSeatViews(peers ?? [], needs), [peers, needs, tick]);
  return { peers, error, views, cards, balances, machines, refresh };
}
