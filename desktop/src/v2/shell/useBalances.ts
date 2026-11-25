// The plans-and-balances read, the same contract as classic BalanceStrip: machine-keyed, local
// hub as fallback, five-minute cadence, a real CLI re-fetch once the snapshot is stale (#v2-F).
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HubClient, type BalancesReport } from "../../shared/api/client";
import { LOCAL_HUB } from "./useShellData";

const REFRESH_MS = 5 * 60 * 1000;
const REFETCH_AFTER_MS = 10 * 60 * 1000;

let machineIdCache: string | undefined;
async function machineId(): Promise<string | undefined> {
  if (machineIdCache) return machineIdCache;
  try { machineIdCache = (await invoke<string>("machine_id")) || undefined; } catch { /* no id: the hub answers with its latest push */ }
  return machineIdCache;
}

export type BalancesState = { report: BalancesReport | null; failure: string | null; refreshError: string | null; spinning: boolean; refetch: () => void };

export function useBalances(client: HubClient): BalancesState {
  const [report, setReport] = useState<BalancesReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // #14055 — the refresh command's failure is evidence: kept here and shown beside the chips,
  // never swallowed, so a dim strip always says which of stale-or-failed it is.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);
  const pull = useCallback(async () => {
    const machine = await machineId();
    const isLocal = client.baseUrl.includes("127.0.0.1") || client.baseUrl.includes("localhost");
    const read = isLocal ? client.balances(machine) : client.balances(machine).catch(() => new HubClient(LOCAL_HUB).balances(machine));
    return read
      .then(r => { setReport(r); setFailure(null); return r; })
      .catch((error: Error) => { setFailure(error.message); return null; });
  }, [client]);

  const busy = useRef(false);
  const refetch = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSpinning(true);
    setRefreshError(null);
    try { await invoke("balances_refresh"); } catch (e) { setRefreshError(e instanceof Error ? e.message : String(e)); }
    await pull();
    setSpinning(false);
    busy.current = false;
  }, [pull]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      const r = await pull();
      if (alive && r && r.ts && Date.now() - r.ts > REFETCH_AFTER_MS) void refetch();
    };
    void tick();
    const t = setInterval(() => void tick(), REFRESH_MS);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => { alive = false; clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [pull, refetch]);

  return { report, failure, refreshError, spinning, refetch: () => void refetch() };
}
