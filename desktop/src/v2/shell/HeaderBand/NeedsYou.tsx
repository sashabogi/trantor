// #14256: a newly raised decision gets one pulse without nagging on every poll.
import { Button } from "../../ui/Button";
import { useRisePulse } from "./useBandData";

export function NeedsYou({ ids, onOpen }: { ids: string[]; onOpen: () => void }) {
  const pulse = useRisePulse(ids);
  return (
    <Button onClick={onOpen} aria-label={`${ids.length} needs you, open Inbox`}
      className={`h-full shrink-0 !flex-col !items-start !justify-center !gap-0 !px-2 !py-0 ${ids.length
        ? "!border-[var(--v2-warn-edge)] !bg-[var(--v2-warn-soft)]"
        : "border-dashed !border-[var(--v2-edge)] !bg-[var(--v2-panel)]"}`}>
      <span key={pulse} data-pulse={pulse} className={`text-v2-heading leading-none ${ids.length ? "text-[var(--v2-warn)]" : "text-[var(--v2-muted)]"} ${pulse ? "v2-band-pulse" : ""}`}>{ids.length}</span>
      <span className="text-v2-small text-[var(--v2-text-2)]">needs you</span>
    </Button>
  );
}
