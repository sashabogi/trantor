// Plans and balances: one card per provider, the same numbers as the bottom bar (#13991).
import type { PlanCard } from "./plans";

function PlanTile({ card }: { card: PlanCard }) {
  const fill = card.warn ? "var(--v2-warn)" : card.hue;
  return (
    <div data-plan={card.key} data-warn={card.warn || undefined}
      className="flex min-w-[190px] flex-1 basis-[190px] flex-col gap-[7px] rounded-xl border bg-[var(--v2-panel)] px-[14px] py-3"
      style={{ borderColor: card.warn ? "var(--v2-warn-edge)" : "var(--v2-edge)" }}>
      <div className="flex items-center gap-[7px]">
        <span aria-hidden className="size-[10px] rounded-full" style={{ background: card.hue }} />
        <span className="font-semibold">{card.label}</span>
        <span className="truncate text-[11px] text-[var(--v2-muted)]">{card.kind}</span>
      </div>
      <div className={`text-[20px] font-semibold ${card.noMeter ? "text-[var(--v2-muted)]" : card.warn ? "text-[var(--v2-warn)]" : "text-[var(--v2-text)]"}`}>{card.headline}</div>
      {card.pct != null && (
        <span role="progressbar" aria-label={`${card.label} used`} aria-valuenow={card.pct} aria-valuemin={0} aria-valuemax={100}
          className="block h-[6px] overflow-hidden rounded-[3px] bg-[var(--v2-edge)]">
          <span className="block h-[6px]" style={{ width: `${card.pct}%`, background: fill }} />
        </span>
      )}
      <div className="text-[11px] text-[var(--v2-muted)]">{card.detail}</div>
      {card.forecast && <div data-forecast className="text-[11px]" style={{ color: card.forecast.startsWith("lasts") ? "var(--v2-ok)" : "var(--v2-warn)" }}>{card.forecast}</div>}
      {card.noMeter && <div className="text-[11px] text-[var(--v2-muted)]">unknown, shown as unknown</div>}
    </div>
  );
}

export function PlansPanel({ cards, failure, loading }: { cards: PlanCard[]; failure: string | null; loading: boolean }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-[10.5px] font-semibold tracking-[0.08em] text-[var(--v2-muted)]">PLANS AND BALANCES</h2>
        <span className="text-[11.5px] text-[var(--v2-faint)]">live, one card per provider · the bottom bar shows the same numbers</span>
      </div>
      {failure && <p role="status" className="m-0 text-[12px] text-[var(--v2-warn)]">Plans unavailable: {failure}</p>}
      {!failure && loading && <p role="status" className="m-0 text-[12px] text-[var(--v2-muted)]">Reading each provider's meter...</p>}
      {!failure && !loading && cards.length === 0 && <p role="status" className="m-0 text-[12px] text-[var(--v2-muted)]">No providers are connected on this machine.</p>}
      <div className="flex flex-wrap gap-[10px]">{cards.map(c => <PlanTile key={c.key} card={c} />)}</div>
    </>
  );
}
