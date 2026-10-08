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

export function SeatTab({ name, brandName, status, active, onClick, you, state, tooltip }: {
  state?: "live" | "parked" | "down" | "unknown";
  tooltip?: string;
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
      title={tooltip ?? (state ? `${name} — ${state === "live" && v.pulse ? "working" : state}` : v.title)}
      className="flex shrink-0 whitespace-nowrap items-center gap-2 rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
    >
      <span className={`inline-flex shrink-0 items-center ${!state && v.pulse ? "animate-pulse" : ""} ${!state && v.amber ? "rounded-full ring-1 ring-tr-warn" : ""} ${!state && v.down ? "rounded-full ring-1 ring-tr-fail" : ""}`}>
        <Mark brandName={brandName} />
      </span>
      {state && <span className={`tr-dot shrink-0 ${state === "down" || state === "unknown" ? "border border-tr-muted" : state === "parked" ? "bg-tr-muted/50" : `bg-tr-ok ${v.pulse ? "tr-dot-pulse" : ""}`}`} />}
      <span className={state === "parked" ? "opacity-50" : state ? undefined : v.amber ? "text-tr-warn" : v.down ? "text-tr-fail" : undefined}>{name}</span>
      {you && <span className="text-[11px] text-tr-muted/70">you</span>}
    </button>
  );
}
