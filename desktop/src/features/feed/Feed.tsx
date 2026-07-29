// FEED — the second lens. Same append-only log the BOARD is a projection of, shown as it happens:
// cards, messages, presence, handoffs and gates in one stream. That is the whole point of the
// 0.17.54 event-log work — one record, two views — so this deliberately does not filter down to
// "chat". Chat is one type among several.
import { useEffect, useState } from "react";
import type { HubClient, HubEvent } from "../../shared/api/client";

const KIND_COLOR = (t: string) =>
  t === "message" ? "var(--color-tr-doing)"
  : t.startsWith("presence") ? "var(--color-tr-muted)"
  : t.startsWith("verify") ? "var(--color-tr-warn)"
  : t.startsWith("handoff") ? "var(--color-tr-ok)"
  : "var(--color-tr-edge)";

// Card events keep their LEGACY flat shape and legacy type names (created/moved/updated, never
// card.created) — invariant 1 of the event log. Every newer type is dotted, which is exactly how we
// tell them apart here without a lookup table.
function label(e: HubEvent): string {
  const t = e.type;
  const any = e as Record<string, unknown>;
  if (t === "message") return String(any.text ?? "");
  if (t === "created" || t === "moved" || t === "updated") {
    const status = any.status ? ` → ${String(any.status)}` : "";
    const title = any.title ? `: ${String(any.title)}` : "";
    return `#${e.taskId ?? "?"} ${t}${status}${title}`;
  }
  if (t.startsWith("presence")) return `${e.by ?? "?"} ${t.split(".")[1] ?? ""}`;
  if (t.startsWith("handoff")) return `handoff written by ${e.by ?? "?"}`;
  if (t.startsWith("verify")) return `verify gate ${t.split(".").slice(1).join(" ")}`;
  const rest = { ...any };
  for (const k of ["ts", "type", "by", "project", "id"]) delete rest[k];
  return JSON.stringify(rest).slice(0, 180);
}

export function Feed({ client, project }: { client: HubClient; project: string }) {
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [live, setLive] = useState(false);

  // Backfill first so the feed is never empty while waiting for something to happen.
  useEffect(() => {
    let alive = true;
    setEvents([]);
    client.events({ project, limit: 200 })
      .then(r => { if (alive) setEvents((r.events ?? []).slice().reverse()); })
      .catch(() => {});
    return () => { alive = false; };
  }, [client, project]);

  // Then live. The stream is hub-wide, so filter to this project — but only when the event carries
  // one; a global event with no project still belongs in view.
  useEffect(() => {
    // `live` must mean CONNECTED, not "we have seen an event" — an idle project would otherwise sit
    // on "connecting…" forever while the stream was perfectly healthy.
    const off = client.streamEvents(ev => {
      if (ev.project && ev.project !== project) return;
      setEvents(prev => [ev, ...prev].slice(0, 500));
    }, () => setLive(true));
    return off;
  }, [client, project]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--color-tr-edge)] px-5 py-3">
        <h1 className="text-base font-semibold">{project}</h1>
        <span className="text-xs text-[var(--color-tr-muted)]">feed · {events.length}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                style={{ background: live ? "var(--color-tr-ok)" : "var(--color-tr-muted)" }} />
          {live ? "live" : "connecting…"}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {events.map((e, i) => (
          <div key={`${e.id ?? "x"}:${i}`}
               className="flex gap-3 border-l-2 py-1.5 pl-3 text-sm"
               style={{ borderColor: KIND_COLOR(e.type) }}>
            <span className="w-14 shrink-0 text-[11px] text-[var(--color-tr-muted)]">
              {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="w-36 shrink-0 truncate text-[11px] text-[var(--color-tr-muted)]">{e.by ?? "—"}</span>
            <span className="min-w-0 flex-1 break-words">{label(e)}</span>
          </div>
        ))}
        {!events.length && <div className="p-4 text-sm text-[var(--color-tr-muted)]">No events yet.</div>}
      </div>
    </div>
  );
}
