// The fleet balance strip — the app header's right side, one chip per configured provider. This
// is chrome, so it stays SMALL: a brand-hue monogram circle + the single number that matters,
// tinted only when a provider is LOW or LOCKED. Values read at FULL text brightness; only the
// icon/label stays muted. A failed fetch keeps the last known values with the strip dimmed —
// never an error banner. Data rides the MACHINE-LOCAL hub by design (balances/profile are files
// on this machine; the snapshot the CLI pushes there is cheap to read) — the same two-hub split
// Home uses. v7: icons not words, Claude's two windows fold into one chip, stale snapshots dim.
import { useEffect, useState } from "react";
import { HubClient, type BalancesReport } from "../../shared/api/client";
import { chipFrom, isStale, sortRows, toneClass, type BalanceRow } from "./balanceChips";

const LOCAL_HUB = "http://127.0.0.1:4477";
const REFRESH_MS = 5 * 60 * 1000;

export function BalanceStrip({ client }: { client: HubClient }) {
  const [report, setReport] = useState<BalancesReport | null>(null);
  const [failed, setFailed] = useState(false);

  // Mount, window focus, and every 5 minutes — never tighter (the CLI itself throttles provider
  // calls; the hub snapshot is cheap to read). A failed fetch keeps the last values and dims.
  useEffect(() => {
    let alive = true;
    const isLocal = client.baseUrl.includes("127.0.0.1") || client.baseUrl.includes("localhost");
    const local = isLocal ? client : new HubClient(LOCAL_HUB);
    const pull = () => local.balances()
      .then(r => { if (alive) { setReport(r); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    void pull();
    const t = setInterval(pull, REFRESH_MS);
    window.addEventListener("focus", pull);
    return () => { alive = false; clearInterval(t); window.removeEventListener("focus", pull); };
  }, [client]);

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
  const title = dimmed ? "Balances stale — last known values" : undefined;

  return (
    <header className="flex h-9 shrink-0 items-center justify-end gap-1.5 overflow-hidden border-b border-[var(--color-tr-edge)] px-3">
      <div className={`flex min-w-0 items-center gap-1.5 ${dimmed ? "opacity-45" : ""}`} title={title}>
        {chips.map(c => (
          <span key={c.key} title={c.tooltip}
            className="flex h-5 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px]">
            {/* the icon: a 16px circle in the provider's brand hue + its monogram */}
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: c.hue, color: c.fg }}>
              <span className="text-[8px] font-semibold leading-none">{c.mono}</span>
            </span>
            {/* the value reads at full brightness; the status tints speak for themselves */}
            <span className={`tr-mono shrink-0 ${toneClass(c.tone)}`}>{c.value}</span>
          </span>
        ))}
      </div>
    </header>
  );
}
