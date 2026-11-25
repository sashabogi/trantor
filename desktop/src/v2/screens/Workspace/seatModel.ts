// Pure seat model for the 2.0 Workspace: peers and hub holds in, chip and inspector facts out (#13987).
import type { FileHold, Peer } from "../../../shared/api/client";
import { hubActivity } from "../../../features/workspace/seatActivity";
import { isAgentPeer, type PaneTarget } from "../../../features/workspace/paneTargets";
import { ago } from "../../../shared/time";
import type { Presence } from "../../ui/identity";

export type SeatView = {
  key: string;
  /** Name a person reads: "codex-8", "orchestrator". */
  label: string;
  /** Pane name the terminal and crew CLI resolve the seat by. */
  agent: string;
  /** Identity the avatar colour reads from. */
  brand: string;
  session: string;
  presence: Presence;
  /** State in words: "working", "needs you", "ready", "offline". */
  words: string;
  /** Only set where the hub really has a timestamp: when an offline seat was last seen. */
  lastSeen?: number;
  machine?: string;
  isOrchestrator: boolean;
  target: PaneTarget;
};

/** The operator's own host session, the one rule every screen shares: not a seat, and no crew action may stop or swap it. */
export function isHostSession(session: string): boolean {
  return session.toLowerCase().startsWith("macbook");
}

/** A seat is a crew peer of this project; the human's own host session and non-agent tools are not seats (#13987). */
export function seatPeers(peers: Peer[], project: string): Peer[] {
  return peers
    .filter(p => p.session.endsWith(`:${project}`))
    .filter(p => !isHostSession(p.session))
    .filter(isAgentPeer);
}

export function hostPeer(peers: Peer[], project: string): Peer | undefined {
  return peers.find(p => p.session.endsWith(`:${project}`) && isHostSession(p.session));
}

const WORDS = { working: "working", "needs-you": "needs you", ready: "ready", offline: "offline" } as const satisfies Record<Presence, string>;

export function presenceOf(t: PaneTarget, holds: FileHold[]): Presence {
  if (!t.online) return "offline";
  if (holds.some(h => h.session === t.session)) return "needs-you";
  const a = hubActivity(t.status);
  if (a === "blocked") return "needs-you";
  if (a === "working") return "working";
  if (a === "down") return "offline";
  return "ready";
}

export function seatViews(targets: PaneTarget[], holds: FileHold[]): SeatView[] {
  return targets.map(t => {
    const presence = presenceOf(t, holds);
    return {
      key: t.key, label: t.label, agent: t.agent, brand: t.brand, session: t.session, presence,
      words: WORDS[presence], lastSeen: t.lastSeen, machine: t.machine, isOrchestrator: t.isOrchestrator, target: t,
    };
  });
}

export const liveSeats = (seats: SeatView[]) => seats.filter(s => s.presence !== "offline");
export const offlineSeats = (seats: SeatView[]) => seats.filter(s => s.presence === "offline");

/** "last seen 2h ago" from the real stamp, or "never seen". */
export function offlineNote(s: SeatView): string {
  return s.lastSeen ? `last seen ${ago(s.lastSeen)}` : "never seen";
}

/** Columns for N tiles, the same ceil(sqrt(n)) tiling the crew launcher uses. */
export function gridColumns(n: number): number {
  let c = 1;
  while (c * c < n) c += 1;
  return c;
}

export type Layout = "focus" | "split" | "grid";

/** Which seats the tiles show: Focus one, Split the selected plus the next live seat, Grid every live seat. */
export function visibleSeats(layout: Layout, live: SeatView[], selected: SeatView | undefined): SeatView[] {
  if (layout === "grid") return live;
  if (!selected) return [];
  if (layout === "focus") return [selected];
  const others = live.filter(s => s.key !== selected.key);
  return others.length ? [selected, others[0]] : [selected];
}
