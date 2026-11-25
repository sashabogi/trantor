// The four drawer tab bodies, kept apart from the drawer's load and move logic (#13989).
import type { ReactNode } from "react";
import type { CardCode, HubEvent, Message } from "../../../shared/api/client";
import { Checkbox } from "../../ui/Checkbox";
import { drillLine, type BoardCard } from "./model";

function Block({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <div className="mb-1.5 flex items-center text-[10.5px] font-semibold tracking-[0.08em] text-[var(--v2-muted)]">
        <span className="flex-1">{title}</span>{aside && <span className="font-normal tracking-normal">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ line }: { line: string }) => <p className="m-0 text-[12px] text-[var(--v2-muted)]">{line}</p>;

const stamp = (ts: number) => `${new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" })} ${new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

export function OverviewTab({ task, onToggle, onOpen }: { task: BoardCard; onToggle: (index: number, done: boolean) => void; onOpen: (id: number) => void }) {
  const drill = drillLine(task);
  const list = task.checklist ?? [];
  const done = list.filter(i => i.done).length;
  const link = task.commitCard ?? task.focusCard;
  return (
    <>
      <Block title="DRILL">
        {drill
          ? <div className="rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)] p-2.5 text-[12.5px] leading-[1.45] text-[var(--v2-text-2)]">{drill}</div>
          : <Empty line="No drill line yet. Done is refused until one is on the card." />}
      </Block>
      <Block title="ACCEPTANCE" aside={list.length ? `${done}/${list.length}` : undefined}>
        {list.length === 0 && <Empty line="No acceptance items on this card." />}
        {list.map((item, i) => (
          <label key={`${i}:${item.text}`} className="flex cursor-pointer items-start gap-2 py-[3px] text-[12.5px] text-[var(--v2-text-2)]">
            <Checkbox checked={item.done} onChange={() => onToggle(i, !item.done)} className="mt-[3px]" />
            <span className={item.done ? "text-[var(--v2-muted)] line-through" : ""}>{item.text}</span>
          </label>
        ))}
      </Block>
      {link != null && (
        <Block title="LINKED">
          <button type="button" onClick={() => onOpen(Number(link))} className="v2-hover rounded border-0 bg-transparent p-0 text-[12px] text-[var(--v2-accent)] underline decoration-dotted underline-offset-2">
            {task.commitCard ? `closed by commit #${task.commitCard}` : `closed the session's work #${task.focusCard}`}
          </button>
        </Block>
      )}
    </>
  );
}

export function CodeTab({ code, onFile, onCommit }: { code: CardCode | null; onFile: (f: string) => void; onCommit: (sha: string) => void }) {
  if (!code || !code.dir || (!code.files.length && !code.commits.length)) return <Empty line="No files or commits linked to this card yet." />;
  return (
    <>
      <Block title="REPOSITORY"><span className="v2-mono text-[11px] text-[var(--v2-muted)]">{code.dir.replace(/^\/Users\/[^/]+/, "~")}</span></Block>
      {code.files.length > 0 && (
        <Block title="FILES" aside={String(code.files.length)}>
          <div className="flex flex-wrap gap-1.5">
            {code.files.map(f => (
              <button key={f} type="button" onClick={() => onFile(f)} title={`Open ${f} in your editor`}
                className="v2-hover v2-mono rounded-md border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-[7px] py-[2px] text-[11px] text-[var(--v2-text-2)]">{f}</button>
            ))}
          </div>
        </Block>
      )}
      {code.commits.length > 0 && (
        <Block title="COMMITS" aside={String(code.commits.length)}>
          {code.commits.map(c => (
            <button key={c.sha} type="button" onClick={() => onCommit(c.sha)} title={code.origin ? "Open the commit on GitHub" : "Copy the sha"}
              className="v2-hover flex w-full items-baseline gap-2 rounded border-0 bg-transparent px-1 py-0.5 text-left">
              <span className="v2-mono shrink-0 text-[11px] text-[var(--v2-warn)]">{c.sha.slice(0, 8)}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--v2-muted)]">{c.subject}</span>
            </button>
          ))}
        </Block>
      )}
    </>
  );
}

export function StoryTab({ log }: { log: { ts: number; by: string; text: string }[] }) {
  if (!log.length) return <Empty line="No notes on this card yet." />;
  return (
    <>
      {log.map((e, i) => (
        <div key={`${e.ts}:${i}`} className="mb-3">
          <div className="text-[10.5px] text-[var(--v2-muted)]">{e.by || "unknown"} · {stamp(e.ts)}</div>
          <div className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.45] text-[var(--v2-text-2)]">{e.text}</div>
        </div>
      ))}
    </>
  );
}

export function TimelineTab({ events, messages }: { events: HubEvent[]; messages: Message[] }) {
  const rows = [
    ...events.map(e => ({ ts: e.ts, by: e.by ?? "", text: e.from && e.to ? `${e.from} → ${e.to}` : e.type, msg: false })),
    ...messages.map(m => ({ ts: m.ts, by: m.from, text: m.text, msg: true })),
  ].sort((a, b) => a.ts - b.ts);
  if (!rows.length) return <Empty line="No history for this card yet." />;
  return (
    <>
      {rows.map((r, i) => (
        <div key={`${r.ts}:${i}`} className="mb-2.5 flex gap-3">
          <span className="v2-mono w-[84px] shrink-0 text-[10.5px] leading-5 text-[var(--v2-muted)]">{stamp(r.ts)}</span>
          <div className="min-w-0 flex-1">
            <span className="mr-2 text-[10.5px] text-[var(--v2-muted)]">{r.by || "unknown"}</span>
            <div className={`whitespace-pre-wrap break-words text-[12.5px] ${r.msg ? "text-[var(--v2-text-2)]" : "text-[var(--v2-muted)]"}`}>{r.text}</div>
          </div>
        </div>
      ))}
    </>
  );
}
