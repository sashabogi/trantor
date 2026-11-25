// "Needs you": the ranked queue across projects, each row with its own actions (#13986).
import { useId, useState } from "react";
import { AlertTriangle, FileWarning, GitPullRequest, MessageCircleQuestion, ShieldQuestion, type LucideIcon } from "lucide-react";
import type { Navigate } from "../../routes";
import { Button } from "../../ui/Button";
import { ProjectTile } from "../../ui/ProjectTile";
import type { Decisions } from "./useDecisions";
import { seatLabel } from "../../ui/identity";
import { span, type QueueItem, type QueueKind } from "./model";

const KIND_ICON = { hold: FileWarning, proposal: ShieldQuestion, message: MessageCircleQuestion, testing: GitPullRequest } as const satisfies Record<QueueKind, LucideIcon>;
const KIND_LABEL = { hold: "Collision gate", proposal: "Proposal", message: "Question", testing: "Drill" } as const satisfies Record<QueueKind, string>;

export function ItemMeta({ item }: { item: QueueItem }) {
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-v2-body text-[var(--v2-muted)]">
      <ProjectTile name={item.project || "?"} size={16} />
      <span className="truncate">
        {item.project || "no project"}
        {item.card ? ` · #${item.card.id}` : ""}{item.seat ? ` · ${seatLabel(item.seat)}` : ""} · {span(item.ts)}
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
        <Button variant="primary" disabledReason={off} onClick={() => void d.decideHold(hold, "go")}>{seatLabel(hold.session)} first</Button>
        <Button disabledReason={off} onClick={() => void d.decideHold(hold, "nogo")}>{seatLabel(hold.other)} first</Button>
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

function QueueRow({ item, d, onNavigate }: { item: QueueItem; d: Decisions; onNavigate: Navigate }) {
  const Icon = KIND_ICON[item.kind];
  return (
    <div data-kind={item.kind} className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-[14px] py-2.5 last:border-b-0">
      <span title={KIND_LABEL[item.kind]} className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--v2-warn-soft)] text-[var(--v2-warn)]">
        <Icon size={14} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-v2-base text-[var(--v2-text)]">{item.title}</div>
        <ItemMeta item={item} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5"><Actions item={item} d={d} onNavigate={onNavigate} /></div>
    </div>
  );
}

const VISIBLE_ROWS = 12;

export function NeedsYou({ items, d, onNavigate }: { items: QueueItem[]; d: Decisions; onNavigate: Navigate }) {
  const [all, setAll] = useState(false);
  const heading = useId();
  const actionable = items.filter(i => i.kind !== "testing");
  const drills = items.filter(i => i.kind === "testing");
  const drillCount = drills.reduce((n, i) => n + (i.testingCount ?? 1), 0);
  const shownActionable = all ? actionable : actionable.slice(0, VISIBLE_ROWS);
  const shownDrills = all ? drills : drills.slice(0, VISIBLE_ROWS);
  const hidden = items.length - shownActionable.length - shownDrills.length;
  return (
    <section aria-labelledby={heading} className="rounded-xl border border-[var(--v2-warn-edge)] bg-[var(--v2-panel)]">
      <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-[14px] py-[10px]">
        <AlertTriangle size={15} aria-hidden className="text-[var(--v2-warn)]" />
        <h2 id={heading} className="m-0 text-v2-base font-semibold">Needs you <span className="v2-mono text-[var(--v2-warn)]">{actionable.length}</span></h2>
      </div>
      {d.error && <p role="alert" className="m-0 px-[14px] pt-2 text-v2-body text-[var(--v2-bad)]">{d.error}</p>}
      {actionable.length === 0 && <p className="m-0 px-[14px] py-4 text-v2-base text-[var(--v2-muted)]">Nothing needs an answer.</p>}
      {shownActionable.map(item => <QueueRow key={item.key} item={item} d={d} onNavigate={onNavigate} />)}
      {drills.length > 0 && (
        <div className="border-y border-[var(--v2-edge)] px-[14px] pb-1 pt-2">
          <h3 className="m-0 text-v2-small font-semibold uppercase tracking-[0.08em] text-[var(--v2-muted)]">Waiting for a drill <span className="v2-mono">{drillCount}</span></h3>
        </div>
      )}
      {shownDrills.map(item => <QueueRow key={item.key} item={item} d={d} onNavigate={onNavigate} />)}
      {hidden > 0 && (
        <div className="px-[14px] py-2.5"><Button variant="quiet" onClick={() => setAll(true)}>Show {hidden} more</Button></div>
      )}
    </section>
  );
}
