// #14492: the duty-dark warning on the 2.0 Dashboard — a STATE, not an event. The amber note is on
// screen while the hub flags the duty seat dark, says how long, and leaves the moment it is back.
// No toast: classic Home's strip (#5688) already fires the one notification per dark edge; a second
// here would be the spam the monitoring doctrine forbids. Start is the classic Overseer chip's own dutyStart.
import { useCallback, useEffect, useRef, useState } from "react";
import { dutyStart, type DutyHealth, type HubClient } from "../../../shared/api/client";
import { dutyIsDark } from "../../../features/home/dutyHealth";
import { NoteCard } from "../../ui/NoteCard";

const POLL_MS = 60_000;

/** "under a minute" / "23 minutes" / "1 hour 5 minutes" — duration words, not a timestamp. */
export function downFor(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"}`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  const hours = `${h} ${h === 1 ? "hour" : "hours"}`;
  return rm ? `${hours} ${rm} minutes` : hours;
}

export type DutyDarkState = {
  duty: DutyHealth | null;
  busy: boolean;
  /** Why a Start attempt failed, in the command's own words; a good poll clears it. */
  error: string | null;
  start: () => void;
};

/** The duty-dark state the hub's /health already publishes, read on the classic strip's cadence. */
export function useDutyDark(client: HubClient): DutyDarkState {
  const [duty, setDuty] = useState<DutyHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const starting = useRef(false);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await client.health();
        if (!alive) return;
        setDuty(h.duty ?? null);
        setError(null);
      } catch { /* an unreachable hub keeps the last reading; the next poll tries again */ }
    };
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [client]);
  const start = useCallback(() => {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    dutyStart()
      .then(() => client.health())
      .then(h => { setDuty(h.duty ?? null); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => { starting.current = false; setBusy(false); });
  }, [client]);
  return { duty, busy, error, start };
}

/** The one-line warning at the top of the Dashboard; renders nothing while the seat is up. */
export function DutyDarkNote({ client }: { client: HubClient }) {
  const { duty, busy, error, start } = useDutyDark(client);
  if (!duty || !dutyIsDark(duty)) return null;
  return (
    <div className="mb-4">
      <NoteCard note="duty-dark"
        action={{ label: busy ? "Starting…" : "Start duty", title: "Start the duty seat again (trantor duty up)", onClick: start }}>
        Duty seat is down · {downFor(duty.darkSinceMs)}{error ? ` · start failed: ${error}` : ""}
      </NoteCard>
    </div>
  );
}
