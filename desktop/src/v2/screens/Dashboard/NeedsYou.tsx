// "Needs you": the ranked queue across projects, each row with its own actions (#13986).
import { useState } from "react";
import { AlertTriangle, FileWarning, GitPullRequest, MessageCircleQuestion, ShieldQuestion, type LucideIcon } from "lucide-react";
import type { Navigate } from "../../routes";
import { Button } from "../../ui/Button";
import { ProjectTile } from "../../ui/ProjectTile";
import type { Decisions } from "./useDecisions";
import { span, type OldTesting, type QueueItem, type QueueKind } from "./model";

const KIND_ICON = { hold: FileWarning, proposal: ShieldQuestion, message: MessageCircleQuestion, testing: GitPullRequest } as const satisfies Record<QueueKind, LucideIcon>;
const KIND_LABEL = { hold: "Collision gate", proposal: "Proposal", message: "Question", testing: "Drill" } as const satisfies Record<QueueKind, string>;

export function ItemMeta({ item }: { item: QueueItem }) {
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[var(--v2-muted)]">
      <ProjectTile name={item.project || "?"} size={16} />
      <span className="truncate">
        {item.project || "no project"}
        {item.card ? ` · #${item.card.id}` : ""}{item.seat ? ` · ${item.seat}` : ""} · {span(item.ts)}
      </span>
    </div>
  );
}

function Actions({ item, d, onNavigate }: { item: QueueItem; d: Decisions; onNavigate: Navigate }) {
  const off = d.busy ? "Saving a decision" : null;
  const { hold, proposal } = item;
  if (hold) {
    return (
      <>
        <Button variant="primary" disabledReason={off} onClick={() => void d.decideHold(hold, "go")}>{hold.session} first</Button>
        <Button disabledReason={off} onClick={() => void d.decideHold(hold, "nogo")}>{hold.other} first</Button>
        <Button variant="quiet" disabledReason="Comparing both changes needs a diff API the hub does not have yet">Compare both changes</Button>
      </>
    );
  }
  if (proposal) {
    return (
      <>
        <Button variant="primary" disabledReason={off} onClick={() => void d.decideProposal(proposal, "approved")}>Approve</Button>
        <Button variant="danger" disabledReason={off} onClick={() => void d.decideProposal(proposal, "denied")}>Deny</Button>
      </>
    );
  }
  const target = item.kind === "message" ? "inbox" : "board";
  return <Button onClick={() => onNavigate(target, item.project || undefined)}>{item.kind === "message" ? "Open" : "Review"}</Button>;
}

const VISIBLE_ROWS = 12;

export function NeedsYou({ items, backlog, d, onNavigate }: { items: QueueItem[]; backlog: OldTesting; d: Decisions; onNavigate: Navigate }) {
  const [all, setAll] = useState(false);
  // #13984 drill: 311 rows buried the three that mattered; cap the list and let the rest be asked for.
  const shown = all ? items : items.slice(0, VISIBLE_ROWS);
  return (
    <section aria-labelledby="v2-needs" className="rounded-xl border border-[var(--v2-warn-edge)] bg-[var(--v2-panel)]">
      <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-[14px] py-[10px]">
        <AlertTriangle size={15} aria-hidden className="text-[var(--v2-warn)]" />
        <h2 id="v2-needs" className="m-0 text-[13px] font-semibold">Needs you <span className="v2-mono text-[var(--v2-warn)]">{items.length}</span></h2>
      </div>
      {d.error && <p role="alert" className="m-0 px-[14px] pt-2 text-[12px] text-[var(--v2-bad)]">{d.error}</p>}
      {items.length === 0 && backlog.count === 0 && <p className="m-0 px-[14px] py-4 text-[12.5px] text-[var(--v2-muted)]">Nothing is waiting on you.</p>}
      {shown.map(item => {
        const Icon = KIND_ICON[item.kind];
        return (
          <div key={item.key} data-kind={item.kind} className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-[14px] py-2.5 last:border-b-0">
            <span title={KIND_LABEL[item.kind]} className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--v2-warn-soft)] text-[var(--v2-warn)]">
              <Icon size={14} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-[var(--v2-text)]">{item.title}</div>
              <ItemMeta item={item} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5"><Actions item={item} d={d} onNavigate={onNavigate} /></div>
          </div>
        );
      })}
      {items.length > shown.length && (
        <div className="px-[14px] py-2.5"><Button variant="quiet" onClick={() => setAll(true)}>Show {items.length - shown.length} more</Button></div>
      )}
      {backlog.count > 0 && (
        <div data-kind="backlog" className="flex items-center gap-3 border-t border-[var(--v2-edge)] px-[14px] py-2.5">
          <div className="min-w-0 flex-1 truncate text-[13px] text-[var(--v2-muted)]">{backlog.count} {backlog.count === 1 ? "card has" : "cards have"} sat in testing over a week</div>
          <Button onClick={() => onNavigate("board", backlog.project || undefined)}>Open the Board</Button>
        </div>
      )}
    </section>
  );
}
