// The source control sidebar (#14044): the one column the Workspace's left side and Code's sidebar
// share: Changes (flat list with the commit box), Files, Recent commits, every section collapsible
// and remembered in localStorage. Stage and commit reuse the Code screen's git bridge, so the
// main-checkout rules travel with them: no push, no discard. #14047: ahead/behind + seats rows.
import type { ReactNode } from "react";
import { ExplorerTree } from "../ExplorerTree";
import { aheadLabel } from "../../../features/code/gitApi";
import { MainCheckoutMark } from "../../screens/Code/parts";
import type { SeatInfo } from "../../screens/Code/model";
import type { ScopeState } from "../../screens/Code/useScopeGit";
import { BranchesSection } from "./BranchesSection";
import { ChangesSection } from "./ChangesSection";
import { CollapsibleSection } from "./CollapsibleSection";
import { CommitsSection } from "./CommitsSection";

export type ScmSidebarProps = {
  project: string;
  /** the seat whose worktree this reads, or null for the project checkout */
  scope: string | null;
  scopeName: string;
  state: ScopeState;
  /** the project's seats, as screens/Code/useSeats reads them */
  seats: SeatInfo[];
  /** a Branches and seats row click: null is the main checkout */
  onPickScope: (seat: string | null) => void;
  onMutated: () => void;
  onOpenFile: (path: string) => void;
  onOpenChange: (path: string) => void;
  onOpenCommit: (sha: string) => void;
  onOpenConflict?: (path: string) => void;
  /** the change whose diff the host is showing, if any */
  selectedPath?: string | null;
  /** header-row extras: the column's collapse button, the open-full-tab button */
  actions?: ReactNode;
};

function CountBadge({ n }: { n: number }) {
  return <span data-count className="v2-mono rounded-full bg-[var(--v2-track)] px-1.5 text-[10px] text-[var(--v2-text-2)]">{n}</span>;
}

/** What a git-dependent section shows while the panel has no snapshot. */
function Pending({ state }: { state: ScopeState }) {
  const line = state.kind === "error" ? state.reason : "Reading git";
  return <div className="px-3 py-1.5 text-[11.5px] text-[var(--v2-muted)]">{line}</div>;
}

export function ScmSidebar(p: ScmSidebarProps) {
  const snap = p.state.kind === "ok" ? p.state.snap : null;
  return (
    <div data-testid="scm-sidebar" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-1 border-b border-[var(--v2-edge)] px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-1">
          <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--v2-muted)]">Source control</span>
          {p.actions && <span className="flex shrink-0 items-center gap-1">{p.actions}</span>}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
          <span className="v2-mono min-w-0 shrink-0 truncate text-[var(--v2-text)]" title={snap?.branch ?? "reading…"}>{snap?.branch ?? "reading…"}</span>
          {snap && !snap.seatBacked && <MainCheckoutMark />}
          {snap && (
            <span data-ahead className="v2-mono shrink-0 text-[10.5px] text-[var(--v2-muted)]"
              title={snap.upstream ? `upstream ${snap.upstream}` : "no upstream: ahead counts unlanded work against main"}>
              {aheadLabel(snap)}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-right text-[var(--v2-muted)]" title={p.scopeName}>{p.scopeName}</span>
        </div>
      </header>
      {p.state.kind === "error" && (
        <div role="alert" className="border-b border-[var(--v2-edge)] px-3 py-2 text-[11.5px] text-[var(--v2-bad)]">{p.state.reason}</div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CollapsibleSection section="changes" title="Changes" badge={snap ? <CountBadge n={snap.status.length} /> : undefined}>
          {snap
            ? <ChangesSection project={p.project} snap={snap} selected={p.selectedPath ?? null} onOpen={p.onOpenChange}
              onMutated={p.onMutated} onOpenConflict={p.onOpenConflict} />
            : <Pending state={p.state} />}
        </CollapsibleSection>
        <CollapsibleSection section="files" title="Files">
          <ExplorerTree project={p.project} seat={p.scope} onOpen={p.onOpenFile} />
        </CollapsibleSection>
        <CollapsibleSection section="commits" title="Recent commits" badge={snap ? <CountBadge n={snap.log.length} /> : undefined}>
          {snap ? <CommitsSection log={snap.log} onOpen={p.onOpenCommit} /> : <Pending state={p.state} />}
        </CollapsibleSection>
        <CollapsibleSection section="branches" title="Branches and seats" badge={<CountBadge n={1 + p.seats.length} />}>
          <BranchesSection project={p.project} scope={p.scope} seats={p.seats} onPickScope={p.onPickScope} />
        </CollapsibleSection>
      </div>
    </div>
  );
}
