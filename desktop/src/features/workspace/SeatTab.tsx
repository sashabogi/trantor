// One seat tab (#5890): the seat's REAL brand mark (shared/Avatar's BrandGlyph — the same mark
// the sidebar and Sessions rows use) + name, with the state worn by the mark, not by a dot:
// working = quiet pulse, blocked = amber ring + amber name, idle = still. The blue dot is gone —
// it never said "working", it said "online", which the terminal being open already proves.
// The orchestrator tab shares the shape and keeps its "you" chip (it is the operator, not a seat).
import { brandFor } from "../../shared/Avatar";
import { seatTabVisual } from "./seatTabVisual";

/** The bare mark with a monogram fallback, so an unknown agent still reads as a name, not a gap. */
function Mark({ brandName }: { brandName: string }) {
  const brand = brandFor(brandName);
  if (brand) {
    return <span className="inline-flex items-center"><span aria-label={brand.label} title={brand.label}
      style={{ color: brand.hex, fontSize: 13, lineHeight: 0, display: "inline-flex" }}
      dangerouslySetInnerHTML={{ __html: brand.svg }} /></span>;
  }
  return (
    <span aria-label={brandName} title={brandName}
      className="inline-flex h-[16px] w-[16px] items-center justify-center rounded-full bg-white/[0.08] text-[8px] font-semibold text-tr-muted">
      {brandName.slice(0, 2)}
    </span>
  );
}

export function SeatTab({ name, brandName, status, active, onClick, you }: {
  name: string;
  /** The identity the BRAND reads from — the agent name ("codex"), or the orchestrator's agent. */
  brandName: string;
  status?: string;
  active: boolean;
  onClick: () => void;
  /** The orchestrator's "you" chip: it is the operator, not a seat to supervise. */
  you?: boolean;
}) {
  const v = seatTabVisual(status, name);
  return (
    <button
      type="button"
      onClick={onClick}
      data-on={active}
      title={v.title}
      className="flex items-center gap-2 rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
    >
      <span className={`inline-flex shrink-0 items-center ${v.pulse ? "animate-pulse" : ""} ${v.amber ? "rounded-full ring-1 ring-tr-warn" : ""} ${v.down ? "rounded-full ring-1 ring-tr-fail" : ""}`}>
        <Mark brandName={brandName} />
      </span>
      <span className={v.amber ? "text-tr-warn" : v.down ? "text-tr-fail" : undefined}>{name}</span>
      {you && <span className="text-[11px] text-tr-muted/70">you</span>}
    </button>
  );
}
