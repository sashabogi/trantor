// The Workspace tab row as data: one PaneTarget per crew seat plus the operator's own
// orchestrator pane leading the row. Pure, so the identity split below stays tested.
//
// Two identities live on every row and must not be conflated (the 0.3.99 regression did):
//   agent  — the herdr pane name. surfaceFor(project, agent) resolves the live terminal by it,
//            so the orchestrator row keeps "orchestrator", the name Rust gives its pane.
//   brand  — what the tab's mark reads. For the orchestrator that is the HOST session
//            (MacBook-*:project), which brandFor's host-name rule resolves to Claude (#5890).
import type { Peer } from "../../shared/api/client";
import type { HerdrSeat } from "./herdr";

export type PaneTarget = {
  key: string;
  label: string;
  /** herdr pane name — the terminal lookup key, never the brand */
  agent: string;
  /** the identity the tab's mark reads from */
  brand: string;
  session: string;
  online: boolean;
  lastSeen?: number;
  status?: string;
  isOrchestrator: boolean;
};

export const seatName = (session: string) => session.split(":")[0];

// #6148: a bus session of the project is not automatically a seat. The CLI's genesis identity
// (kind "genesis") exists to post the brief and must not render as a seat you could open a
// terminal on. A peer with NO kind — an old hub that never sent the field — stays a seat:
// absence of evidence must not evict real agents.
export const isAgentPeer = (p: Peer): boolean => {
  const kind = p.kind ?? "";
  return kind === "" || kind === "agent";
};

export function paneTargets(seats: Peer[], orch: HerdrSeat | null, host: Peer | undefined, project: string): PaneTarget[] {
  const rows: PaneTarget[] = seats.map(s => ({
    key: s.session,
    label: seatName(s.session),
    agent: seatName(s.session),
    brand: seatName(s.session),
    session: s.session,
    online: !!s.online,
    lastSeen: s.lastSeen,
    status: s.status,
    isOrchestrator: false,
  }));
  if (!orch) return rows;
  // Leads the row: it is the session the person actually drives, not a worker to supervise.
  return [{
    key: "__orchestrator__",
    label: "orchestrator",
    agent: orch.agent,
    brand: host?.session ?? orch.agent,
    session: host?.session ?? `${project} orchestrator`,
    online: host ? !!host.online : true,
    lastSeen: host?.lastSeen,
    status: host?.status,
    isOrchestrator: true,
  }, ...rows];
}
