// The card drawer: header, moves, and Overview / Code / Story / Timeline tabs (#13989).
import { useEffect, useState } from "react";
import { cardCode, openCode, openFileInEditor } from "../../../shared/api/client";
import type { CardCode, HubClient, HubEvent, Message } from "../../../shared/api/client";
import { cleanTitle } from "../../../shared/Avatar";
import { dictGet } from "../../../shared/dict";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Chip, type ChipTone } from "../../ui/Chip";
import { IconButton } from "../../ui/IconButton";
import { seatLabel } from "../../ui/identity";
import { allowedMoves, drillLine, fileCandidates, nextOf, type BoardCard } from "./model";
import { CodeTab, OverviewTab, StoryTab, TimelineTab } from "./DrawerTabs";

const TONE = { todo: "neutral", doing: "info", testing: "warn", done: "ok", failed: "bad", blocked: "bad", stale: "neutral" } as const satisfies Record<string, ChipTone>;
const TABS = ["overview", "code", "story", "timeline"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL = { overview: "Overview", code: "Code", story: "Story", timeline: "Timeline" } as const satisfies Record<Tab, string>;

type Detail = { task: BoardCard | null; events: HubEvent[]; messages: Message[] };

function useDetail(client: HubClient, id: number) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<CardCode | null>(null);
  const load = () => client.card(id).then(setData).catch(e => setError(String(e?.message || e)));
  useEffect(() => { setData(null); setError(null); setCode(null); void load(); }, [client, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!data?.task) return;
    const cands = fileCandidates([data.task.title, ...data.messages.map(m => m.text)]);
    cardCode(data.task.project, id, cands).then(setCode).catch(() => {});
  }, [data, id]);
  useEffect(() => client.streamEvents(ev => {
    if (ev.taskId === id || (ev.type === "message" && new RegExp(`#${id}(?![0-9])`).test(ev.text ?? ""))) void load();
  }), [client, id]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, code, load };
}

function Moves({ task, busy, error, onMove }: { task: BoardCard; busy: boolean; error: string | null; onMove: (s: string) => void }) {
  const next = nextOf(task.status);
  const back = allowedMoves(task.status).filter(s => s !== next);
  const noDrill = next === "done" && !drillLine(task);
  const forwardLabel = next === "done" ? "Done" : next === "testing" ? "Send to testing" : "Start";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {next && (
          <Button variant="primary" onClick={() => onMove(next)} title={`Advance to ${next}`}
            disabledReason={busy ? "Moving the card" : noDrill ? "Done is refused until the card has a drill line (a drill field, or a Drill: note)" : null}>
            {forwardLabel}
          </Button>
        )}
        {back.map(s => (
          <Button key={s} onClick={() => onMove(s)} disabledReason={busy ? "Moving the card" : null} title={`Move back to ${s}`}>
            {s === "doing" && task.status === "testing" ? "Bounce to doing" : `Back to ${s}`}
          </Button>
        ))}
        {task.status !== "failed" && task.status !== "done" && (
          <Button variant="danger" onClick={() => onMove("failed")} disabledReason={busy ? "Moving the card" : null} title="Mark the card failed">Failed</Button>
        )}
      </div>
      {error && <div role="alert" className="text-[11.5px] text-[var(--v2-bad)]">{error}</div>}
    </div>
  );
}

function Header({ task, id, error, onClose }: { task: BoardCard | null; id: number; error: string | null; onClose: () => void }) {
  const seat = task?.workedBy || task?.assignee;
  const meta = [task?.model, task?.source && `filed via ${task.source}`, task?.costUsd != null && `$${task.costUsd.toFixed(2)}`].filter(Boolean).join(" · ");
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="v2-mono text-[11.5px] text-[var(--v2-muted)]">#{id}</span>
        {task && <Chip tone={dictGet(TONE, task.status) ?? "neutral"}>{task.status}</Chip>}
        {task?.difficulty && <span className="text-[11px] text-[var(--v2-muted)]">{task.difficulty}</span>}
        <span className="flex-1" />
        <IconButton label="Close card" title="Close the card drawer" onClick={onClose}>×</IconButton>
      </div>
      <h2 className="m-0 break-words text-[15px] font-semibold leading-[1.3]">
        {task ? (task.summary || cleanTitle(task.title)) : error ? `Card unavailable: ${error}` : "Loading…"}
      </h2>
      {task && (seat || meta) && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--v2-muted)]">
          {seat && <Avatar name={seat} size={22} surface="var(--v2-side)" />}
          {seat && <span className="text-[var(--v2-text-2)]">{seatLabel(seat)}</span>}
          {meta && <span>{seat ? "· " : ""}{meta}</span>}
        </div>
      )}
    </>
  );
}

export type DrawerProps = { client: HubClient; id: number; onClose: () => void; onMoved: () => void; onOpen: (id: number) => void };

export function Drawer({ client, id, onClose, onMoved, onOpen }: DrawerProps) {
  const { data, error, code, load } = useDetail(client, id);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  useEffect(() => { setTab("overview"); setMoveError(null); }, [id]);
  const task = data?.task ?? null;
  const move = (status: string) => {
    if (!task) return;
    setBusy(true); setMoveError(null);
    client.moveCard(task.id, status)
      .then(() => { void load(); onMoved(); })
      .catch(e => setMoveError(`The hub refused the move: ${String(e?.message || e)}`))
      .finally(() => setBusy(false));
  };
  const toggle = (index: number, done: boolean) => {
    if (!task) return;
    client.checklistToggle(task.id, index, done).then(() => { void load(); onMoved(); }).catch(() => { void load(); });
  };
  const count = (n: number) => n > 0 ? <span className="ml-1 text-[10.5px] text-[var(--v2-muted)]">{n}</span> : null;
  const badge = { overview: null, code: count((code?.files.length ?? 0) + (code?.commits.length ?? 0)), story: count(task?.log?.length ?? 0), timeline: null };
  return (
    <aside aria-label={`Card #${id}`} className="flex w-[430px] shrink-0 flex-col border-l border-[var(--v2-edge)] bg-[var(--v2-side)]">
      <div className="flex flex-col gap-[9px] border-b border-[var(--v2-edge)] px-4 py-3">
        <Header task={task} id={id} error={error} onClose={onClose} />
        {task && <Moves task={task} busy={busy} error={moveError} onMove={move} />}
      </div>
      <div role="tablist" aria-label="Card sections" className="flex gap-1 border-b border-[var(--v2-edge)] px-3">
        {TABS.map(t => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`border-0 border-b-2 bg-transparent px-2.5 py-2 text-[12px] font-medium ${tab === t ? "border-[var(--v2-accent)] text-[var(--v2-text)]" : "border-transparent text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
            {TAB_LABEL[t]}{badge[t]}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {task && tab === "overview" && <OverviewTab task={task} onToggle={toggle} onOpen={onOpen} />}
        {task && tab === "code" && <CodeTab code={code} onFile={f => void openFileInEditor(`${code?.dir}/${f}`)} onCommit={sha => code?.origin ? void openCode(`${code.origin}/commit/${sha}`, "url") : void navigator.clipboard?.writeText(sha)} />}
        {task && tab === "story" && <StoryTab log={task.log ?? []} />}
        {task && tab === "timeline" && <TimelineTab events={data?.events ?? []} messages={data?.messages ?? []} />}
      </div>
    </aside>
  );
}
