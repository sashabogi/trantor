// #14268: current work follows card activity, independent of phase ordering.
import type { PhaseCard, ProjectPhase, ProjectPhases } from "../../../shared/api/client";
import { Button } from "../../ui/Button";

const CLOSED = new Set(["done", "archived", "cancelled", "rejected"]);
const priority = (card: PhaseCard) => card.status === "doing" ? 3 : card.status === "testing" ? 2 : card.status === "todo" ? 1 : 0;
const activity = (card: PhaseCard) => Math.max(card.updated ?? 0, card.ts ?? 0);
const CIRCUMFERENCE = 2 * Math.PI * 14;

export function phaseProgress(phases: ProjectPhase[]) {
  const populated = phases.map(phase => ({ phase, cards: [...phase.crew, ...phase.orchestrators] })).filter(p => p.cards.length);
  const open = populated.flatMap(group => group.cards.filter(c => !CLOSED.has(c.status)).map(card => ({ group, card })))
    .sort((a, b) => priority(b.card) - priority(a.card) || activity(b.card) - activity(a.card));
  const recent = [...populated].sort((a, b) => Math.max(...b.cards.map(activity)) - Math.max(...a.cards.map(activity)));
  const current = open[0]?.group ?? recent[0];
  if (!current) return null;
  const done = current.cards.filter(c => CLOSED.has(c.status)).length;
  const openCards = current.cards.filter(c => !CLOSED.has(c.status));
  // #14268: a derived "Setup N" bucket name means nothing to a person, so name the phase by its latest open card.
  const latest = [...openCards].sort((a, b) => activity(b) - activity(a))[0];
  const goal = current.phase.goal || (/^Setup \d+$/.test(current.phase.key) && latest ? latest.title : current.phase.key);
  return { goal, done, total: current.cards.length,
    fraction: done / current.cards.length, open: current.cards.filter(c => !CLOSED.has(c.status)).slice(0, 3) };
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
          strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`} strokeDashoffset={CIRCUMFERENCE * (1 - progress.fraction)} transform="rotate(-90 18 18)" />
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
