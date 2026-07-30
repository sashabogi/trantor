// FEED — the second lens. Same append-only log the BOARD is a projection of, shown as it happens:
// cards, messages, presence, handoffs and gates in one stream. That is the whole point of the
// 0.17.54 event-log work — one record, two views — so this deliberately does not filter down to
// "chat". Chat is one type among several — which is exactly what the chips express: they narrow
// the ONE stream, they never change what is in it.
import { useEffect, useMemo, useState } from "react";
import type { HubClient, HubEvent } from "../../shared/api/client";
import { CardDetail } from "../board/CardDetail";

const KIND_COLOR = (t: string) =>
  t === "message" ? "var(--color-tr-doing)"
  : t.startsWith("presence") ? "var(--color-tr-muted)"
  : t.startsWith("verify") ? "var(--color-tr-warn)"
  : t.startsWith("handoff") ? "var(--color-tr-ok)"
  : "var(--color-tr-edge)";

// Card events keep their LEGACY flat shape and legacy type names (created/moved/updated, never
// card.created) — invariant 1 of the event log. Every newer type is dotted, which is exactly how we
// tell them apart here without a lookup table. The chips reuse that same distinction.
const CARD_TYPES = new Set(["created", "moved", "updated"]);
const CHIPS = [
  { key: "all",      test: (_e: HubEvent) => true },
  { key: "cards",    test: (e: HubEvent) => CARD_TYPES.has(e.type) },
  { key: "chat",     test: (e: HubEvent) => e.type === "message" },
  { key: "presence", test: (e: HubEvent) => e.type.startsWith("presence") },
  { key: "gates",    test: (e: HubEvent) => e.type.startsWith("verify") },
  { key: "handoffs", test: (e: HubEvent) => e.type.startsWith("handoff") },
] as const;
type ChipKey = (typeof CHIPS)[number]["key"];

function label(e: HubEvent): string {
  const t = e.type;
  const any = e as Record<string, unknown>;
  if (t === "message") return String(any.text ?? "");
  if (CARD_TYPES.has(t)) {
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

// The card an event leads to: card events carry taskId; a message mentions one as "#123".
function cardRef(e: HubEvent): number | null {
  if (typeof e.taskId === "number") return e.taskId;
  if (e.type === "message") {
    const m = /#(\d+)(?![0-9])/.exec(String((e as Record<string, unknown>).text ?? ""));
    if (m) return Number(m[1]);
  }
  return null;
}

export function Feed({ client, project }: { client: HubClient; project: string }) {
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [live, setLive] = useState(false);
  const [chip, setChip] = useState<ChipKey>("all");
  const [open, setOpen] = useState<number | null>(null);

  // Backfill first so the feed is never empty while waiting for something to happen.
  useEffect(() => {
    let alive = true;
    setEvents([]); setOpen(null); setChip("all");
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

  const active = CHIPS.find(c => c.key === chip) ?? CHIPS[0];
  const visible = useMemo(() => events.filter(active.test), [events, active]);
  const counts = useMemo(() => {
    const out = {} as Record<ChipKey, number>;
    for (const c of CHIPS) out[c.key] = c.key === "all" ? events.length : events.filter(c.test).length;
    return out;
  }, [events]);

  return (
    <div className="tr-pane relative flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--color-tr-edge)] px-5 py-3">
        <h1 className="text-base font-semibold">{project}</h1>
        <div className="flex items-center gap-1">
          {CHIPS.map(c => (
            <button key={c.key} onClick={() => setChip(c.key)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] ${
                chip === c.key
                  ? "bg-black/40 text-[var(--color-tr-text)]"
                  : "text-[var(--color-tr-muted)] hover:bg-black/20"}`}>
              {c.key}{counts[c.key] ? ` ${counts[c.key]}` : ""}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                style={{ background: live ? "var(--color-tr-ok)" : "var(--color-tr-muted)" }} />
          {live ? "live" : "connecting…"}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {visible.map((e, i) => {
          const ref = cardRef(e);
          return (
            <div key={`${e.id ?? "x"}:${i}`}
                 onClick={ref !== null ? () => setOpen(ref) : undefined}
                 className={`flex gap-3 border-l-2 py-1.5 pl-3 text-sm ${ref !== null ? "cursor-pointer hover:bg-black/20" : ""}`}
                 style={{ borderColor: KIND_COLOR(e.type) }}>
              <span className="tr-mono w-14 shrink-0 text-[11px] text-[var(--color-tr-muted)]">
                {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className="w-36 shrink-0 truncate text-[11px] text-[var(--color-tr-muted)]">{e.by ?? "—"}</span>
              <span className="min-w-0 flex-1 break-words">{label(e)}</span>
            </div>
          );
        })}
        {!visible.length && (
          <div className="p-4 text-sm text-[var(--color-tr-muted)]">
            {events.length ? `No ${chip} events in the last ${events.length}.` : "No events yet."}
          </div>
        )}
      </div>
      {open !== null && <CardDetail client={client} id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
