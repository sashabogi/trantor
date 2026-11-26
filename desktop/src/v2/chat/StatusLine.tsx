// What the classic chat header used to say, as one quiet line under the 2.0 header (#14327): what the
// session is doing, the model it reported, the handoff control, and the way back from a past session.
import { ArrowLeft } from "lucide-react";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";

export type HandoffControl = {
  confirming: boolean;
  /** Why the control cannot be used right now; null when it can. */
  disabledReason: string | null;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

const DOT = { doing: "bg-[var(--v2-accent)]", warn: "bg-[var(--v2-warn)]", ok: "bg-[var(--v2-ok)]" } as const;
const SMALL = "!px-2 !py-1 !text-v2-small";

export function StatusLine({ tone, text, model, handoff, onBack }: {
  tone: keyof typeof DOT; text: string | null; model: string; handoff: HandoffControl | null; onBack: (() => void) | null;
}) {
  if (!text && !model && !handoff && !onBack) return null;
  return (
    <div data-testid="chat-status" className="flex shrink-0 items-center gap-2 overflow-hidden px-4 py-1">
      {text && <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} />}
      <span className="v2-mono min-w-0 flex-1 truncate text-v2-small text-[var(--v2-muted)]">{text}</span>
      {model && <Chip mono>{model}</Chip>}
      {handoff && (handoff.confirming ? (
        <>
          <Button variant="quiet" className={SMALL} disabledReason={handoff.disabledReason}
            title="End this session and open a successor to recap the handoff" onClick={handoff.onConfirm}>Confirm handoff</Button>
          <Button variant="quiet" className={SMALL} onClick={handoff.onCancel}>Cancel</Button>
        </>
      ) : (
        <Button variant="quiet" className={SMALL} disabledReason={handoff.disabledReason}
          title="Write a handoff, end this session, and open a successor to recap it" onClick={handoff.onAsk}>Hand off</Button>
      ))}
      {onBack && (
        <Button variant="quiet" className={SMALL} icon={<ArrowLeft size={12} aria-hidden />}
          title="Back to session history" onClick={onBack}>Back</Button>
      )}
    </div>
  );
}
