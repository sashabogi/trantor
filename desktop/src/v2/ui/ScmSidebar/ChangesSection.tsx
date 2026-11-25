// The Changes section of the source control sidebar (#14044): the commit box, then EVERY changed
// file in one flat list, staged and unstaged together, each row its letter, counts and
// stage/unstage. Staging and committing reuse the Code screen's scope git bridge; no push, no
// discard, on either checkout (#13988 rules).
import { useState } from "react";
import { Minus, Plus, Undo2 } from "lucide-react";
import { isUnmerged, lineCountFor, stageableChanges, type GitStatusEntry } from "../../../features/code/gitApi";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { CommitBox } from "../../screens/Code/ChangesList";
import { fileChipLabel, type Letter } from "../../screens/Code/model";
import { Counts, PathLabel, StatusLetter } from "../../screens/Code/parts";
import { CHECKOUT_REFUSAL, scopeStage } from "../../screens/Code/scopeGitApi";
import type { ScopeSnapshot } from "../../screens/Code/useScopeGit";

const NO_DISCARD = "Discard needs a git restore command that copies to Trash first. Not wired yet.";
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

function ChangeRow({ change, snap, selected, onOpen, onStage, onConflict }: {
  change: FlatChange; snap: ScopeSnapshot; selected: boolean; onOpen: (path: string) => void;
  onStage: (path: string, unstage: boolean) => void; onConflict: (path: string) => void;
}) {
  const n = lineCountFor(snap.counts, change.path);
  const fullyStaged = change.staged && !change.unstaged;
  const verb = fullyStaged ? "Unstage" : "Stage";
  return (
    <div data-change={change.path} data-selected={selected || undefined}
      className={`group flex items-center gap-1.5 px-3 py-[3px] text-[12px] ${selected ? "bg-[var(--v2-accent-soft)]" : "hover:bg-[var(--v2-raised)]"}`}>
      <button type="button" onClick={() => onOpen(change.path)} title={`Show the diff for ${change.path}`}
        className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left">
        <StatusLetter letter={change.letter} /><PathLabel path={change.path} />
      </button>
      {n && <Counts plus={n.plus} minus={n.minus} />}
      {change.conflict && (
        <button type="button" onClick={() => onConflict(change.path)} title="Resolve this conflict"
          className="rounded bg-[var(--v2-bad-soft)] px-1.5 text-[10px] text-[var(--v2-bad)]">conflict</button>
      )}
      <span className="flex shrink-0 gap-0.5">
        <IconButton label={`Discard ${change.path}`} title={snap.seatBacked ? NO_DISCARD : CHECKOUT_REFUSAL} size={22} disabled>
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
  const rows = flatChanges(snap.status);
  const staged = rows.filter(r => r.staged).length;
  const stageAll = stageableChanges(snap.status);
  const stage = (paths: string[], unstage: boolean) => {
    if (paths.length === 0) return;
    scopeStage(project, snap.scope, paths, unstage)
      .then(() => { setError(null); onMutated(); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="flex flex-col">
      <CommitBox project={project} snap={snap} staged={staged} onDone={onMutated} onError={setError} />
      {error && <div role="alert" className="px-3 py-1.5 text-[11.5px] text-[var(--v2-bad)]">{error}</div>}
      {rows.length === 0 && <div className="px-3 py-1.5 text-[11.5px] text-[var(--v2-muted)]">No uncommitted changes.</div>}
      {rows.map(r => (
        <ChangeRow key={r.path} change={r} snap={snap} selected={selected === r.path}
          onOpen={onOpen} onStage={(path, unstage) => stage([path], unstage)} onConflict={p => onOpenConflict?.(p)} />
      ))}
      {rows.length > 0 && (
        <div className="px-3 pb-1.5 pt-1">
          <Button variant="quiet" icon={<Plus size={12} aria-hidden />} disabledReason={stageAll.length === 0 ? "Nothing left to stage (conflicted files stay out)" : null}
            onClick={() => stage(stageAll, false)} title={`Stage every non-conflicted change in one batch`}>
            Stage all
          </Button>
        </div>
      )}
    </div>
  );
}
