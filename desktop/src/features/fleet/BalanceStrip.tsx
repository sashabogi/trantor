// The fleet status bar — the app's FOOTER, to the Orca standard (#5570, the operator's
// screenshot is the binding spec): real brand marks, a micro progress bar, and per-window
// "N% used <time-left>" segments, including model-scoped limits ("37% used Fable") and
// Codex's real windows. Values read at full text brightness; marks and separators stay
// muted; LOW/LOCKED carry the status tints. A failed fetch keeps the last known values with
// the bar dimmed — never an error banner — and the trailing refresh control re-reads the
// snapshot on demand. Data rides the MACHINE-LOCAL hub by design (balances/profile are files
// on this machine; the snapshot the CLI pushes there is cheap to read).
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { HubClient, type BalancesReport } from "../../shared/api/client";
import { chipFrom, isStale, sortRows, toneClass, type BalanceRow } from "./balanceChips";
import { BRAND_PATHS } from "./brands";

const LOCAL_HUB = "http://127.0.0.1:4477";
const REFRESH_MS = 5 * 60 * 1000;

function BrandMark({ icon, mono, hue, fg }: { icon: string | null; mono: string; hue: string; fg: string }) {
  const d = icon ? BRAND_PATHS[icon] : undefined;
  if (d) {
    return (
      <svg viewBox="0 0 24 24" width={13} height={13} className="shrink-0" style={{ color: hue }} aria-hidden>
        <path d={d} fill="currentColor" fillRule="evenodd" />
      </svg>
    );
  }
  // No vendored mark for this provider — the monogram circle survives as the fallback.
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full"
      style={{ backgroundColor: hue, color: fg }}>
      <span className="text-[7px] font-semibold leading-none">{mono}</span>
    </span>
  );
}

export function BalanceStrip({ client }: { client: HubClient }) {
  const [report, setReport] = useState<BalancesReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [spinning, setSpinning] = useState(false);

  // Mount, window focus, every 5 minutes, and the manual refresh control — never tighter (the
  // CLI throttles provider calls; the hub snapshot is cheap to read). A failed fetch keeps the
  // last values and dims.
  const isLocal = client.baseUrl.includes("127.0.0.1") || client.baseUrl.includes("localhost");
  const local = isLocal ? client : new HubClient(LOCAL_HUB);
  const pull = useCallback(() => {
    setSpinning(true);
    return local.balances()
      .then(r => { setReport(r); setFailed(false); })
      .catch(() => setFailed(true))
      .finally(() => setSpinning(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) void pull(); };
    tick();
    const t = setInterval(tick, REFRESH_MS);
    window.addEventListener("focus", tick);
    return () => { alive = false; clearInterval(t); window.removeEventListener("focus", tick); };
  }, [pull]);

  // SAFETY: /balances entries are the adapter payloads spread with provider fields
  // (usage/limit/resetTime/via/unlimited/windows) that the conservative BalanceEntry type omits;
  // the chip formatter reads them, so the boundary decodes to the widened row shape once, here.
  const rows = (report?.entries ?? []) as BalanceRow[];
  if (!rows.length) return null; // no configured providers — no chrome that says nothing

  const ts = report?.ts ?? 0;
  const stale = isStale(ts);
  const chips = sortRows(rows).map(e => chipFrom(e, { snapshotTs: ts })).filter((c): c is NonNullable<typeof c> => c != null);
  if (!chips.length) return null;

  const dimmed = failed || stale;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t border-[var(--color-tr-edge)] bg-[var(--color-tr-bg)] px-3"
      title={dimmed ? "Balances stale — last known values" : undefined}>
      <div className={`flex min-w-0 flex-1 items-center gap-4 ${dimmed ? "opacity-45" : ""}`}>
        {chips.map(c => (
          <span key={c.key} title={c.tooltip} className="flex shrink-0 items-center gap-1.5 text-[10.5px]">
            <BrandMark icon={c.icon} mono={c.mono} hue={c.hue} fg={c.fg} />
            {c.barPct != null && (
              <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-[var(--color-tr-edge)]">
                <span className="block h-full rounded-full"
                  style={{ width: `${Math.min(100, c.barPct)}%`, backgroundColor: c.hue, opacity: 0.9 }} />
              </span>
            )}
            <span className={`tr-mono whitespace-nowrap ${toneClass(c.tone)}`}>{c.value}</span>
          </span>
        ))}
      </div>
      <button type="button" onClick={() => void pull()} title="Refresh balances"
        className="shrink-0 text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]">
        <RefreshCw size={11} strokeWidth={1.75} className={spinning ? "animate-spin" : undefined} />
      </button>
    </footer>
  );
}
