// The dead-duty strip (#5688, folded into the Usage card): Home wears a red strip while the
// hub flags the duty seat dark — "nobody is watching the bus" must be visible on the one
// screen that claims to show the fleet at a glance, not buried in a log. The native
// notification fires ONLY on the healthy→dark edge the app observed (dutyDarkEdge), once per
// episode — a first read that is already dark is hours-old news and stays silent.
//
// The read is the hub's /health duty block, per the contract: "the /health duty read for the
// Home strip stands as written."
import { useEffect, useRef, useState } from "react";
import { HubClient } from "../../shared/api/client";
import { notifyDutyDark } from "../../shared/notify";
import { darkDuration, dutyDarkEdge, dutyIsDark, fetchDutyHealth, lastSeenAgo, type DutyHealth } from "./dutyHealth";

export function DutyStrip({ client }: { client: HubClient }) {
  const [health, setHealth] = useState<DutyHealth | null>(null);
  const prev = useRef<DutyHealth | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const h = await fetchDutyHealth(client.baseUrl);
      if (!alive) return;
      // h non-null is implied by dutyDarkEdge (a dark edge requires a dark next read), but the
      // narrowing keeps notifyDutyDark's parameter honest to the compiler.
      if (h && dutyDarkEdge(prev.current, h)) void notifyDutyDark(h);
      prev.current = h;
      setHealth(h);
    };
    void tick();
    const t = setInterval(() => void tick(), 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  if (!dutyIsDark(health)) return null;
  const queued = health!.queuedEscalations;
  return (
    <div role="alert" className="mb-7 flex items-start gap-3 rounded-md border px-4 py-3"
      style={{ borderColor: "var(--color-tr-fail)", background: "color-mix(in srgb, var(--color-tr-fail) 10%, transparent)" }}>
      <span className="tr-dot mt-1.5 shrink-0" style={{ background: "var(--color-tr-fail)" }} />
      <div className="min-w-0">
        <div className="text-[13px] font-medium" style={{ color: "var(--color-tr-fail)" }}>
          Duty seat dark — nobody is watching the bus.
        </div>
        <div className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">
          Last reported {lastSeenAgo(health!.lastSeenMs)} ago · dark for {darkDuration(health!.darkSinceMs)}
          {!!queued && ` · ${queued} escalation${queued === 1 ? "" : "s"} routed around it`}
          {" "}· bring it back: <span className="tr-mono">trantor duty up</span>
        </div>
      </div>
    </div>
  );
}
