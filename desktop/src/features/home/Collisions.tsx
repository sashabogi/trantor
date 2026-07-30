// Collisions — the overseer's face on Home: where two agents are about to step on each other.
// Renders overseer.warn events (narration when the cheap model has explained one, mechanical
// detail otherwise). Drafted by scrooge (deepseek-v4-flash), integrated by the orchestrator.
import { useEffect, useState } from "react";
import type { HubClient, HubEvent } from "../../shared/api/client";

export function Collisions({ client }: { client: HubClient }) {
  const [events, setEvents] = useState<HubEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    client.events({ type: "overseer.", limit: 50 })
      .then(res => {
        if (cancelled) return;
        setEvents(res.events.filter(e => e.type === "overseer.warn").sort((a, b) => b.ts - a.ts).slice(0, 8));
      })
      .catch(() => { if (!cancelled) setEvents([]); });
    const unsub = client.streamEvents(e => {
      if (e.type === "overseer.warn") setEvents(prev => [e, ...prev].slice(0, 8));
    });
    return () => { cancelled = true; unsub(); };
  }, [client]);

  return (
    <section className="min-w-0">
      <h2 className="tr-sec-title">Collisions</h2>
      <p className="tr-sec-sub">Where two agents are about to step on each other.</p>
      <div className="mt-3 flex flex-col gap-2">
        {events.map((e, i) => {
          const any = e as Record<string, unknown>;
          const kind = String(any.kind ?? "");
          const narration = any.narration as string | undefined;
          const files = (any.files as string[] | undefined) ?? [];
          const dot = kind === "file-conflict" ? "var(--color-tr-fail)" : "var(--color-tr-warn)";
          return (
            <div key={e.id ?? i} className="tr-card flex items-start gap-3 p-3.5">
              <span className="tr-dot shrink-0" style={{ background: dot, marginTop: 6 }} />
              <div className="min-w-0 flex-1">
                <div className="break-words text-[13px] leading-snug">{narration ?? String(any.detail ?? "")}</div>
                <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
                  {e.project && <span className="tr-chip shrink-0">{e.project}</span>}
                  {kind && <span className="tr-chip shrink-0">{kind}</span>}
                  {files.slice(0, 3).map(f => <span key={f} className="tr-chip tr-mono shrink-0">{f}</span>)}
                  <span className="text-[11px] text-[var(--color-tr-muted)]">
                    {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {!events.length && (
          <div className="tr-card-ghost flex items-center justify-center p-6 text-[13px]">
            No collisions — the fleet is clear.
          </div>
        )}
      </div>
    </section>
  );
}
