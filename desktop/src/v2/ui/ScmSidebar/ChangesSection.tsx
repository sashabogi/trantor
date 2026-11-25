// The Changes section of the source control sidebar (#14044): the commit box, then EVERY changed
// file in one flat list, staged and unstaged together, each row its letter, counts and
// stage/unstage. Every mutation reuses the Code screen's scoped git bridge; discard confirms and
// copies to the Trash before restoring or removing anything.
import { useState } from "react";
import { Minus, Plus, Undo2 } from "lucide-react";
import { isUnmerged, lineCountFor, stageableChanges, type GitStatusEntry } from "../../../features/code/gitApi";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { CommitBox } from "../../screens/Code/ChangesList";
import { fileChipLabel, type Letter } from "../../screens/Code/model";
import { Counts, PathLabel, StatusLetter } from "../../screens/Code/parts";
import { checkoutMutationRefusal, scopeStage } from "../../screens/Code/scopeGitApi";
import { DiscardConfirmation, useDiscard } from "../../screens/Code/DiscardControls";
import { useShellMode } from "../../shell/shellMode";
import type { ScopeSnapshot } from "../../screens/Code/useScopeGit";

const CONFLICT_REASON = "Staging would erase git's conflict record. Resolve it first.";

export type FlatChange = {
  path: string;
  letter: Letter | "U";
  conflict: boolean;
  /** something sits in the index for this path (conflicts are never staged) */
  staged: boolean;
  /** worktree changes remain beyond the index, or the file is untracked */
  unstaged: boolean;
};

/** One row per changed path, with the letter the diff chips use and the row action's direction. */
export function flatChanges(status: GitStatusEntry[]): FlatChange[] {
  return status.map(e => ({
    path: e.path,
    letter: e.x === "?" ? "U" : fileChipLabel(e.y.trim() ? e.y : e.x),
    conflict: isUnmerged(e),
    staged: e.x !== " " && e.x !== "?" && !isUnmerged(e),
    unstaged: e.x === "?" || e.y.trim() !== "",
  }));
}

function ChangeRow({ change, snap, selected, onOpen, onStage, onConflict, onDiscard, discardReason }: {
  change: FlatChange; snap: ScopeSnapshot; selected: boolean; onOpen: (path: string) => void;
  onStage: (path: string, unstage: boolean) => void; onConflict: (path: string) => void;
  onDiscard: (path: string) => void; discardReason: string | null;
}) {
  const n = lineCountFor(snap.counts, change.path);
  const fullyStaged = change.staged && !change.unstaged;
  const verb = fullyStaged ? "Unstage" : "Stage";
  return (
    <div data-change={change.path} data-selected={selected || undefined}
      className={`group flex items-center gap-1.5 px-3 py-[3px] text-v2-body ${selected ? "bg-[var(--v2-accent-soft)]" : "hover:bg-[var(--v2-raised)]"}`}>
      <button type="button" onClick={() => onOpen(change.path)} title={`Show the diff for ${change.path}`}
        className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left">
        <StatusLetter letter={change.letter} /><PathLabel path={change.path} />
      </button>
      {n && <Counts plus={n.plus} minus={n.minus} />}
      {change.conflict && (
        <button type="button" onClick={() => onConflict(change.path)} title="Resolve this conflict"
          className="rounded bg-[var(--v2-bad-soft)] px-1.5 text-v2-micro text-[var(--v2-bad)]">conflict</button>
      )}
      <span className="flex shrink-0 gap-0.5">
        <IconButton label={`Discard ${change.path}`} title={discardReason ?? "Copy to Trash, then discard"} size={22} disabled={!!discardReason}
          onClick={() => onDiscard(change.path)}>
          <Undo2 size={12} aria-hidden />
        </IconButton>
        <IconButton label={`${verb} ${change.path}`} title={change.conflict ? CONFLICT_REASON : verb} size={22}
          disabled={change.conflict} onClick={() => onStage(change.path, fullyStaged)}>
          {fullyStaged ? <Minus size={12} aria-hidden /> : <Plus size={12} aria-hidden />}
        </IconButton>
      </span>
    </div>
  );
}

export type ChangesSectionProps = {
  project: string;
  snap: ScopeSnapshot;
  /** the change whose diff the host is showing, if any */
  selected: string | null;
  onOpen: (path: string) => void;
  onMutated: () => void;
  onOpenConflict?: (path: string) => void;
};

export function ChangesSection({ project, snap, selected, onOpen, onMutated, onOpenConflict }: ChangesSectionProps) {
  const [error, setError] = useState<string | null>(null);
  const mode = useShellMode();
  const discard = useDiscard(project, snap.scope, onMutated);
  const refusal = checkoutMutationRefusal(snap.scope, mode);
  const rows = flatChanges(snap.status);
  const staged = rows.filter(r => r.staged).length;
  const stageAll = stageableChanges(snap.status);
  const allReason = refusal ?? (rows.some(r => r.conflict) ? "Resolve conflicts before discarding all changes" : null);
  const confirmation = (path: string | null) => discard.target?.path === path
    ? <DiscardConfirmation target={discard.target} busy={discard.busy} onConfirm={discard.confirm} onCancel={() => discard.setTarget(null)} /> : null;
  const stage = (paths: string[], unstage: boolean) => {
    if (paths.length === 0) return;
    scopeStage(project, snap.scope, paths, unstage)
      .then(() => { setError(null); onMutated(); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="flex flex-col">
      <CommitBox project={project} snap={snap} staged={staged} onDone={onMutated} onError={setError} />
      {(error ?? discard.error) && <div role="alert" className="px-3 py-1.5 text-v2-body text-[var(--v2-bad)]">{error ?? discard.error}</div>}
      {rows.length === 0 && <div className="px-3 py-1.5 text-v2-body text-[var(--v2-muted)]">No uncommitted changes.</div>}
      {confirmation(null)}
      {rows.map(r => <div key={r.path}>
        <ChangeRow change={r} snap={snap} selected={selected === r.path}
          onOpen={onOpen} onStage={(path, unstage) => stage([path], unstage)} onConflict={p => onOpenConflict?.(p)}
          onDiscard={path => discard.setTarget({ path })} discardReason={refusal ?? (r.conflict ? "Resolve this conflict before discarding" : null)} />
        {confirmation(r.path)}
      </div>)}
      {rows.length > 0 && (
        <div className="px-3 pb-1.5 pt-1">
          <div className="flex gap-2">
            <Button variant="quiet" icon={<Plus size={12} aria-hidden />} disabledReason={stageAll.length === 0 ? "Nothing left to stage (conflicted files stay out)" : null}
              onClick={() => stage(stageAll, false)} title="Stage every non-conflicted change in one batch">Stage all</Button>
            <Button variant="quiet" icon={<Undo2 size={12} aria-hidden />} disabledReason={allReason}
              onClick={() => discard.setTarget({ path: null })} title="Copy every change to Trash, then discard all">Discard all</Button>
          </div>
        </div>
      )}
    </div>
  );
}
