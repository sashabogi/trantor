// The fleet balance strip — the app header's right side, one chip per configured provider. This
// is chrome, so it stays SMALL: a monogram + the single number that matters, tinted only when a
// provider is LOW. A failed fetch keeps the last known values with the strip dimmed — never an
// error banner. Data rides the MACHINE-LOCAL hub by design (balances/profile are files on this
// machine; the snapshot the CLI pushes there is cheap to read) — the same two-hub split Home uses.
import { useEffect, useState } from "react";
import { HubClient, type BalancesReport } from "../../shared/api/client";
import { chipFrom, type BalanceRow } from "./balanceChips";

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
  // (usage/limit/resetTime/via/unlimited) that the conservative BalanceEntry type omits; the
  // chip formatter reads them, so the boundary decodes to the widened row shape once, here.
  const rows = (report?.entries ?? []) as BalanceRow[];
  if (!rows.length) return null; // no configured providers — no chrome that says nothing

  const dimmed = failed || report?.stale === true;
  const title = dimmed ? "Balances stale — last known values" : undefined;

  return (
    <header className="flex h-9 shrink-0 items-center justify-end gap-1.5 overflow-hidden border-b border-[var(--color-tr-edge)] px-3">
      <div className={`flex min-w-0 items-center gap-1.5 ${dimmed ? "opacity-45" : ""}`} title={title}>
        {rows.map(e => {
          const c = chipFrom(e);
          return (
            <span key={c.key} title={c.tooltip}
              className={`flex h-5 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] ${
                c.low ? "bg-[var(--color-tr-warn)]/10 text-[var(--color-tr-warn)]"
                      : "text-[var(--color-tr-muted)]"}`}>
              <span className="truncate">{c.label}</span>
              <span className="tr-mono shrink-0">{c.value}</span>
              {/* the reset suffix is the chip's widest part — it shrinks away on narrow windows,
                  leaving the monogram + number that still means something */}
              {c.reset && <span className="tr-mono hidden shrink-0 min-[520px]:inline">{c.reset}</span>}
            </span>
          );
        })}
      </div>
    </header>
  );
}
