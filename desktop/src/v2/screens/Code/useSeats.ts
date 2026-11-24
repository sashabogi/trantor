// The project's seats with their branch, ahead count and presence (#13988): peers say who is live,
// git_panel says whether the seat has a worktree and where it stands against main.
import { useEffect, useState } from "react";
import type { HubClient, Peer } from "../../../shared/api/client";
import { scopeSeats } from "../../../features/code/scopeSeats";
import { gitPanel } from "../../../features/code/gitApi";
import { stateOf, usePeers, type PresenceState } from "../../../shared/presence";
import type { Presence } from "../../ui/identity";
import type { SeatInfo } from "./model";

const PRESENCE = { busy: "working", idle: "ready", offline: "offline" } as const satisfies Record<PresenceState, Presence>;

function peerFor(peers: Peer[], project: string, seat: string): Peer | undefined {
  return peers.find(p => p.session === `${seat}:${project}`);
}

export type SeatsResult = { seats: SeatInfo[]; peers: Peer[] | null };

export function useSeats(client: HubClient, project: string): SeatsResult {
  const { peers } = usePeers(client);
  const [seats, setSeats] = useState<SeatInfo[]>([]);
  useEffect(() => {
    if (!peers) return;
    let alive = true;
    const names = [...new Set(scopeSeats(peers, project))];
    Promise.all(names.map(async (seat): Promise<SeatInfo> => {
      const peer = peerFor(peers, project, seat);
      const base = { seat, presence: PRESENCE[peer ? stateOf(peer) : "offline"], machine: peer?.machine ?? null };
      try {
        const p = await gitPanel(project, seat);
        return { ...base, branch: p.branch || null, ahead: p.ahead, hasWorktree: true };
      } catch {
        return { ...base, branch: null, ahead: null, hasWorktree: false };
      }
    })).then(list => { if (alive) setSeats(list); });
    return () => { alive = false; };
  }, [peers, project]);
  return { seats, peers };
}
