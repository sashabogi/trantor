// One seat on the roster: who, what state, what card, what it may do, its plan, and the actions (#13992).
import { useState } from "react";
import { AlertTriangle, ArrowLeftRight, CornerDownRight, MessageSquare, RotateCw, ShieldCheck, Square, Terminal } from "lucide-react";
import type { BalanceChip } from "../../../features/fleet/balanceChips";
import { LEVEL_LABEL } from "../../../features/overseer/model";
import { dictGet } from "../../../shared/dict";
import { ago } from "../../../shared/presence";
import type { Card, HubClient } from "../../../shared/api/client";
import { Avatar, Chip, IconButton, modelHue, PRESENCE_LABEL, seatLabel, type Navigate } from "../../index";
import type { SeatView } from "./model";

const NOT_WIRED_SWAP = "Swap is not wired yet: the hub has no swap endpoint";
const NOT_WIRED_HANDOFF = "Hand off is not wired yet: handoffs start from the seat's own session";
const NOT_WIRED_STOP = "Stopping a single seat is not wired yet: only the duty seat has a stop";

const STATE_COLOR = { working: "var(--v2-accent)", "needs-you": "var(--v2-warn)", ready: "var(--v2-ok)", offline: "var(--v2-muted)" } as const;

export type DutyControls = { busy: boolean; start: () => void; stop: () => void };

export type AgentCardProps = {
  client: HubClient;
  view: SeatView;
  card: Card | null;
  plan: BalanceChip | null;
  level: number;
  onNavigate: Navigate;
  /** Present only on the duty seat's card: the one seat the app can start and stop. */
  duty?: DutyControls;
};

function stateLine(v: SeatView): string {
  const seen = ago(v.peer.lastSeen);
  if (v.presence === "needs-you") return "waiting on you";
  if (v.presence === "working") return `seen ${seen} ago`;
  if (v.presence === "ready") return `idle ${seen}`;
  return `last seen ${seen} ago`;
}

function PlanBar({ plan, vendor }: { plan: BalanceChip | null; vendor: string }) {
  if (!plan) return <span className="text-[11px] text-[var(--v2-muted)]">{vendor} plan: not reported</span>;
  const fill = plan.tone === "ok" ? "var(--v2-accent)" : "var(--v2-warn)";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--v2-muted)]" title={plan.tooltip}>
      plan
      {plan.barPct != null && (
        <span className="h-1 w-[54px] overflow-hidden rounded-full bg-[var(--v2-track)]">
          <span className="block h-full" style={{ width: `${plan.barPct}%`, background: fill }} />
        </span>
      )}
      <span className="text-[var(--v2-text-2)]">{plan.value}</span>
    </span>
  );
}

function MessageBox({ client, view, onDone }: { client: HubClient; view: SeatView; onDone: () => void }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const send = () => client.send(view.peer.session, text.trim(), view.project || undefined)
    .then(() => { setNote("sent"); setText(""); onDone(); }).catch((e: Error) => setNote(e.message));
  return (
    <div className="mt-2 flex items-center gap-2">
      <input aria-label={`Message ${seatLabel(view.peer.session)}`} value={text} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && text.trim()) void send(); }} placeholder="Write a message"
        className="min-w-0 flex-1 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-bg)] px-2.5 py-1.5 text-[12px] text-[var(--v2-text)]" />
      <button type="button" disabled={!text.trim()} onClick={() => void send()}
        className="rounded-lg border border-[var(--v2-edge-2)] px-2.5 py-1.5 text-[12px] text-[var(--v2-text)] disabled:opacity-45">Send</button>
      {note && <span className="text-[11px] text-[var(--v2-muted)]">{note}</span>}
    </div>
  );
}

function Actions({ view, onNavigate, duty, onMessage }: Pick<AgentCardProps, "view" | "onNavigate" | "duty"> & { onMessage: () => void }) {
  const name = seatLabel(view.peer.session);
  const offline = view.presence === "offline";
  return (
    <div className="mt-2.5 flex items-center gap-1 border-t border-[var(--v2-edge)] pt-2">
      <IconButton label={`Message ${name}`} title={`Message ${name}`} onClick={onMessage} disabled={offline}><MessageSquare size={14} /></IconButton>
      <IconButton label="Open its terminal" title="Open its terminal in the Workspace" onClick={() => onNavigate("workspace", view.project || undefined)}><Terminal size={14} /></IconButton>
      <IconButton label="Swap model or harness" title={NOT_WIRED_SWAP} disabled><ArrowLeftRight size={14} /></IconButton>
      <IconButton label="Hand off" title={NOT_WIRED_HANDOFF} disabled><CornerDownRight size={14} /></IconButton>
      {duty
        ? <IconButton label="Restart the runner" title="Start the duty seat (trantor duty up)" disabled={duty.busy} onClick={duty.start}><RotateCw size={14} /></IconButton>
        : <IconButton label="Restart the runner" title="Restart is not wired yet: only the duty seat can be started from the app" disabled><RotateCw size={14} /></IconButton>}
      <span className="flex-1" />
      {duty
        ? <IconButton label={`Stop ${name}`} title={`Stop ${name}: its work stays on its branch`} disabled={duty.busy} onClick={duty.stop}><Square size={13} /></IconButton>
        : <IconButton label={`Stop ${name}`} title={NOT_WIRED_STOP} disabled><Square size={13} /></IconButton>}
    </div>
  );
}

export function AgentCard(props: AgentCardProps) {
  const { view, card, plan, level, onNavigate } = props;
  const [composing, setComposing] = useState(false);
  const p = view.peer;
  const model = p.model || "";
  const warn = plan && plan.tone !== "ok" && view.presence !== "offline";
  return (
    <article data-presence={view.presence} aria-label={seatLabel(p.session)}
      className={`rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel)] p-3 ${view.presence === "offline" ? "opacity-55" : ""}`}>
      <div className="flex items-center gap-2.5">
        <Avatar name={p.session} size={28} presence={view.presence} surface="var(--v2-panel)" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold">{seatLabel(p.session)}</span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--v2-muted)]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: modelHue(`${view.vendor} ${model}`) }} />
              {view.vendor.toLowerCase()}{model && <> · <span className="text-[var(--v2-text-2)]">{model}</span></>}
            </span>
          </div>
          <div className="text-[11.5px] text-[var(--v2-muted)]">
            <span style={{ color: STATE_COLOR[view.presence] }}>{PRESENCE_LABEL[view.presence]}</span> · {stateLine(view)} · {p.machine || "machine unknown"}
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px]">
        {card
          ? <button type="button" onClick={() => onNavigate("board", card.project)} title={card.title}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate border-0 bg-transparent p-0 text-left text-[var(--v2-accent)]">
              <span className="v2-mono shrink-0 text-[var(--v2-muted)]">#{card.id}</span><span className="truncate">{card.title}</span></button>
          : <span className="text-[var(--v2-muted)]">no card · waiting for a contract</span>}
        <Chip icon={<ShieldCheck size={11} />} title="What the project's autonomy level lets the overseer do without asking">
          Autonomy {level} · {dictGet(LEVEL_LABEL, String(level)) ?? "set"}
        </Chip>
      </div>
      <div className="mt-2"><PlanBar plan={plan} vendor={view.vendor} /></div>
      {warn && (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-2 py-1 text-[11.5px] text-[var(--v2-warn)]">
          <AlertTriangle size={12} />{plan.label} plan {plan.value}: give it light work until the reset
        </div>
      )}
      {composing && <MessageBox client={props.client} view={view} onDone={() => setComposing(false)} />}
      <Actions view={view} onNavigate={onNavigate} duty={props.duty} onMessage={() => setComposing(c => !c)} />
    </article>
  );
}
