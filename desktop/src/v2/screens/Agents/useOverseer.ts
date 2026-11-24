// The watcher's live state for the Overseer column, read with the same calls classic Overseer makes (#13992).
import { useCallback, useEffect, useState } from "react";
import { dutyStart, dutyStop, type DutyHealth, type HubClient, type HubEvent, type OverseerStatus, type Proposal } from "../../../shared/api/client";

const POLL_MS = 15_000;

/** A mutation that reports what it did in one line. */
export type Action = () => Promise<string>;

export type OverseerData = {
  status: OverseerStatus | null;
  duty: DutyHealth | null;
  history: HubEvent[];
  grants: Proposal[];
  error: string | null;
  notice: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  /** Run a mutation, show its output as the notice, then re-read. */
  run: (action: Action) => Promise<void>;
  startDuty: () => void;
  stopDuty: () => void;
};

/** An older or partial hub reply must not crash the column: fill the lists the view iterates (#13992). */
function withDefaults(s: OverseerStatus): OverseerStatus {
  return { ...s, warnings: s.warnings ?? [], links: s.links ?? [], autonomy: s.autonomy ?? {},
    watching: s.watching ?? { sessions: 0, projects: 0, claims: 0, links: 0 } };
}

export function useOverseer(client: HubClient): OverseerData {
  const [status, setStatus] = useState<OverseerStatus | null>(null);
  const [duty, setDuty] = useState<DutyHealth | null>(null);
  const [history, setHistory] = useState<HubEvent[]>([]);
  const [grants, setGrants] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    await Promise.allSettled([
      client.overseerStatus().then(s => { setStatus(withDefaults(s)); setError(null); }).catch((e: Error) => setError(e.message)),
      client.health().then(h => setDuty(h.duty ?? null)).catch(() => setDuty(null)),
      client.events({ type: "overseer.", limit: 300 }).then(r => setHistory(r.events ?? [])).catch(() => setHistory([])),
      client.proposals({ status: "approved" }).then(r => setGrants(r.proposals ?? [])).catch(() => setGrants([])),
    ]);
  }, [client]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    const off = client.streamEvents(ev => { if (ev.type?.startsWith("overseer.") || ev.type?.startsWith("presence")) void refresh(); });
    return () => { clearInterval(t); off(); };
  }, [client, refresh]);

  const run = useCallback(async (action: Action) => {
    setBusy(true); setNotice(null);
    try {
      const out = await action();
      setNotice(out || "done");
      await refresh();
    } catch (e) { setNotice(String(e)); } finally { setBusy(false); }
  }, [refresh]);

  return { status, duty, history, grants, error, notice, busy, refresh, run,
    startDuty: () => void run(dutyStart), stopDuty: () => void run(dutyStop) };
}
