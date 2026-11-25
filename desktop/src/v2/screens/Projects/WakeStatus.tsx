// The wake, said plainly: a Workspace status line and a one-line shell notice (#13984).
import { useEffect, useState } from "react";
import type { WakeRowState } from "../../../features/genesis/wakeRow";
import { PLAN_HINT, wakeInFlight, wakeNoticeText, wakeStatusLine } from "./wakeModel";

const TONE = { muted: "text-[var(--v2-muted)]", ok: "text-[var(--v2-ok)]", danger: "text-[var(--v2-bad)]" } as const;

export function WakeLine({ project, state, startedAt, hint, onRetry, onDismiss, onDismissHint }: {
  project: string; state: WakeRowState | undefined; startedAt: number | undefined; hint: boolean;
  onRetry: (p: string) => void; onDismiss: (p: string) => void; onDismissHint: () => void;
}) {
  const flying = wakeInFlight(state);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!flying || startedAt === undefined) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [flying, project, startedAt]);
  const line = wakeStatusLine(state, flying ? elapsed : undefined);
  if (!line && !hint) return null;
  return (
    <div role="status" aria-label={`${project} start status`}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--v2-edge)] bg-[var(--v2-panel)] px-5 py-2 text-[12px]">
      {line && <span title={line.title} className={TONE[line.tone]}>{line.text}</span>}
      {state?.phase === "outcome" && state.kind === "sent" && (
        <button type="button" aria-label="Dismiss wake status" title="Dismiss wake status" onClick={() => onDismiss(project)}
          className="border-0 bg-transparent px-1 text-[13px] text-[var(--v2-muted)] hover:text-[var(--v2-text)]">×</button>
      )}
      {line?.retry && (
        <button type="button" onClick={() => onRetry(project)}
          className="v2-hover rounded-md border border-[var(--v2-edge-2)] bg-transparent px-2 py-0.5 text-[11.5px] font-semibold text-[var(--v2-text)]">
          Try again
        </button>
      )}
      {hint && (
        <span className="flex items-center gap-1.5 text-[var(--v2-muted)]">
          {PLAN_HINT}
          <button type="button" aria-label="Dismiss this note" title="Dismiss this note" onClick={onDismissHint}
            className="border-0 bg-transparent px-1 text-[13px] text-[var(--v2-muted)] hover:text-[var(--v2-text)]">×</button>
        </span>
      )}
    </div>
  );
}

export const WAKE_NOTICE_MS = 8_000;

/** The top-bar event for the newest wake; the Workspace owns its persistent state line. */
export function WakeNotice({ wakes, wakeStarts, activeProject }: {
  wakes: Map<string, WakeRowState>; wakeStarts: Map<string, number>; activeProject: string;
}) {
  const [project, state] = [...wakes.entries()].pop() ?? ["", undefined];
  const startedAt = wakeStarts.get(project) ?? 0;
  const wakeKey = `${project}:${startedAt}`;
  const [dismissed, setDismissed] = useState("");
  const [expired, setExpired] = useState("");
  const text = wakeNoticeText(state);
  const completed = state?.phase === "outcome" && (state.kind === "sent" || state.kind === "woken");
  useEffect(() => {
    if (!completed || !project) return;
    const timer = setTimeout(() => setExpired(wakeKey), WAKE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [completed, project, wakeKey]);
  if (!text || project === activeProject || dismissed === wakeKey || expired === wakeKey) return null;
  return (
    <div role="status" aria-live="polite" title={`${project} · ${text}`}
      className="flex min-w-0 max-w-[360px] flex-[1_1_220px] items-center gap-1 overflow-hidden rounded-[9px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-3 py-1.5 text-[12px] text-[var(--v2-text-2)]">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold text-[var(--v2-text)]">{project}</span> · {text}
      </span>
      <button type="button" aria-label="Dismiss the wake notice" title="Dismiss the wake notice" onClick={() => setDismissed(wakeKey)}
        className="shrink-0 border-0 bg-transparent px-1 text-[13px] text-[var(--v2-muted)] hover:text-[var(--v2-text)]">×</button>
    </div>
  );
}
