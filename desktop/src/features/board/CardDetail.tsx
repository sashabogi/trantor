// CardDetail — the drawer a card opens into, shared by BOARD and FEED. One card's full story:
// status events and the bus messages that reference it (#<id>), interleaved chronologically —
// the /card endpoint's thread derivation (invariant 3: threads are DERIVED, never stored).
//
// This exists because a board tile can only say WHAT state a card is in; the drawer says WHY —
// the agent's own reports are in the messages, and the moves are in the events.
import { useEffect, useState } from "react";
import type { Card, HubClient, HubEvent, Message } from "../../shared/api/client";

// Same flow map as the board: testing is a real gate the crew protocol depends on, so the drawer
// must not offer a shortcut the protocol forbids either.
const NEXT: Record<string, string> = { todo: "doing", doing: "testing", testing: "done" };
const FLOW = ["todo", "doing", "testing", "done"];

// What the drawer lets a human do with a card's status. Forward: ONE step (the gate stays a gate).
// Backward: ANY earlier stage — a misclicked card must be recoverable, and rolling back skips no
// gate. Exception lanes (failed/blocked/stale) re-enter the flow at todo or doing.
function allowedMoves(status: string): string[] {
  const i = FLOW.indexOf(status);
  if (i >= 0) return [...FLOW.slice(0, i), ...(NEXT[status] ? [NEXT[status]] : [])];
  return ["todo", "doing"];
}

const STATUS_COLOR: Record<string, string> = {
  todo: "var(--color-tr-muted)",
  doing: "var(--color-tr-doing)",
  testing: "var(--color-tr-warn)",
  done: "var(--color-tr-ok)",
  failed: "var(--color-tr-fail)",
  blocked: "var(--color-tr-fail)",
  stale: "var(--color-tr-muted)",
};

type Row = { ts: number; by: string; kind: "event" | "message"; text: string };

function rows(events: HubEvent[], messages: Message[]): Row[] {
  const out: Row[] = [];
  for (const e of events) {
    const any = e as Record<string, unknown>;
    const move = any.from && any.to ? `${String(any.from)} → ${String(any.to)}` : String(e.type);
    out.push({ ts: e.ts, by: e.by ?? "", kind: "event", text: move });
  }
  for (const m of messages) out.push({ ts: m.ts, by: m.from, kind: "message", text: m.text });
  return out.sort((a, b) => a.ts - b.ts);
}

export function CardDetail({ client, id, onClose, onMoved }: {
  client: HubClient; id: number; onClose: () => void; onMoved?: () => void;
}) {
  const [data, setData] = useState<{ task: Card | null; events: HubEvent[]; messages: Message[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => client.card(id).then(setData).catch(e => setError(String(e.message || e)));

  useEffect(() => { setData(null); setError(null); void load(); }, [client, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The thread stays live the same way the board does: react to this card's events by refetching
  // rather than replaying hub-side mutation logic client-side.
  useEffect(() => {
    return client.streamEvents(ev => {
      if (ev.taskId === id || (ev.type === "message" && new RegExp(`#${id}(?![0-9])`).test(String((ev as Record<string, unknown>).text ?? "")))) {
        void load();
      }
    });
  }, [client, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const task = data?.task ?? null;
  const moves = task ? allowedMoves(task.status) : [];
  const moveTo = (status: string) => {
    if (!task) return;
    client.moveCard(task.id, status).then(() => { void load(); onMoved?.(); }).catch(() => {});
  };

  return (
    <div className="absolute inset-0 z-20 flex" onClick={onClose}>
      <div className="tr-backdrop flex-1" />
      <div className="tr-drawer flex h-full w-[440px] shrink-0 flex-col border-l border-[var(--color-tr-edge)] bg-[var(--color-tr-panel)]"
           onClick={e => e.stopPropagation()}>
        <header className="border-b border-[var(--color-tr-edge)] px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="tr-mono text-xs text-[var(--color-tr-muted)]">#{id}</span>
            {task && (
              <span className="rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wide"
                    style={{ background: "rgba(0,0,0,.3)", color: STATUS_COLOR[task.status] ?? "var(--color-tr-muted)" }}>
                {task.status}
              </span>
            )}
            {task && moves.map(s => {
              const forward = s === NEXT[task.status];
              return (
                <button key={s} onClick={() => moveTo(s)}
                        title={forward ? `advance to ${s}` : `move back to ${s}`}
                        className={`rounded border px-2 py-0.5 text-[11px] ${
                          forward
                            ? "border-[var(--color-tr-doing)] text-[var(--color-tr-text)] hover:bg-black/30"
                            : "border-[var(--color-tr-edge)] text-[var(--color-tr-muted)] hover:border-[var(--color-tr-warn)] hover:text-[var(--color-tr-text)]"}`}>
                  {forward ? "→" : "←"} {s}
                </button>
              );
            })}
            <button onClick={onClose} className="ml-auto rounded px-2 text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]">✕</button>
          </div>
          <div className="mt-2 text-sm leading-snug">{task ? task.title : error ? `Card unavailable: ${error}` : "Loading…"}</div>
          {task && (
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
              {task.assignee && <span className="rounded bg-black/30 px-1.5 py-0.5">@{task.assignee}</span>}
              {task.difficulty && <span className="rounded bg-black/30 px-1.5 py-0.5">{task.difficulty}</span>}
              {task.model && <span className="rounded bg-black/30 px-1.5 py-0.5">{task.model}</span>}
              {task.source && <span className="rounded bg-black/30 px-1.5 py-0.5">{task.source}</span>}
              {typeof task.costUsd === "number" && <span className="rounded bg-black/30 px-1.5 py-0.5">${task.costUsd.toFixed(2)}</span>}
            </div>
          )}
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {data && rows(data.events, data.messages).map((r, i) => (
            <div key={i} className="flex gap-3 py-1.5 text-sm">
              <span className="tr-mono w-20 shrink-0 text-[11px] leading-5 text-[var(--color-tr-muted)]">
                {new Date(r.ts).toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
                {new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <div className="min-w-0 flex-1">
                <span className="mr-2 text-[11px] text-[var(--color-tr-muted)]">{r.by || "—"}</span>
                {r.kind === "event"
                  ? <span className="text-[13px] text-[var(--color-tr-muted)]">{r.text}</span>
                  : <div className="whitespace-pre-wrap break-words text-[13px]">{r.text}</div>}
              </div>
            </div>
          ))}
          {data && !data.events.length && !data.messages.length && (
            <div className="p-2 text-sm text-[var(--color-tr-muted)]">No history for this card yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
