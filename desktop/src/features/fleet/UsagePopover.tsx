// The Usage popover — the app's Orca-parity roster (docs/RESEARCH-orca-usage.md §4.2/§4.3):
// header with refresh, a Detailed/Compact density toggle persisted across opens, one row per
// provider sorted WORST-FIRST (the agent nearest a limit sits on top), the six-way honesty
// ladder, and a click-to-drill per-agent panel with "Updated {timeAgo}", per-window bars and
// "Resets in {countdown}".
//
// It presents the SAME BalancesReport the footer strip already pulled — no second fetch, no
// new data plane (the card correction). A stale snapshot keeps its values with the strip's
// dim, and an unreachable provider reads "unreachable", never "sign in" — this data plane
// shells the local CLI and cannot know credential state.
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { BalanceRow } from "./balanceChips";
import { chipFrom, money, toneClass, WINDOW_LABEL } from "./balanceChips";
import { BrandMark } from "./BrandMark";
import { dictGet } from "../../shared/dict";
import {
  metricsFor, resetLabel, rowState, ROSTER_COPY, setUsageDensity, timeAgo,
  usageDensity, usageTone, worstFirst, type UsageDensity, type UsageMetric,
} from "./usageRoster";

// Deliberately PARTIAL: a "usage" row carries live numbers and gets no tone override, so
// lookups go through dictGet and fall back to no class — never index a closed literal by union.
const stateTone = {
  error: "text-[var(--color-tr-fail)]",
  loading: "text-[var(--color-tr-muted)]",
  plan: "text-[var(--color-tr-muted)]",
  empty: "text-[var(--color-tr-muted)]",
  unlimited: "text-[var(--color-tr-muted)]",
} as const;

function MetricBar({ pct, wide }: { pct: number; wide?: boolean }) {
  const tone = usageTone(pct);
  const fill = tone === "fail" ? "var(--color-tr-fail)" : tone === "warn" ? "var(--color-tr-warn)" : "var(--color-tr-muted)";
  return (
    <span className={`h-1 shrink-0 overflow-hidden rounded-full bg-[var(--color-tr-edge)] ${wide ? "w-full" : "w-7"}`}>
      <span className="block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: fill }} />
    </span>
  );
}

function MetricChip({ label, pct, resetsAt, now }: { label: string; pct: number | null; resetsAt: number | string | null; now: number }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="text-[10.5px] text-[var(--color-tr-muted)]">{label}</span>
      {pct != null && <MetricBar pct={pct} />}
      {pct != null && <span className={`tr-mono text-[10.5px] ${toneClass(usageTone(pct))}`}>{Math.round(pct)}% used</span>}
      {pct == null && <span className="tr-mono text-[10.5px] text-[var(--color-tr-muted)]">no %</span>}
      {(() => { const r = resetLabel(resetsAt, now); return r ? <span className="text-[10.5px] text-[var(--color-tr-muted)]">{r}</span> : null; })()}
    </span>
  );
}

// The drill-in: header with the freshness stamp, then one labeled bar per window with its
// reset countdown; an unreachable row shows the error softened (cached values are still on
// screen), and a prepaid row shows the money it actually has.
function ProviderDrill({ e, snapshotTs, now }: { e: BalanceRow; snapshotTs: number; now: number }) {
  const full = e.label ?? e.provider;
  return (
    <div className="flex flex-col gap-2.5 border-t border-[var(--color-tr-edge)] px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium">{full}</span>
        <span className="text-[10.5px] text-[var(--color-tr-muted)]">Updated {timeAgo(now - snapshotTs)}</span>
      </div>
      {!e.ok && (
        <div className="text-[11.5px] text-[var(--color-tr-fail)]">
          Refresh failed — showing last known values{e.error ? `: ${e.error}` : "."}
        </div>
      )}
      {e.ok && e.kind === "prepaid" && e.remaining != null && (
        <div className="tr-mono text-[11.5px] text-[var(--color-tr-text)]">
          {money(e.remaining, e.currency)} left{e.usage != null ? ` · ${money(e.usage, e.currency)} used` : ""}{e.limit != null ? ` · ${money(e.limit, e.currency)} limit` : ""}
        </div>
      )}
      {e.ok && e.kind === "subscription" && (
        <div className="text-[11.5px] text-[var(--color-tr-muted)]">Subscription{e.plan ? ` · ${e.plan}` : ""} — the CLI reports no usage numbers for plan rows.</div>
      )}
      {e.ok && e.unlimited && (
        <div className="text-[11.5px] text-[var(--color-tr-muted)]">Unlimited — nothing to refill.</div>
      )}
      {metricsFor(e).map(m => (
        <div key={m.label} className="flex flex-col gap-1">
          <span className="text-[10.5px] text-[var(--color-tr-muted)]">{dictGet(WINDOW_LABEL, m.label) ?? m.label}</span>
          {m.pct != null ? (
            <>
              <MetricBar pct={m.pct} wide />
              <div className="flex items-center justify-between">
                <span className={`tr-mono text-[10.5px] ${toneClass(usageTone(m.pct))}`}>{Math.round(m.pct)}% used</span>
                {(() => { const r = resetLabel(m.resetAt, now); return r ? <span className="text-[10.5px] text-[var(--color-tr-muted)]">{r}</span> : null; })()}
              </div>
            </>
          ) : (
            <span className="text-[10.5px] text-[var(--color-tr-muted)]">no percentage reported</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function UsagePopover({ rows, snapshotTs, spinning, onRefresh, onClose }: {
  rows: BalanceRow[];
  snapshotTs: number;
  spinning: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [density, setDensity] = useState<UsageDensity>(() => usageDensity());
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The countdowns and "Updated" stamps are relative — re-tick on one shared clock (Orca's
  // boundary-scheduled timer, simplified to a minute: no per-row intervals).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(t); window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const ordered = worstFirst(rows);
  const fresh = snapshotTs > 0;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div className="absolute bottom-9 right-2 z-50 w-96 rounded-md border border-[var(--color-tr-edge)] bg-[var(--color-tr-bg)] shadow-lg">
        <div className="flex items-center gap-2 px-3 pt-3">
          <span className="text-[12px] font-semibold">Usage</span>
          <span className="text-[11px] text-[var(--color-tr-muted)]">all agents</span>
          <div className="ml-auto flex overflow-hidden rounded border border-[var(--color-tr-edge)]">
            {(["detailed", "compact"] as const).map(d => (
              <button key={d} type="button"
                onClick={() => { setDensity(d); setUsageDensity(d); }}
                className={`px-2 py-0.5 text-[10.5px] capitalize ${density === d ? "bg-[var(--color-tr-edge)] text-[var(--color-tr-text)]" : "text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]"}`}>
                {d}
              </button>
            ))}
          </div>
          <button type="button" onClick={onRefresh} title="Re-query every provider now"
            className="shrink-0 text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]">
            <RefreshCw size={12} strokeWidth={1.75} className={spinning ? "animate-spin" : undefined} />
          </button>
        </div>
        {!fresh && (
          <div className="px-3 pb-2 pt-1 text-[10.5px] text-[var(--color-tr-muted)]">
            The CLI has not pushed a snapshot yet — numbers land on its first report.
          </div>
        )}
        <div className="max-h-[60vh] overflow-y-auto py-1.5">
          {ordered.map(e => {
            const state = rowState(e, fresh);
            const ms = metricsFor(e);
            // Compact shows ONLY the tightest window (the section nearest a limit, §4.1) —
            // a row with no percentages stays honest and shows nothing on the right.
            const tightest: UsageMetric | null = density === "compact"
              ? ms.reduce<UsageMetric | null>((acc, m) => (m.pct != null && (acc?.pct == null || m.pct > acc.pct) ? m : acc), null)
              : null;
            const open = openProvider === e.provider;
            // The chip formatter already resolved icon/mono/hue/fg once — read the brand
            // identity back off its output instead of duplicating the BRAND table here.
            const c = chipFrom(e);
            const id = { icon: c?.icon ?? null, mono: c?.mono ?? e.provider.slice(0, 2).toUpperCase(), hue: c?.hue ?? "#8A8A92", fg: c?.fg ?? "#1a1a1e" };
            return (
              <div key={e.provider}>
                <button type="button" aria-expanded={open}
                  onClick={() => setOpenProvider(open ? null : e.provider)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-tr-edge)]/40">
                  <BrandMark icon={id.icon} mono={id.mono} hue={id.hue} fg={id.fg} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px]">{e.label ?? e.provider}</span>
                  {state !== "usage" && (
                    <span className={`shrink-0 text-[10.5px] ${dictGet(stateTone, state) ?? ""}`}>{ROSTER_COPY[state]}</span>
                  )}
                  {state === "usage" && density === "compact" && tightest && (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className={`tr-mono text-[10.5px] ${toneClass(usageTone(tightest.pct ?? 0))}`}>
                        {Math.round(tightest.pct ?? 0)}%
                      </span>
                    </span>
                  )}
                  {state === "usage" && density === "detailed" && (
                    <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                      {ms.map(m => <MetricChip key={m.label} label={m.label} pct={m.pct} resetsAt={m.resetAt} now={now} />)}
                    </span>
                  )}
                </button>
                {open && <ProviderDrill e={e} snapshotTs={snapshotTs} now={now} />}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
