// "Worked for 6m 05s" under a finished reply (#14327), with a hairline fading out to the right.
// Hidden under five seconds, where it would only be noise.

export const WORKED_MIN_MS = 5000;

/** "42s", "6m 05s", "1h 02m". */
export function workedFor(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function WorkedFooter({ ms }: { ms: number | undefined }) {
  if (ms === undefined || ms < WORKED_MIN_MS) return null;
  return (
    <div data-testid="worked-footer" className="mb-1.5 mt-1 flex items-center gap-2.5">
      <span className="whitespace-nowrap text-v2-body text-[var(--v2-muted)] opacity-85">Worked for {workedFor(ms)}</span>
      <span aria-hidden className="h-px flex-1" style={{ background: "var(--v2-hairline-fade)" }} />
    </div>
  );
}
