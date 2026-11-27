// Inline session controls shared by the v2 chat header.
import { ArrowLeft } from "lucide-react";
import { Button } from "../ui/Button";

export type HandoffControl = {
  confirming: boolean;
  /** Why the control cannot be used right now; null when it can. */
  disabledReason: string | null;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

const SMALL = "!px-2 !py-1 !text-v2-small";

export type StatusLineProps = {
  handoff: HandoffControl | null; onBack: (() => void) | null;
};

export function StatusLine({ handoff, onBack }: StatusLineProps) {
  return (
    <div className="flex shrink-0 items-center gap-1">
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
