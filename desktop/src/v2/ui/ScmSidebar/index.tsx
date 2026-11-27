// The source control sidebar (#14044): the one column the Workspace's left side and Code's sidebar share.
// #14344: one header row, a Changes / Files switch, one scroller, what needs the operator first, history folded.
// Every git mutation reuses the Code screen's scoped bridge.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LockKeyhole, RefreshCw } from "lucide-react";
import { Avatar } from "../Avatar";
import { Button } from "../Button";
import { publishReview, type ReviewMessage } from "./reviewScope";
import { ago } from "../../../shared/time";
import { ExplorerTree } from "../ExplorerTree";
import { IconButton } from "../IconButton";
import { NoteCard } from "../NoteCard";
import { Seg } from "../Seg";
import { isUnmerged } from "../../../features/code/gitApi";
import type { SeatInfo } from "../../screens/Code/model";
import { useScopeGit, type ScopeSnapshot, type ScopeState } from "../../screens/Code/useScopeGit";
import { isWorktreeScope, scopeFetch } from "../../screens/Code/scopeGitApi";
import { scopeWorktreeLabel, useAgentWorktrees, worktreeLabel, worktreeLive, worktreeScope, type AgentWorktree } from "../../screens/Code/useAgentWorktrees";
import { AgentsSection } from "./AgentsSection";
import { BranchesSection } from "./BranchesSection";
import { ChangesSection } from "./ChangesSection";
import { CollapsibleSection } from "./CollapsibleSection";
import { CommitsSection } from "./CommitsSection";
import { StashesSection } from "./StashesSection";
import { readScmView, writeScmView, type ScmView } from "./sectionState";

export type ScmSidebarProps = {
  onReviewMessage?: (message: ReviewMessage) => void;
  canAskOrchestrator?: boolean;
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
  /** true when the host follows onPickScope to a worktree scope itself (Code); else the sidebar reads it alone */
  hostPicksWorktree?: boolean;
  /** #14265: told the scope the sidebar is showing, including an agent worktree it reads alone, so opens can name it */
  onShownScope?: (scope: string | null) => void;
  /** header-row extras: the column's collapse button, the open-full-tab button */
  actions?: ReactNode;
};

/** What a git-dependent section shows while the panel has no snapshot. */
function Pending({ state }: { state: ScopeState }) {
  const line = state.kind === "error" ? state.reason : "Reading git";
  return <div className="px-3 py-1.5 text-v2-body text-[var(--v2-muted)]">{line}</div>;
}

const fetchTimes = new Map<string, number>();

function useFetch(project: string, scope: string | null, onMutated: () => void) {
  const key = `${project}:${scope ?? "project"}`;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ key: string; reason: string } | null>(null);
  const [, setFetchedAt] = useState<number>();
  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await scopeFetch(project, scope);
      const at = Date.now();
      fetchTimes.set(key, at);
      setFetchedAt(at);
      onMutated();
    } catch (e) {
      setFailure({ key, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, run, error: failure?.key === key ? failure.reason : null, fetchedAt: fetchTimes.get(key) };
}

type ViewProps = ScmSidebarProps & { worktrees: AgentWorktree[] };

/** #14300: an agent worktree picked where the host does not scope by it (the Workspace) is read by the sidebar alone. */
function WorktreeScoped(p: ViewProps & { own: string }) {
  const { state, refresh } = useScopeGit(p.project, p.own);
  return <ScmSidebarView {...p} scope={p.own} state={state} onMutated={() => { refresh(); p.onMutated(); }}
    scopeName={scopeWorktreeLabel(p.own, p.worktrees)} />;
}

export function ScmSidebar(p: ScmSidebarProps) {
  const worktrees = useAgentWorktrees(p.project);
  const [own, setOwn] = useState<string | null>(null);
  // The host's own scope changing (a seat picked in its strip) hands the sidebar back to it.
  useEffect(() => { setOwn(null); }, [p.scope, p.project]);
  const pick = p.onPickScope;
  const hostPicks = p.hostPicksWorktree;
  const onPickScope = useCallback((scope: string | null) => {
    setOwn(scope !== null && isWorktreeScope(scope) && !hostPicks ? scope : null);
    pick(scope);
  }, [pick, hostPicks]);
  const shown = own ?? p.scope;
  const report = p.onShownScope;
  useEffect(() => { report?.(shown); }, [report, shown]);
  const view = { ...p, worktrees, onPickScope };
  if (own) return <WorktreeScoped {...view} own={own} />;
  const scopeName = p.scope && isWorktreeScope(p.scope) ? scopeWorktreeLabel(p.scope, worktrees) : p.scopeName;
  return <ScmSidebarView {...view} scopeName={scopeName} />;
}

const VIEWS = [{ value: "changes", label: "Changes" }, { value: "files", label: "Files" }] as const satisfies readonly { value: ScmView; label: string }[];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What needs the operator: files in conflict, and agents whose finished work waits in a worktree. */
function NeedsYou({ snap, worktrees, scope, onOpenConflict, onPickScope }: {
  snap: ScopeSnapshot | null; worktrees: AgentWorktree[]; scope: string | null;
  onOpenConflict?: (path: string) => void; onPickScope: (scope: string) => void;
}) {
  const conflicts = snap ? snap.status.filter(isUnmerged) : [];
  const ready = worktrees.filter(w => !worktreeLive(w) && w.changed > 0 && worktreeScope(w) !== scope).slice(0, 2);
  if (conflicts.length === 0 && ready.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-1 pt-1">
      {conflicts.length > 0 && (
        <NoteCard note="conflicts" action={onOpenConflict ? { label: "Resolve", title: "Open the merge view", onClick: () => onOpenConflict(conflicts[0].path) } : undefined}>
          {plural(conflicts.length, "file is", "files are")} in conflict
        </NoteCard>
      )}
      {ready.map(w => (
        <NoteCard key={w.path} note="ready" action={{ label: "Review", title: "Read this worktree", onClick: () => onPickScope(worktreeScope(w)) }}>
          {worktreeLabel(w)} has {plural(w.changed, "file", "files")} ready in its worktree
        </NoteCard>
      ))}
    </div>
  );
}

const arrows = (snap: ScopeSnapshot) => [snap.ahead ? `↑${snap.ahead}` : "", snap.behind ? `↓${snap.behind}` : ""].filter(Boolean).join(" ");

function ScmSidebarView(p: ViewProps) {
  const snap = p.state.kind === "ok" ? p.state.snap : null;
  const { state: checkout } = useScopeGit(p.project, null);
  const branch = checkout.kind === "ok" ? checkout.snap.branch || "detached" : null;
  const reviewing = p.scope !== null;
  const pick = p.onPickScope;
  const back = useCallback(() => pick(null), [pick]);
  useEffect(() => publishReview(p.project, reviewing ? { name: p.scopeName, back } : null), [p.project, reviewing, p.scopeName, back]);
  const worktree = p.worktrees.find(w => worktreeScope(w) === p.scope);
  const folder = worktree?.path ?? p.scope ?? "";
  const files = snap?.status.length ?? worktree?.changed;
  const fetch = useFetch(p.project, p.scope, p.onMutated);
  const [view, setViewState] = useState<ScmView>(readScmView);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const setView = (next: ScmView) => { setViewState(next); writeScmView(next); };
  const upstreamTitle = snap?.upstream ? `upstream ${snap.upstream}` : "no upstream: ahead counts unlanded work against main";
  const aheadTitle = `${upstreamTitle}${fetch.fetchedAt ? ` · fetched ${ago(fetch.fetchedAt)}` : ""}`;
  const away = snap ? arrows(snap) : "";
  const tone = !snap ? "faint" : snap.behind ? "warn" : snap.ahead ? "accent" : "ok";
  const dotColor = { faint: "var(--v2-faint)", warn: "var(--v2-warn)", accent: "var(--v2-accent)", ok: "var(--v2-ok)" }[tone];
  const dotTitle = away ? aheadTitle : snap?.upstream ? `in sync with ${snap.upstream}` : "all landed";
  return (
    <div data-testid="scm-sidebar" tabIndex={-1} onKeyDown={e => {
      if (reviewing && e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); back(); }
    }} className="flex min-h-0 flex-1 flex-col">
      {reviewing && <div data-review-band title={folder.split("/").pop()} className="flex shrink-0 flex-col gap-2 border-b border-[var(--v2-accent-edge)] bg-[var(--v2-info-soft)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Avatar name={p.scopeName} size={22} />
          <div className="min-w-0 flex-1">
            <div className="text-v2-body font-semibold">Reviewing {p.scopeName}'s work</div>
            <div className="v2-mono text-v2-small text-[var(--v2-accent-hi)]">its own worktree · {files === undefined ? "reading files" : plural(files, "file", "files")} · read only</div>
          </div>
          <LockKeyhole size={14} aria-hidden className="shrink-0 text-[var(--v2-accent-hi)]" />
        </div>
        <Button onClick={back} className="w-full justify-center whitespace-normal">Back to my checkout{branch ? ` (${branch})` : ""}<kbd className="v2-mono text-v2-small text-[var(--v2-muted)]">Esc</kbd></Button>
      </div>}

      <header className="flex shrink-0 flex-col px-3 pt-1">
        <div className="flex h-8 items-center gap-2">
          <span data-state-dot data-tone={tone} role="img" aria-label={dotTitle} title={dotTitle} className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: dotColor }} />
          <span hidden={reviewing} className="v2-mono min-w-0 truncate text-v2-body text-[var(--v2-text)]" title={snap?.branch ?? "reading…"}>{snap?.branch ?? "reading…"}</span>
          {away && <span data-ahead className="v2-mono shrink-0 text-v2-body text-[var(--v2-accent)]" title={aheadTitle}>{away}</span>}
          <span className="flex-1" />
          <IconButton label="Fetch from origin" title="Fetch origin with prune" size={24} disabled={fetch.busy} onClick={() => { void fetch.run(); }}>
            <RefreshCw size={13} aria-hidden className={fetch.busy ? "animate-spin" : undefined} />
          </IconButton>
          {p.actions && <span className="flex shrink-0 items-center gap-1">{p.actions}</span>}
        </div>

      </header>
      {fetch.error && (
        <div role="alert" className="px-3 py-2 text-v2-body text-[var(--v2-bad)]">{fetch.error}</div>
      )}
      {p.state.kind === "error" && (
        <div role="alert" className="px-3 py-2 text-v2-body text-[var(--v2-bad)]">{p.state.reason}</div>
      )}
      <div className="shrink-0 px-3 pb-2">
        <Seg fill label="Source control view" options={VIEWS} value={view} onChange={setView} />
      </div>
      {view === "files" && <div ref={setToolbarSlot} data-files-toolbar className="shrink-0" />}
      {/* #14344: one scroller for the whole column; groups open and close in it, none scrolls inside itself. */}
      <div data-scm-scroller className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {view === "files"
          ? toolbarSlot && <ExplorerTree project={p.project} seat={p.scope} onOpen={p.onOpenFile} openPath={p.selectedPath ?? null} toolbarSlot={toolbarSlot} />
          : <ChangesView {...p} snap={snap} />}
      </div>
    </div>
  );
}

function ChangesView(p: ViewProps & { snap: ScopeSnapshot | null }) {
  const { snap } = p;
  const files = snap?.status.length ?? p.worktrees.find(w => worktreeScope(w) === p.scope)?.changed;
  return (
    <>
      <NeedsYou snap={snap} worktrees={p.worktrees} scope={p.scope} onOpenConflict={p.onOpenConflict} onPickScope={p.onPickScope} />
      {snap
        ? <ChangesSection project={p.project} snap={snap} selected={p.selectedPath ?? null} onOpen={p.onOpenChange}
          onMutated={p.onMutated} onOpenConflict={p.onOpenConflict} />
        : <Pending state={p.state} />}
      {p.scope !== null && <div className="flex flex-wrap gap-1.5 px-3 py-2">
        <Button disabledReason="Merging a worktree into main is not available in this sidebar">Merge into main</Button>
        <Button disabledReason={!p.onReviewMessage ? "Open the Workspace to message this agent" : isWorktreeScope(p.scope) && !p.canAskOrchestrator ? "Sub-agents don't take messages; start the orchestrator to ask about this work." : files === undefined ? "Reading the worktree files" : null}
          onClick={() => { if (p.scope && files !== undefined) p.onReviewMessage?.({ scope: p.scope, name: p.scopeName, files }); }}>
          {isWorktreeScope(p.scope) ? "Ask the orchestrator" : `Message ${p.scopeName}`}
        </Button>
      </div>}
      {p.worktrees.length > 0 && (
        <CollapsibleSection section="agents" title="Agents working" count={p.worktrees.length}>
          <AgentsSection project={p.project} worktrees={p.worktrees} scope={p.scope} onPickScope={p.onPickScope} />
        </CollapsibleSection>
      )}
      {snap && (
        <>
          <CollapsibleSection section="commits" title="Recent commits" count={snap.log.length} defaultOpen={false}>
            <CommitsSection key={p.scope ?? "project"} log={snap.log} onOpen={p.onOpenCommit} />
          </CollapsibleSection>
          <CollapsibleSection section="stashes" title="Stashes" defaultOpen={false}>
            <StashesSection project={p.project} scope={p.scope} onMutated={p.onMutated} />
          </CollapsibleSection>
          <CollapsibleSection section="branches" title="Branches and seats" count={1 + p.seats.length} defaultOpen={false}>
            <BranchesSection project={p.project} scope={p.scope} seats={p.seats} onPickScope={p.onPickScope} />
          </CollapsibleSection>
        </>
      )}
    </>
  );
}
