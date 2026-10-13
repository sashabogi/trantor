// The seats a scope picker offers for a project: the mode pane's footer (#5841) and the Graph
// lens's chips (#11597) both derive from this one rule, so the two pickers can never disagree
// about which worktrees exist.
import type { Peer } from "../../shared/api/client";

const seatName = (session: string) => session.split(":")[0];

export function scopeSeats(peers: Peer[], project: string): string[] {
  return peers
    .filter(p => p.session.endsWith(`:${project}`) && !p.session.toLowerCase().startsWith("macbook"))
    .map(p => seatName(p.session));
}
