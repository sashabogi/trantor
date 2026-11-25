// The real data behind the 2.0 Workspace: peers, the hosted orchestrator pane, cards, holds, autonomy (#13987).
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Card, FileHold, HubClient, Peer } from "../../../shared/api/client";
import { useTasks } from "../../../shared/tasks";
import { usePendingHolds } from "../../../shared/FileHolds";
import { herdrSeats, type HerdrSeat } from "../../../features/workspace/herdr";
import { paneTargets } from "../../../features/workspace/paneTargets";
import { hostPeer, seatPeers, seatViews, type SeatView } from "./seatModel";

const POLL_MS = 12_000;

export type WorkspaceData = {
  /** null until the first read, so "no seats" is never claimed before the hub answered. */
  seats: SeatView[] | null;
  cards: Card[];
  holds: FileHold[];
  refresh: () => void;
};

function usePeerList(client: HubClient) {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const refresh = useCallback(() => { client.peers().then(setPeers).catch(() => {}); }, [client]);
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, POLL_MS);
    const off = client.streamEvents(ev => { if (ev.type?.startsWith("presence")) refresh(); });
    return () => { clearInterval(iv); off?.(); };
  }, [client, refresh]);
  return { peers, refresh };
}

function useLocalPanes(project: string) {
  const [owned, setOwned] = useState<{ project: string; rows: HerdrSeat[] }>({ project, rows: [] });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion(v => v + 1), []);
  useEffect(() => {
    let alive = true;
    const look = () => { herdrSeats().then(rows => { if (alive) setOwned({ project, rows: rows.filter(r => r.project === project) }); }).catch(() => {}); };
    look();
    const iv = setInterval(look, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [project, version]);
  return { rows: owned.project === project ? owned.rows : [], refresh };
}

export function useWorkspaceData(client: HubClient, project: string): WorkspaceData {
  const { peers, refresh: refreshPeers } = usePeerList(client);
  const { rows, refresh: refreshPanes } = useLocalPanes(project);
  const refresh = useCallback(() => { refreshPeers(); refreshPanes(); }, [refreshPeers, refreshPanes]);
  const cards = useTasks(client, project);
  const allHolds = usePendingHolds(client);
  const holds = useMemo(() => allHolds.filter(h => h.project === project), [allHolds, project]);
  const seats = useMemo(() => {
    if (!peers && !rows.length) return null;
    const orch = rows.find(r => r.kind === "orch") ?? null;
    const targets = paneTargets(seatPeers(peers ?? [], project), orch, hostPeer(peers ?? [], project), project);
    return seatViews(targets, holds, rows.filter(r => r.kind === "helper"));
  }, [peers, rows, project, holds]);
  return { seats, cards, holds, refresh };
}

export type MayDo = { label: string; title: string } | null;

export type Autonomy = { harness?: string; push?: boolean; commit?: boolean };

/** The resolved dials from `autonomy_get`'s JSON; undefined when the CLI sent none. */
export function parseAutonomy(raw: string): Autonomy | undefined {
  // SAFETY: autonomy_get prints the installed CLI's JSON contract; every field is read as optional.
  return (JSON.parse(raw) as { resolved?: Autonomy }).resolved;
}

/** What the project's autonomy dials let a seat do, read from the same `autonomy_get` the classic composer reads. */
export function useMayDo(project: string): MayDo {
  const [mayDo, setMayDo] = useState<MayDo>(null);
  useEffect(() => {
    let alive = true;
    setMayDo(null);
    invoke<string>("autonomy_get", { project }).then(raw => {
      if (!alive) return;
      const r = parseAutonomy(raw);
      if (!r) return;
      const auto = r.harness === "bypass";
      setMayDo({
        label: auto ? "New sessions: full auto" : "New sessions: asks first",
        title: `${auto ? "Runs without asking" : "Asks before edits and commands"}; applies to new sessions and handoffs; commit ${r.commit ? "allowed" : "asks"}; push ${r.push ? "allowed" : "asks"}`,
      });
    }).catch(() => {});
    return () => { alive = false; };
  }, [project]);
  return mayDo;
}

/** The card a seat is working: its own assignee in doing or testing, never someone else's. */
export function cardOf(cards: Card[], seat: SeatView): Card | undefined {
  return cards.find(c => (c.status === "doing" || c.status === "testing") && c.assignee === seat.session)
    ?? cards.find(c => (c.status === "doing" || c.status === "testing") && c.assignee === seat.agent);
}
