// A seat's uncommitted diff from the classic seat_diff bridge: once on select, then live while Changes is open (#13987).
import { useEffect, useState } from "react";
import { seatDiff, type SeatDiff } from "../../../features/code/seatDiff";
import type { SeatView } from "./seatModel";

export type DiffState = { diff: SeatDiff | null; error: string | null };

const LIVE_MS = 15_000;

export function useSeatDiff(project: string, seat: SeatView | undefined, live: boolean): DiffState {
  const [state, setState] = useState<DiffState>({ diff: null, error: null });
  const agent = seat && !seat.isOrchestrator && !seat.isHelper && !seat.machine ? seat.agent : null;
  useEffect(() => {
    let alive = true;
    setState({ diff: null, error: null });
    if (!agent) return;
    const load = () => seatDiff(project, agent)
      .then(diff => { if (alive) setState({ diff, error: null }); })
      .catch(e => { if (alive) setState(s => ({ diff: s.diff, error: String(e) })); });
    load();
    if (!live) return () => { alive = false; };
    const iv = setInterval(load, LIVE_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [project, agent, live]);
  return state;
}
