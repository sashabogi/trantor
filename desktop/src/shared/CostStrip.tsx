// The header strip — full parity with ui.html's top bar, not a subset of it:
//   🪙 what the cheap-model strategy SAVED vs frontier (lifetime headline + a window's detail)
//   🧠 what the orchestrator's own Claude work would have cost (notional, plan-covered) — global,
//      with the active project's share beside it. NEVER summed with real spend.
//   💰 every configured provider's balance / quota / subscription tier, low ones flagged
//   the fleet tally: projects · live sessions · cards
//
// Data comes from TWO hubs by design. The Scrooge ledger, profile.json and balance snapshots are
// files on THIS machine — only the machine-local hub can serve them. Notional and the tally ride
// the project hub. A module-level cache survives remounts (the tab strip only exists on project
// panes), so a detour through a global view never blanks the figures.
import { useEffect, useState } from "react";
import { HubClient } from "./api/client";
import type { BalancesReport, Economics } from "./api/client";

const LOCAL_HUB = "http://127.0.0.1:4477";
const WINDOWS = ["24h", "week", "month", "lifetime"] as const;
type Win = (typeof WINDOWS)[number];

type Tally = { live: number; cards: number };
const cache: {
  econ: Record<string, Economics>; local: Economics | null;
  balances: BalancesReport | null; tally: Record<string, Tally>;
} = { econ: {}, local: null, balances: null, tally: {} };

function BalancePill({ e }: { e: BalancesReport["entries"][number] }) {
  // a prepaid key with no reported balance (unlimited / no balance endpoint) must not fake a $0.00
  const text =
    e.kind === "prepaid" ? `${e.label || e.provider}${e.remaining != null ? ` $${e.remaining.toFixed(2)}` : ""}`
    : e.kind === "quota" ? `${e.label || e.provider} ${e.remainingPct ?? "?"}%`
    : `${e.label || e.provider} (${e.plan || "sub"})`;
  return (
    <span title={`${e.provider} · ${e.kind}${e.plan ? ` · ${e.plan}` : ""}${e.low ? " · LOW" : ""}`}
          style={e.low ? { color: "var(--color-tr-fail)" } : undefined}>
      {text}
    </span>
  );
}

export function CostStrip({ client, project, projectCount }: {
  client: HubClient; project: string; projectCount?: number;
}) {
  const [econ, setEcon] = useState<Economics | null>(cache.econ[client.baseUrl] ?? null);
  const [localEcon, setLocalEcon] = useState<Economics | null>(cache.local);
  const [balances, setBalances] = useState<BalancesReport | null>(cache.balances);
  const [tally, setTally] = useState<Tally | null>(cache.tally[client.baseUrl] ?? null);
  const [win, setWin] = useState<Win>("lifetime");

  useEffect(() => {
    let alive = true;
    setEcon(cache.econ[client.baseUrl] ?? null);
    setTally(cache.tally[client.baseUrl] ?? null);
    const isLocal = client.baseUrl.includes("127.0.0.1") || client.baseUrl.includes("localhost");
    const local = isLocal ? client : new HubClient(LOCAL_HUB);
    const pull = () => {
      client.economics().then(d => { cache.econ[client.baseUrl] = d; if (alive) setEcon(d); }).catch(() => {});
      local.economics().then(d => { cache.local = d; if (alive) setLocalEcon(d); }).catch(() => {});
      local.balances().then(d => { cache.balances = d; if (alive) setBalances(d); }).catch(() => {});
      Promise.all([client.peers().catch(() => []), client.tasks().catch(() => [])]).then(([peers, tasks]) => {
        const t = { live: peers.filter(p => p.online).length, cards: tasks.length };
        cache.tally[client.baseUrl] = t;
        if (alive) setTally(t);
      });
    };
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  const w = localEcon?.windows?.[win] ?? econ?.windows?.[win];
  const lifetime = localEcon?.windows?.lifetime ?? econ?.windows?.lifetime;
  // notional: GLOBAL headline (subagent + orchestrator, lifetime) + this project's share
  const ck = econ?.costKinds?.lifetime ?? localEcon?.costKinds?.lifetime ?? {};
  const notionalGlobal = (ck["subagent-notional"]?.usd ?? 0) + (ck["orchestrator-notional"]?.usd ?? 0);
  const notionalHere = econ?.notionalByProject?.[project] ?? localEcon?.notionalByProject?.[project];
  const showScrooge = !!w && !!lifetime && lifetime.calls > 0;
  if (!showScrooge && !notionalGlobal && !balances && !tally) return null;

  return (
    <span className="tr-mono ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-[11px] leading-5 text-[var(--color-tr-muted)]">
      {showScrooge && (
        <span title={`Scrooge ledger — real spend on cheap models vs the frontier yardstick.\nlifetime: $${lifetime.cost_usd.toFixed(2)} spent of $${lifetime.opus_equiv_usd.toFixed(2)} frontier-equivalent\n${win}: ${w.calls} calls · $${w.cost_usd.toFixed(2)} spent · $${w.opus_equiv_usd.toFixed(2)} equivalent`}>
          saved <span className="text-[var(--color-tr-ok)]">${lifetime.saved_usd.toFixed(2)}</span> vs frontier
          <select value={win} onChange={e => setWin(e.target.value as Win)}
                  className="mx-1 rounded border border-[var(--color-tr-edge)] bg-black/20 px-1 py-0 text-[10px] text-[var(--color-tr-muted)] outline-none">
            {WINDOWS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          ${w.cost_usd.toFixed(2)} ({w.calls} calls)
        </span>
      )}
      {notionalGlobal > 0 && (
        <span title={`Plan-covered Claude work (notional, not billed), lifetime across all projects${notionalHere != null ? ` — $${notionalHere.toFixed(2)} on ${project}` : ""}`}>
          claude <span className="text-[var(--color-tr-text)]">${Math.round(notionalGlobal).toLocaleString()}</span> notional
          {notionalHere != null && <span className="opacity-60"> · ${Math.round(notionalHere).toLocaleString()} here</span>}
        </span>
      )}
      {balances && balances.entries.length > 0 && (
        <span className="flex items-center gap-2" title={balances.stale ? "balance snapshot older than 6h" : undefined}>
          {balances.entries.map(e => <BalancePill key={e.provider} e={e} />)}
          {balances.stale && <span className="text-[var(--color-tr-warn)]">stale</span>}
        </span>
      )}
      {tally && (
        <span>{projectCount ?? "?"} projects · {tally.live} live · {tally.cards} cards</span>
      )}
    </span>
  );
}
