// The costs header, ported from ui.html. Two figures, deliberately NEVER summed: Scrooge's REAL
// spend on cheap models (with the frontier-yardstick savings), and the NOTIONAL cost of
// plan-covered Claude work on the active project — adding them would imply we paid for
// plan-covered tokens.
//
// Notional comes from the PROJECT hub (it rides on cards); the Scrooge window comes from the
// MACHINE-LOCAL hub — the ledger is a file on this machine that no remote hub can read.
//
// Defaults to LIFETIME: the point of the header is the running total of what the cheap-model
// strategy has saved, not last night's $0.05. The selector narrows on demand.
import { useEffect, useState } from "react";
import { HubClient } from "./api/client";
import type { Economics } from "./api/client";

const LOCAL_HUB = "http://127.0.0.1:4477";
const WINDOWS = ["24h", "week", "month", "lifetime"] as const;
type Win = (typeof WINDOWS)[number];

// Survives unmount/remount (the tab strip only exists on project panes, so switching to a global
// view and back remounts this component). Without the cache the strip blanks out for a fetch
// round-trip every time — which reads as "the header is gone".
const cache: { econ: Record<string, Economics>; local: Economics | null } = { econ: {}, local: null };

export function CostStrip({ client, project }: { client: HubClient; project: string }) {
  const [econ, setEcon] = useState<Economics | null>(cache.econ[client.baseUrl] ?? null);
  const [localEcon, setLocalEcon] = useState<Economics | null>(cache.local);
  const [win, setWin] = useState<Win>("lifetime");

  useEffect(() => {
    let alive = true;
    setEcon(cache.econ[client.baseUrl] ?? null);
    const isLocal = client.baseUrl.includes("127.0.0.1") || client.baseUrl.includes("localhost");
    const local = isLocal ? null : new HubClient(LOCAL_HUB);
    const pull = () => {
      client.economics().then(d => { cache.econ[client.baseUrl] = d; if (alive) setEcon(d); }).catch(() => {});
      if (local) local.economics().then(d => { cache.local = d; if (alive) setLocalEcon(d); }).catch(() => {});
      else client.economics().then(d => { cache.local = d; if (alive) setLocalEcon(d); }).catch(() => {});
    };
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  const w = localEcon?.windows?.[win] ?? econ?.windows?.[win];
  // notional per project is lifetime by construction (it rides on the cards themselves)
  const notional = econ?.notionalByProject?.[project] ?? localEcon?.notionalByProject?.[project];
  const showScrooge = !!w && w.calls > 0;
  if (!showScrooge && notional == null) return null;

  return (
    <span className="tr-mono ml-auto flex items-center gap-2 text-[11px] text-[var(--color-tr-muted)]">
      {showScrooge && (
        <span title={`${w.calls} cheap-model calls (${win}) · $${w.cost_usd.toFixed(2)} spent vs $${w.opus_equiv_usd.toFixed(2)} frontier-equivalent`}>
          scrooge ${w.cost_usd.toFixed(2)}
          <span className="ml-1 text-[var(--color-tr-ok)]">saved ${w.saved_usd.toFixed(0)}</span>
        </span>
      )}
      {showScrooge && (
        <select value={win} onChange={e => setWin(e.target.value as Win)}
                className="rounded border border-[var(--color-tr-edge)] bg-black/20 px-1 py-0.5 text-[10px] text-[var(--color-tr-muted)] outline-none">
          {WINDOWS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      )}
      {notional != null && (
        <span title="plan-covered Claude work on this project, lifetime (notional, not billed)">
          claude ${notional.toFixed(2)} <span className="opacity-60">notional</span>
        </span>
      )}
    </span>
  );
}
