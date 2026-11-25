// #14256: lanes share Workspace presence so the header agrees with the seat being opened.
import type { Peer, TurnRow } from "../../../shared/api/client";
import { paneTargets } from "../../../features/workspace/paneTargets";
import { hostPeer, seatPeers, seatViews } from "../../screens/Workspace/seatModel";
import { Button } from "../../ui/Button";

const HOUR = 3_600_000;
// #14268: a short failed turn stays visible at 3px, and its hover target is wider than the mark.
const MIN_BAR = "3px";
const IDLE_LOOKBACK = 600_000;
export function barPlacement(start: number, end: number, now: number) {
  const left = Math.max(0, Math.min(1, (start - now + HOUR) / HOUR));
  const right = Math.max(left, Math.min(1, (end - now + HOUR) / HOUR));
  return { left: `${left * 100}%`, width: `${(right - left) * 100}%`, minWidth: MIN_BAR };
}

export function turnColor(turn: TurnRow): string {
  if (turn.cut || turn.stalled || turn.authFailed || ["cut", "stalled", "authFailed"].includes(turn.outcome) || (turn.effExit != null && turn.effExit !== 0)) return "var(--v2-bad)";
  return turn.outcome === "completed" && turn.effExit === 0 ? "var(--v2-ok-edge)" : "var(--v2-track)";
}

export function laneRows(peers: Peer[], turns: TurnRow[], project: string, now: number) {
  const host = hostPeer(peers, project);
  // #14268: the host is the orchestrator even when it has never emitted turn telemetry.
  const targets = paneTargets(seatPeers(peers, project), null, undefined, project);
  if (host) targets.push(...paneTargets([host], null, undefined, project).map(t => ({ ...t, label: "orchestrator", isOrchestrator: true })));
  const seats = seatViews(targets, []);
  const grouped = new Map<string, TurnRow[]>();
  for (const turn of turns.filter(t => t.project === project && t.ts > now - HOUR && t.ts - t.duration_ms < now)) {
    const rows = grouped.get(turn.persona) ?? [];
    rows.push(turn);
    grouped.set(turn.persona, rows);
  }
  const names = new Set([...seats.map(s => s.label), ...grouped.keys()]);
  return [...names].map(persona => {
    const seat = seats.find(s => s.label === persona);
    const rows = grouped.get(persona) ?? [];
    const status = seat?.presence === "working" ? "working" : seat?.presence === "ready" ? "idle" : seat?.presence === "needs-you" ? "parked" : "offline";
    return { persona, rows, status, orchestrator: !!seat?.isOrchestrator, lastEnd: rows.length ? Math.max(...rows.map(t => t.ts)) : null };
  }).filter(lane => lane.status !== "offline" || lane.rows.length)
    .sort((a, b) => Number(b.status === "working" && b.orchestrator) - Number(a.status === "working" && a.orchestrator)
      || Number(b.status === "working") - Number(a.status === "working")
      || Number(b.rows.length > 0) - Number(a.rows.length > 0) || a.persona.localeCompare(b.persona)).slice(0, 3);
}

function turnTitle(turn: TurnRow) {
  return `Card #${turn.card} · ${Math.round(turn.duration_ms / 1000)}s · ${turn.outcome}`;
}

export function SeatLanes({ project, peers, turns, now, workingSince, onOpen, compact = false }: {
  project: string; peers: Peer[]; turns: TurnRow[]; now: number; workingSince: Record<string, number>; onOpen: () => void; compact?: boolean;
}) {
  const lanes = laneRows(peers, turns, project, now);
  const active = lanes.some(lane => lane.rows.length || lane.status === "working");
  return (
    <div aria-label="Seat activity, last 60 minutes" className={`flex min-w-0 flex-1 justify-center ${compact ? "items-center gap-2" : "h-full min-h-12 flex-col rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)] px-2"}`}>
      {!active && <span className="text-v2-micro text-[var(--v2-muted)]">No turns in the last hour</span>}
      {active && lanes.map(lane => (
        <Button key={lane.persona} variant="quiet" onClick={onOpen} aria-label={`${lane.persona}, ${lane.status}, open Workspace`}
          className={`!h-4 min-h-4 shrink-0 !gap-1 !rounded-sm !border-0 !p-0 !text-v2-micro !leading-none ${compact ? "min-w-28 flex-1" : "!w-full"}`}>
          <span className="w-16 shrink-0 truncate text-left text-[var(--v2-text-2)]">{lane.persona}</span>
          <span className="relative h-1.5 min-w-4 flex-1 rounded-full bg-[var(--v2-edge)]">
            {lane.rows.map(turn => (
              <span key={turn.id} title={turnTitle(turn)} className="absolute top-0 h-full rounded-full"
                style={{ ...barPlacement(turn.ts - turn.duration_ms, turn.ts, now), background: turnColor(turn) }}>
                <span data-turn-hit className="absolute left-1/2 top-0 h-full w-2 -translate-x-1/2" />
              </span>
            ))}
            {lane.status === "working" && <span data-running-bar title="Working" className="v2-band-running absolute top-0 h-full rounded-full bg-[var(--v2-accent)]"
              style={barPlacement(lane.lastEnd ?? workingSince[lane.persona] ?? now - IDLE_LOOKBACK, now, now)} />}
          </span>
          {!compact && <span className="w-10 shrink-0 text-right text-[var(--v2-muted)]">{lane.status}</span>}
        </Button>
      ))}
    </div>
  );
}
