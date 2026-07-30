// The costs header, ported from ui.html. Two figures, deliberately NEVER summed: Scrooge's REAL
// spend on cheap models (with the frontier-yardstick savings), and the NOTIONAL cost of
// plan-covered Claude work on the active project — adding them would imply we paid for
// plan-covered tokens. Renders nothing it doesn't have: a hub without a ledger shows only the
// notional side, an idle project shows nothing at all.
//
// Notional comes from the PROJECT hub (it rides on cards); the Scrooge window comes from the
// MACHINE-LOCAL hub — the ledger is a file on this machine that no remote hub can read.
import { useEffect, useState } from "react";
import { HubClient } from "./api/client";
import type { Economics } from "./api/client";

const LOCAL_HUB = "http://127.0.0.1:4477";

export function CostStrip({ client, project }: { client: HubClient; project: string }) {
  const [econ, setEcon] = useState<Economics | null>(null);
  const [localEcon, setLocalEcon] = useState<Economics | null>(null);

  useEffect(() => {
    let alive = true;
    const local = client.baseUrl.includes("127.0.0.1") || client.baseUrl.includes("localhost")
      ? null
      : new HubClient(LOCAL_HUB);
    const pull = () => {
      client.economics().then(d => { if (alive) setEcon(d); }).catch(() => {});
      if (local) local.economics().then(d => { if (alive) setLocalEcon(d); }).catch(() => {});
    };
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  if (!econ && !localEcon) return null;
  const w = localEcon?.windows?.["24h"] ?? econ?.windows?.["24h"];
  const notional = econ?.notionalByProject?.[project];
  const showScrooge = !!w && w.calls > 0;
  if (!showScrooge && notional == null) return null;

  return (
    <span className="tr-mono ml-auto flex items-center gap-3 text-[11px] text-[var(--color-tr-muted)]">
      {showScrooge && (
        <span title={`${w.calls} cheap-model calls in 24h · $${w.cost_usd.toFixed(2)} spent vs $${w.opus_equiv_usd.toFixed(2)} frontier-equivalent`}>
          scrooge 24h ${w.cost_usd.toFixed(2)}
          <span className="ml-1 text-[var(--color-tr-ok)]">saved ${w.saved_usd.toFixed(0)}</span>
        </span>
      )}
      {notional != null && (
        <span title="plan-covered Claude work on this project (notional, not billed)">
          claude ${notional.toFixed(2)} <span className="opacity-60">notional</span>
        </span>
      )}
    </span>
  );
}
