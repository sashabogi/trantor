// The seats a scope picker offers for a project: the mode pane's footer (#5841) and the Graph
// lens's chips (#11597) both derive from this one rule, so the two pickers can never disagree
// about which worktrees exist.
import { isHostSession } from "../../v2/ui/identity";
import type { Peer } from "../../shared/api/client";

const seatName = (session: string) => session.split(":")[0];

export function scopeSeats(peers: Peer[], project: string, machineId?: string): string[] {
  return peers
    .filter(p => p.session.endsWith(`:${project}`) && !isHostSession(p.session, machineId))
    .map(p => seatName(p.session));
}
