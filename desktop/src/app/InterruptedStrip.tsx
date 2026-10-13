// InterruptedStrip.tsx: the sidebar's "Interrupted" rows (#5401). #11640: each row shows its own
// wake outcome. Resuming while it runs, the error text when the wake failed (Resume enabled
// again), and nothing on success because the shell drops the row.
import type { RestorableSession } from "../features/workspace/herdr";
import type { WakeRowState } from "../features/genesis/wakeRow";

const DEFAULT_LINE = "session died with the machine";
const SHORT_ERROR_CHARS = 72;

const underway = (s?: WakeRowState) => s?.phase === "running" || s?.phase === "kickoff";

/** The failure a row should show, or null. Only the error-ish outcomes count: a woken or
 *  kickoff-sent outcome is a success and the row is about to leave. */
export function interruptedError(s?: WakeRowState): { short: string; full: string } | null {
  if (s?.phase !== "outcome" || s.kind === "woken" || s.kind === "sent") return null;
  const full = s.text.trim() || "wake failed";
  const oneLine = full.split("\n")[0];
  const short = oneLine.length > SHORT_ERROR_CHARS ? `${oneLine.slice(0, SHORT_ERROR_CHARS - 1)}…` : oneLine;
  return { short, full };
}

export function InterruptedStrip({ rows, wakeStates, onResume, onDismiss }: {
  rows: RestorableSession[];
  wakeStates: Map<string, WakeRowState>;
  onResume: (project: string) => void;
  onDismiss: (row: RestorableSession) => void;
}) {
  return (
    <>
      {rows.map(r => {
        const state = wakeStates.get(r.project);
        const busy = underway(state);
        const error = busy ? null : interruptedError(state);
        return (
          <div key={r.project} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-1.5 text-[12px]">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[var(--color-tr-text)]/85">{r.project}</span>
              {error ? (
                <span className="block truncate text-[10px] text-tr-danger" title={error.full}>{error.short}</span>
              ) : (
                <span className="block text-[10px] text-[var(--color-tr-muted)]">{DEFAULT_LINE}</span>
              )}
            </span>
            <button type="button"
              onClick={() => onResume(r.project)}
              disabled={busy}
              className="shrink-0 rounded-[6px] bg-tr-ok/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-tr-ok hover:bg-tr-ok/20 disabled:opacity-40">
              {busy ? "Resuming…" : "Resume"}
            </button>
            <button type="button" title="dismiss — it stays wakeable from its project row"
              onClick={() => onDismiss(r)}
              className="shrink-0 px-1 text-[12px] text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]">
              ×
            </button>
          </div>
        );
      })}
    </>
  );
}
