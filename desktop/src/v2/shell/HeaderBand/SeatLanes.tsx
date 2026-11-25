// #14256: lanes share Workspace presence so the header agrees with the seat being opened.
import type { Peer, TurnRow } from "../../../shared/api/client";
import { paneTargets } from "../../../features/workspace/paneTargets";
import { seatPeers, seatViews } from "../../screens/Workspace/seatModel";
import { Button } from "../../ui/Button";

const HOUR = 3_600_000;
export function barPlacement(start: number, end: number, now: number) {
  const left = Math.max(0, Math.min(1, (start - now + HOUR) / HOUR));
  const right = Math.max(left, Math.min(1, (end - now + HOUR) / HOUR));
  return { left: `${left * 100}%`, width: `${(right - left) * 100}%` };
}

export function turnColor(turn: TurnRow): string {
  if (turn.cut || turn.stalled || turn.authFailed || ["cut", "stalled", "authFailed"].includes(turn.outcome) || (turn.effExit != null && turn.effExit !== 0)) return "var(--v2-bad)";
  return turn.outcome === "completed" && turn.effExit === 0 ? "var(--v2-ok-edge)" : "var(--v2-track)";
}

export function laneRows(peers: Peer[], turns: TurnRow[], project: string) {
  const seats = seatViews(paneTargets(seatPeers(peers, project), null, undefined, project), []);
  const grouped = new Map<string, TurnRow[]>();
  for (const turn of turns.filter(t => t.project === project)) {
    const rows = grouped.get(turn.persona) ?? [];
    rows.push(turn);
    grouped.set(turn.persona, rows);
  }
  const names = new Set([...seats.map(s => s.label), ...grouped.keys()]);
  return [...names].map(persona => {
    const seat = seats.find(s => s.label === persona);
    const rows = grouped.get(persona) ?? [];
    const status = seat?.presence === "working" ? "working" : seat?.presence === "ready" ? "idle" : seat?.presence === "needs-you" ? "parked" : "offline";
    return { persona, rows, status, lastEnd: rows.length ? Math.max(...rows.map(t => t.ts)) : null };
  }).sort((a, b) => Number(b.status === "working") - Number(a.status === "working") || a.persona.localeCompare(b.persona)).slice(0, 4);
}

function turnTitle(turn: TurnRow) {
  return `Card #${turn.card} · ${Math.round(turn.duration_ms / 1000)}s · ${turn.outcome}`;
}

export function SeatLanes({ project, peers, turns, now, workingSince, onOpen }: {
  project: string; peers: Peer[]; turns: TurnRow[]; now: number; workingSince: Record<string, number>; onOpen: () => void;
}) {
  const lanes = laneRows(peers, turns, project);
  return (
    <div aria-label="Seat activity, last 60 minutes" className="flex h-full min-w-0 flex-1 flex-col justify-center rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)] px-2">
      {!lanes.length && <span className="text-v2-micro text-[var(--v2-muted)]">No seat activity</span>}
      {lanes.map(lane => (
        <Button key={lane.persona} variant="quiet" onClick={onOpen} aria-label={`${lane.persona}, ${lane.status}, open Workspace`}
          className="!h-2.5 min-h-0 !w-full !gap-1 !rounded-sm !border-0 !p-0 !text-v2-micro !leading-none">
          <span className="w-16 shrink-0 truncate text-left text-[var(--v2-text-2)]">{lane.persona}</span>
          <span className="relative h-1.5 min-w-4 flex-1 rounded-full bg-[var(--v2-edge)]">
            {lane.rows.filter(t => t.ts > now - HOUR && t.ts - t.duration_ms < now).map(turn => (
              <span key={turn.id} title={turnTitle(turn)} className="absolute top-0 h-full rounded-full"
                style={{ ...barPlacement(turn.ts - turn.duration_ms, turn.ts, now), background: turnColor(turn) }} />
            ))}
            {lane.status === "working" && <span data-running-bar title="Working" className="v2-band-running absolute top-0 h-full rounded-full bg-[var(--v2-accent)]"
              style={barPlacement(lane.lastEnd ?? workingSince[lane.persona] ?? now, now, now)} />}
          </span>
          <span className="w-10 shrink-0 text-right text-[var(--v2-muted)]">{lane.status}</span>
        </Button>
      ))}
    </div>
  );
}
