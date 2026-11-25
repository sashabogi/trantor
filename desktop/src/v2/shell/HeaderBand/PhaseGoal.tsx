// #14256: the most recent unfinished phase gives the header its immediate goal.
import type { ProjectPhase, ProjectPhases } from "../../../shared/api/client";
import { Button } from "../../ui/Button";

export function phaseProgress(phases: ProjectPhase[]) {
  const populated = phases.map(phase => ({ phase, cards: [...phase.crew, ...phase.orchestrators] })).filter(p => p.cards.length);
  const current = [...populated].reverse().find(p => p.cards.some(c => c.status !== "done")) ?? populated[populated.length - 1];
  if (!current) return null;
  const done = current.cards.filter(c => c.status === "done").length;
  return { goal: current.phase.goal || current.phase.key, done, total: current.cards.length,
    fraction: done / current.cards.length, open: current.cards.filter(c => c.status !== "done").slice(0, 3) };
}

export function PhaseGoal({ data, onOpen }: { data: ProjectPhases | null; onOpen: () => void }) {
  const progress = phaseProgress(data?.phases ?? []);
  if (!progress) return null;
  const label = `Phase goal · ${progress.done} of ${progress.total}`;
  return (
    <Button onClick={onOpen} aria-label={`${label}: ${progress.goal}`} className="v2-band-phase group relative h-full min-w-0 shrink-0 !gap-2 !border-[var(--v2-edge)] !bg-[var(--v2-panel)] !px-2 !py-0 text-left">
      <svg width="34" height="34" viewBox="0 0 36 36" className="shrink-0" aria-hidden="true">
        <circle cx="18" cy="18" r="14" fill="none" stroke="var(--v2-track)" strokeWidth="4" />
        <circle data-fraction={progress.fraction} cx="18" cy="18" r="14" fill="none" stroke="var(--v2-accent)" strokeWidth="4"
          pathLength="1" strokeDasharray={`${progress.fraction} 1`} transform="rotate(-90 18 18)" />
      </svg>
      <span className="v2-band-goal min-w-0">
        <span className="block text-v2-small text-[var(--v2-muted)]">{label}</span>
        <span className="block truncate text-v2-base">{progress.goal}</span>
      </span>
      <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-50 mt-2 hidden w-64 whitespace-normal rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] p-3 text-v2-body shadow-[var(--v2-shadow-menu)] group-hover:block group-focus-visible:block">
        <span className="mb-1 block text-v2-small text-[var(--v2-muted)]">{progress.open.length ? "Open" : "Phase complete"}</span>
        {progress.open.map(card => <span key={card.id} className="block">{card.title}</span>)}
      </span>
    </Button>
  );
}
