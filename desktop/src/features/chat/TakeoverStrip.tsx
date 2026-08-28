// The takeover offer as one strip: the why, the button, and the CLI's refusal verbatim (#5495).
// Shared by the composer's locked state and the Workspace empty state (#5479) so both surfaces
// offer the SAME action from the same inventory — one tested implementation, like the CLI chain
// beneath. The refusal (mid-turn, ambiguity, a failed open) renders word for word next to the
// button: a takeover that failed silently is a trap set for the next conversation.
import { useState } from "react";
import { takeoverNow, type TakeoverAction } from "./takeover";

export function TakeoverStrip({ project, action, bare }: {
  project: string;
  action: TakeoverAction;
  /** Hide the why line when the surrounding surface already states it (the Workspace card). */
  bare?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setError(null);
    takeoverNow(project)
      .catch(e => setError(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="rounded-lg border border-tr-edge bg-tr-panel px-2.5 py-1.5 text-[11.5px]">
      <div className="flex items-center gap-2">
        {!bare && (
          <span className="min-w-0 flex-1 truncate text-tr-muted" title={action.why}>{action.why}</span>
        )}
        <button
          type="button"
          onClick={go}
          disabled={!action.enabled || busy}
          title={action.enabled
            ? "Run the takeover chain — the tested CLI, staged in the pane"
            : action.why}
          className={`${bare ? "w-full" : "ml-auto shrink-0"} rounded-[8px] bg-tr-ok px-2.5 py-1 text-[11.5px] font-semibold text-[#07130f] disabled:opacity-40`}
        >
          {busy ? "taking over…" : action.label}
        </button>
      </div>
      {error && <div className="tr-mono mt-1 break-words text-[10.5px] text-tr-fail">{error}</div>}
    </div>
  );
}
