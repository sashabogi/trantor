// Collisions — the overseer's POINTER on Home: is anything about to step on itself, and how long
// has it been true. The full surface (watcher heartbeat, watch map, history) is the Overseer view;
// this stays deliberately short.
//
// It renders the SAME rolled-up conditions as that view. Rendering one row per event turned a
// single 8-day condition into an endless identical list on the home screen — the log is a log, not
// a feed of news.
import { useEffect, useState } from "react";
import type { HubClient, HubEvent } from "../../shared/api/client";
import { rollUp } from "../../shared/rollup";

export function Collisions({ client }: { client: HubClient }) {
  const [events, setEvents] = useState<HubEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Fetch DEEP so the counts are true — the point is to say "this one condition, 59 times",
    // not to show 59 rows.
    const load = () => client.events({ type: "overseer.", limit: 300 })
      .then(res => {
        if (cancelled) return;
        setEvents(res.events.filter(e => e.type === "overseer.warn"));
      })
      .catch(() => { if (!cancelled) setEvents([]); });
    load();
    const unsub = client.streamEvents(e => { if (e.type === "overseer.warn") load(); });
    return () => { cancelled = true; unsub(); };
  }, [client]);

  const rolled = rollUp(events);
  const when = (ts: number) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <section className="min-w-0">
      <h2 className="tr-sec-title">Collisions</h2>
      <p className="tr-sec-sub">Where two agents are about to step on each other — one row per condition.</p>
      <div className="mt-3 flex flex-col gap-2">
        {rolled.slice(0, 4).map(({ rep: e, count, first, last }, i) => {
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
                  {count > 1 && <span className="tr-chip shrink-0 text-[var(--color-tr-warn)]">×{count}</span>}
                  {files.slice(0, 2).map(f => <span key={f} className="tr-chip tr-mono shrink-0">{f}</span>)}
                  <span className="text-[11px] text-[var(--color-tr-muted)]">
                    {count > 1 ? <>{when(first)} → {when(last)}</> : when(last)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {!rolled.length && (
          <div className="tr-card-ghost flex items-center justify-center p-6 text-[13px]">
            No collisions — the fleet is clear.
          </div>
        )}
        {rolled.length > 4 && (
          <p className="px-1 text-[11px] text-[var(--color-tr-muted)]">
            +{rolled.length - 4} more condition(s) — see Overseer.
          </p>
        )}
      </div>
    </section>
  );
}
