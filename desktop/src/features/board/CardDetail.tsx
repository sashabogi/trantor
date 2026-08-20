// CardDetail — the drawer a card opens into, shared by BOARD and FEED. One card's full story:
// status events and the bus messages that reference it (#<id>), interleaved chronologically —
// the /card endpoint's thread derivation (invariant 3: threads are DERIVED, never stored).
//
// This exists because a board tile can only say WHAT state a card is in; the drawer says WHY —
// the agent's own reports are in the messages, and the moves are in the events. Since the CARDLOG
// contract, the card's own `log` (notes attached as it moved) leads as the STORY — the timeline
// of events/messages follows as the supplement.
import { useEffect, useState } from "react";
import { cardCode, openFileInEditor, openCode } from "../../shared/api/client";
import type { Card, CardCode, HubClient, HubEvent, Message } from "../../shared/api/client";
import { AgentChip, cleanTitle } from "../../shared/Avatar";
import { dictGet } from "../../shared/dict";

// Same flow map as the board: testing is a real gate the crew protocol depends on, so the drawer
// must not offer a shortcut the protocol forbids either. Keyed by a card's live `status`, not a
// closed type client-side, so lookups go through `dictGet` rather than indexing directly.
const NEXT = { todo: "doing", doing: "testing", testing: "done" } as const satisfies Record<string, string>;
const FLOW = ["todo", "doing", "testing", "done"];

// What the drawer lets a human do with a card's status. Forward: ONE step (the gate stays a gate).
// Backward: ANY earlier stage — a misclicked card must be recoverable, and rolling back skips no
// gate. Exception lanes (failed/blocked/stale) re-enter the flow at todo or doing.
function allowedMoves(status: string): string[] {
  const i = FLOW.indexOf(status);
  const next = dictGet(NEXT, status);
  if (i >= 0) return [...FLOW.slice(0, i), ...(next ? [next] : [])];
  return ["todo", "doing"];
}

const STATUS_COLOR = {
  todo: "var(--color-tr-muted)",
  doing: "var(--color-tr-doing)",
  testing: "var(--color-tr-warn)",
  done: "var(--color-tr-ok)",
  failed: "var(--color-tr-fail)",
  blocked: "var(--color-tr-fail)",
  stale: "var(--color-tr-muted)",
} as const satisfies Record<string, string>;

type Row = { ts: number; by: string; kind: "event" | "message"; text: string };

function rows(events: HubEvent[], messages: Message[]): Row[] {
  const out: Row[] = [];
  for (const e of events) {
    const move = e.from && e.to ? `${e.from} → ${e.to}` : e.type;
    out.push({ ts: e.ts, by: e.by ?? "", kind: "event", text: move });
  }
  for (const m of messages) out.push({ ts: m.ts, by: m.from, kind: "message", text: m.text });
  return out.sort((a, b) => a.ts - b.ts);
}

// File-looking tokens in the card's own thread — the raw material of the card→code link.
function fileCandidates(task: Card | null, messages: Message[]): string[] {
  const text = [task?.title ?? "", ...messages.map(m => m.text)].join("\n");
  const out = new Set<string>();
  const re = /(?:^|[\s"'`(=,])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z]{1,6})(?=[\s"'`),.:;]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.size < 40) out.add(m[1]);
  return [...out];
}

export function CardDetail({ client, id, onClose, onMoved, onOpen }: {
  client: HubClient; id: number; onClose: () => void; onMoved?: () => void;
  /** follow a link to another card without closing the drawer */
  onOpen?: (id: number) => void;
}) {
  const [data, setData] = useState<{ task: Card | null; events: HubEvent[]; messages: Message[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<CardCode | null>(null);

  const load = () => client.card(id).then(setData).catch(e => setError(String(e.message || e)));

  useEffect(() => { setData(null); setError(null); setCode(null); void load(); }, [client, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The card→code link resolves on THIS machine once the thread is here: which mentioned files
  // exist in the repo, which commits touch the card (or its files), where origin lives.
  useEffect(() => {
    if (!data?.task) return;
    const cands = fileCandidates(data.task, data.messages);
    cardCode(data.task.project, id, cands).then(setCode).catch(() => {});
  }, [data, id]);

  // The thread stays live the same way the board does: react to this card's events by refetching
  // rather than replaying hub-side mutation logic client-side.
  useEffect(() => {
    return client.streamEvents(ev => {
      if (ev.taskId === id || (ev.type === "message" && new RegExp(`#${id}(?![0-9])`).test(ev.text ?? ""))) {
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
                    style={{ background: "rgba(0,0,0,.3)", color: dictGet(STATUS_COLOR, task.status) ?? "var(--color-tr-muted)" }}>
                {task.status}
              </span>
            )}
            {task && moves.map(s => {
              const forward = s === dictGet(NEXT, task.status);
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
          <div className="mt-2 text-sm leading-snug break-words">{task ? (task.summary || cleanTitle(task.title)) : error ? `Card unavailable: ${error}` : "Loading…"}</div>
          {task?.summary && cleanTitle(task.title) !== task.summary && (
            <div className="mt-1 text-[11px] leading-snug break-words text-[var(--color-tr-muted)]">{cleanTitle(task.title)}</div>
          )}
          {task && (
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
              {task.assignee && <AgentChip session={task.assignee} />}
              {task.difficulty && <span className="rounded bg-black/30 px-1.5 py-0.5">{task.difficulty}</span>}
              {task.model && <span className="rounded bg-black/30 px-1.5 py-0.5">{task.model}</span>}
              {task.source && <span className="rounded bg-black/30 px-1.5 py-0.5">{task.source}</span>}
              {task.costUsd != null && <span className="rounded bg-black/30 px-1.5 py-0.5">${task.costUsd.toFixed(2)}</span>}
            </div>
          )}
          {/* A commit and the session work it finished point at each other. Following the link is
              the whole value — "what shipped this" and "what did this ship" are one click apart. */}
          {task && (task.commitCard || task.focusCard) && (
            <button
              type="button"
              onClick={() => onOpen?.(Number(task.commitCard ?? task.focusCard))}
              className="mt-2 text-[11px] text-[var(--color-tr-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-tr-text)]">
              {task.commitCard ? `closed by commit #${task.commitCard}` : `closed the session's work #${task.focusCard}`}
            </button>
          )}
        </header>
        {code && code.dir && (code.files.length > 0 || code.commits.length > 0) && (
          <div className="border-b border-[var(--color-tr-edge)] px-4 py-3">
            <div className="tr-label mb-2">code · <span className="tr-mono normal-case tracking-normal">{code.dir.replace(/^\/Users\/[^/]+/, "~")}</span></div>
            {code.files.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {code.files.map(f => (
                  <button key={f} onClick={() => void openFileInEditor(`${code.dir}/${f}`)}
                          title={`open ${f} in your editor (Settings → Open code in)`}
                          className="tr-chip tr-mono hover:text-[var(--color-tr-text)]">
                    📄 {f}
                  </button>
                ))}
              </div>
            )}
            {code.commits.map(c => (
              <button key={c.sha}
                      onClick={() => code.origin ? void openCode(`${code.origin}/commit/${c.sha}`, "url") : void navigator.clipboard?.writeText(c.sha)}
                      title={code.origin ? "open commit on GitHub" : "copy sha"}
                      className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-white/[0.04]">
                <span className="tr-mono shrink-0 text-[11px] text-[var(--color-tr-warn)]">{c.sha.slice(0, 8)}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-tr-muted)]">{c.subject}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* The STORY is the card's own log — notes its author attached as it moved. It is the
              primary narrative (CARDLOG contract): first, visually distinct, written in the agent's
              own words. Events and messages below stay as the supplement they always were. */}
          {task?.log && task.log.length > 0 && (
            <div className="mb-3 border-b border-[var(--color-tr-edge)] pb-2">
              <div className="tr-label mb-1">story</div>
              {task.log.map((e, i) => (
                <div key={i} className="flex gap-3 py-1.5 text-sm">
                  <span className="tr-mono w-20 shrink-0 text-[11px] leading-5 text-[var(--color-tr-muted)]">
                    {new Date(e.ts).toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
                    {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="mr-2 text-[11px] text-[var(--color-tr-muted)]">{e.by || "—"}</span>
                    <div className="whitespace-pre-wrap break-words text-[13px]">{e.text}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {task?.log && task.log.length > 0 && <div className="tr-label mb-1">timeline</div>}
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
          {data && !data.events.length && !data.messages.length && !task?.log?.length && (
            <div className="p-2 text-sm text-[var(--color-tr-muted)]">No history for this card yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
