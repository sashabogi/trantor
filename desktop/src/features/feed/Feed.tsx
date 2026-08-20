// FEED — the second lens. Same append-only log the BOARD is a projection of, shown as it happens:
// cards, messages, presence, handoffs and gates in one stream. That is the whole point of the
// 0.17.54 event-log work — one record, two views — so this deliberately does not filter down to
// "chat". Chat is one type among several — which is exactly what the chips express: they narrow
// the ONE stream, they never change what is in it.
import { useEffect, useMemo, useState } from "react";
import type { HubClient, HubEvent } from "../../shared/api/client";
import { CardDetail } from "../board/CardDetail";
import { ProjectHeader, type Lens } from "../project/ProjectHeader";
import { AgentChip, cleanTitle } from "../../shared/Avatar";

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
  if (t === "message") return e.text ?? "";
  if (CARD_TYPES.has(t)) {
    // narrate the card's movement, not its schema: "#3986 → testing · P1-D Social UI"
    const move = e.from && e.to ? `${e.from} → ${e.to}`
      : e.status ? `→ ${e.status}` : t;
    const title = e.title ? ` · ${cleanTitle(e.title)}` : "";
    return `#${e.taskId ?? "?"} ${move}${title}`;
  }
  if (t === "focus") return `now working on: ${cleanTitle(e.title ?? "")}`;
  if (t === "file.claim") return `editing ${e.file ?? "a file"}`;
  if (t === "file.conflict") return `⚠ editing ${e.file ?? "a file"} at the same time as ${Array.isArray(e.with) ? e.with.join(", ") : "another session"}`;
  if (t === "project.adopted") return `project adopted onto this hub`;
  if (t === "lesson") return `recorded a lesson: ${cleanTitle(e.text ?? "")}`;
  if (t.startsWith("presence")) return `${t.split(".")[1] ?? t}`;
  if (t.startsWith("handoff")) return `wrote a handoff`;
  if (t.startsWith("verify")) return `verify gate ${t.split(".").slice(1).join(" ")}`;
  const known = e.title ?? e.text ?? "";
  return known ? cleanTitle(known) : t;
}

// The card an event leads to: card events carry taskId; a message mentions one as "#123".
function cardRef(e: HubEvent): number | null {
  if (e.taskId != null) return e.taskId;
  if (e.type === "message") {
    const m = /#(\d+)(?![0-9])/.exec(e.text ?? "");
    if (m) return Number(m[1]);
  }
  return null;
}

export function Feed({ client, project, lens, onLens }: {
  client: HubClient; project: string; lens: Lens; onLens: (l: Lens) => void;
}) {
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
    const out: Partial<Record<ChipKey, number>> = {};
    for (const c of CHIPS) out[c.key] = c.key === "all" ? events.length : events.filter(c.test).length;
    return out;
  }, [events]);

  return (
    <div className="tr-pane relative flex h-full flex-col">
      <ProjectHeader project={project} lens={lens} onLens={onLens}
        sub={<span className="inline-flex items-center gap-1.5">
          <span className="tr-dot" style={{ background: live ? "var(--color-tr-ok)" : "var(--color-tr-muted)" }} />
          {live ? "live" : "connecting…"} · everything that happens, as it happens
        </span>} />
      <div className="flex items-center gap-1.5 px-8 pb-3">
        {CHIPS.map(c => (
          <button key={c.key} onClick={() => setChip(c.key)}
            className={`rounded-full px-3 py-1 text-[12px] ${
              chip === c.key
                ? "bg-white/[0.08] font-medium text-[var(--color-tr-text)]"
                : "text-[var(--color-tr-muted)] hover:bg-white/[0.04] hover:text-[var(--color-tr-text)]"}`}>
            {c.key}{counts[c.key] ? ` ${counts[c.key]}` : ""}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-8 pb-4">
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
              <span className="flex w-44 shrink-0 items-center gap-1.5 truncate text-[11px] text-[var(--color-tr-muted)]">
                {e.by ? <AgentChip session={String(e.by)} /> : "—"}
              </span>
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
