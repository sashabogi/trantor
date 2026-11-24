// Loads the four hub reads the Usage screen aggregates; each fails on its own (#13991).
import { useCallback, useEffect, useState } from "react";
import type { Card, Economics, HubClient, Learning, Peer } from "../../../shared/api/client";

export type Source<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "failed"; error: string };
const LOADING = { state: "loading" } as const;

export type UsageData = {
  economics: Source<Economics>;
  learning: Source<Learning>;
  tasks: Source<Card[]>;
  peers: Source<Peer[]>;
  /** Epoch ms of the last completed load, 0 before the first. */
  updatedAt: number;
  reload: () => void;
};

async function settle<T>(read: Promise<T>): Promise<Source<T>> {
  try { return { state: "ok", data: await read }; } catch (e) { return { state: "failed", error: e instanceof Error ? e.message : "request failed" }; }
}

/** A hub older than the series, or a proxy answering {}, must read as a failure rather than crash the screen. */
function checkLearning(l: Learning): Learning {
  if (!Array.isArray(l.agents) || !l.agentsByProject || !l.modelsByProject || !Array.isArray(l.lessons?.projects)) {
    throw new Error("the reply carried no per-agent series");
  }
  return l;
}

export const dataOf = <T,>(s: Source<T>): T | null => (s.state === "ok" ? s.data : null);

export function useUsageData(client: HubClient): UsageData {
  const [economics, setEconomics] = useState<Source<Economics>>(LOADING);
  const [learning, setLearning] = useState<Source<Learning>>(LOADING);
  const [tasks, setTasks] = useState<Source<Card[]>>(LOADING);
  const [peers, setPeers] = useState<Source<Peer[]>>(LOADING);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const [e, l, t, p] = await Promise.all([settle(client.economics()), settle(client.learning().then(checkLearning)), settle(client.tasks()), settle(client.peers())]);
      if (!alive) return;
      setEconomics(e); setLearning(l); setTasks(t); setPeers(p); setUpdatedAt(Date.now());
    };
    void run();
    return () => { alive = false; };
  }, [client, tick]);

  const reload = useCallback(() => setTick(n => n + 1), []);
  return { economics, learning, tasks, peers, updatedAt, reload };
}
