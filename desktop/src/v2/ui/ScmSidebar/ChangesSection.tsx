// The Changes view of the source control sidebar (#14044): the commit area, then the Staged and Changes
// groups, each row its name, folder, counts and letter with stage/unstage and discard in a column that only
// shows on hover. Every mutation reuses the Code screen's scoped git bridge; discard confirms and copies
// to the Trash before restoring or removing anything. #14344: groups instead of one flat list.
import { useState } from "react";
import { Minus, MoreHorizontal, Plus, Undo2 } from "lucide-react";
import { isUnmerged, lineCountFor, stageableChanges, type GitStatusEntry } from "../../../features/code/gitApi";
import { IconButton } from "../IconButton";
import { ListRow } from "../ListRow";
import { Popover } from "../../shell/Popover";
import { CommitBox } from "../../screens/Code/ChangesList";
import { fileChipLabel, type Letter } from "../../screens/Code/model";
import { Counts, StatusLetter } from "../../screens/Code/parts";
import { checkoutMutationRefusal, scopeStage } from "../../screens/Code/scopeGitApi";
import { DiscardConfirmation, useDiscard } from "../../screens/Code/DiscardControls";
import { useShellMode } from "../../shell/shellMode";
import type { ScopeSnapshot } from "../../screens/Code/useScopeGit";
import { CollapsibleSection } from "./CollapsibleSection";

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

export type ChangeGroups = { staged: FlatChange[]; changes: FlatChange[] };

/** The Staged group (letters from the index side) and the Changes group (worktree side and untracked); a path edited after staging is in both. */
export function groupChanges(status: GitStatusEntry[]): ChangeGroups {
  const rows = flatChanges(status);
  return {
    staged: rows.filter(r => r.staged).map(r => {
      const entry = status.find(e => e.path === r.path);
      return { ...r, letter: fileChipLabel(entry?.x ?? "M") };
    }),
    changes: rows.filter(r => r.unstaged),
  };
}

type RowProps = {
  change: FlatChange; snap: ScopeSnapshot; selected: boolean; unstage: boolean;
  onOpen: (path: string) => void; onStage: (path: string, unstage: boolean) => void; onConflict: (path: string) => void;
  onDiscard: (path: string) => void; discardReason: string | null;
};

function ChangeRow({ change, snap, selected, unstage, onOpen, onStage, onConflict, onDiscard, discardReason }: RowProps) {
  const n = lineCountFor(snap.counts, change.path);
  const verb = unstage ? "Unstage" : "Stage";
  const cut = change.path.lastIndexOf("/");
  // #14268: Enter opens the diff, Space stages or unstages, Delete discards, like an IDE's changes list.
  const keys = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === " " && !change.conflict) { e.preventDefault(); onStage(change.path, unstage); }
    if (e.key === "Delete" && !discardReason) { e.preventDefault(); onDiscard(change.path); }
  };
  return (
    <ListRow selected={selected} shell={{ "data-change": change.path }}
      main={{ onClick: () => onOpen(change.path), title: `Show the diff for ${change.path}`, onKeyDown: keys }}
      name={cut < 0 ? change.path : change.path.slice(cut + 1)} meta={cut > 0 ? change.path.slice(0, cut) : undefined}
      trailing={n ? <Counts plus={n.plus} minus={n.minus} /> : undefined}
      actions={<>
        <IconButton label={`Discard ${change.path}`} title={discardReason ?? "Copy to Trash, then discard"} size={20} disabled={!!discardReason}
          onClick={() => onDiscard(change.path)}>
          <Undo2 size={12} aria-hidden />
        </IconButton>
        <IconButton label={`${verb} ${change.path}`} title={change.conflict ? CONFLICT_REASON : verb} size={20}
          disabled={change.conflict} onClick={() => onStage(change.path, unstage)}>
          {unstage ? <Minus size={12} aria-hidden /> : <Plus size={12} aria-hidden />}
        </IconButton>
      </>}
      end={<>
        {change.conflict && (
          <button type="button" onClick={() => onConflict(change.path)} title="Resolve this conflict"
            className="mr-1.5 rounded-sm border-0 bg-[var(--v2-bad-soft)] px-1.5 text-v2-micro text-[var(--v2-bad)]">conflict</button>
        )}
        <StatusLetter letter={change.letter} />
      </>} />
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
  const [moreOpen, setMoreOpen] = useState(false);
  const mode = useShellMode();
  const discard = useDiscard(project, snap.scope, onMutated);
  const refusal = checkoutMutationRefusal(snap.scope, mode);
  const groups = groupChanges(snap.status);
  const staged = groups.staged.length;
  const stageAll = stageableChanges(snap.status);
  const allReason = refusal ?? (snap.status.some(isUnmerged) ? "Resolve conflicts before discarding all changes" : null);
  const confirmation = (path: string | null) => discard.target?.path === path
    ? <DiscardConfirmation target={discard.target} busy={discard.busy} onConfirm={discard.confirm} onCancel={() => discard.setTarget(null)} /> : null;
  const stage = (paths: string[], unstage: boolean) => {
    if (paths.length === 0) return;
    scopeStage(project, snap.scope, paths, unstage)
      .then(() => { setError(null); onMutated(); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  };
  const rowsOf = (list: FlatChange[], unstage: boolean) => list.map(r => (
    <div key={`${unstage ? "s" : "u"}-${r.path}`}>
      <ChangeRow change={r} snap={snap} selected={selected === r.path} unstage={unstage}
        onOpen={onOpen} onStage={(path, un) => stage([path], un)} onConflict={p => onOpenConflict?.(p)}
        onDiscard={path => discard.setTarget({ path })} discardReason={refusal ?? (r.conflict ? "Resolve this conflict before discarding" : null)} />
      {confirmation(r.path)}
    </div>
  ));
  const discardMenu = (
    <span className="relative">
      <IconButton label="More actions for Changes" title="More actions" size={20} onClick={() => setMoreOpen(o => !o)}>
        <MoreHorizontal size={12} aria-hidden />
      </IconButton>
      <Popover open={moreOpen} onClose={() => setMoreOpen(false)} label="More actions for Changes" align="right">
        <button type="button" role="menuitem" disabled={!!allReason} title={allReason ?? "Copy every change to Trash, then discard all"}
          onClick={() => { setMoreOpen(false); discard.setTarget({ path: null }); }}
          className="v2-hover flex w-full items-center rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-v2-base text-[var(--v2-text-2)] disabled:opacity-45">Discard all</button>
      </Popover>
    </span>
  );
  return (
    <div className="flex flex-col">
      <CommitBox project={project} snap={snap} staged={staged} onDone={onMutated} onError={setError} />
      {(error ?? discard.error) && <div role="alert" className="px-3 py-1.5 text-v2-body text-[var(--v2-bad)]">{error ?? discard.error}</div>}
      {staged > 0 && (
        <CollapsibleSection section="staged" title="Staged" count={staged}
          actions={[{ label: "Unstage all", title: "Unstage every staged file", onClick: () => stage(groups.staged.map(r => r.path), true) }]}>
          {rowsOf(groups.staged, true)}
        </CollapsibleSection>
      )}
      {groups.changes.length > 0 && (
        <CollapsibleSection section="changes" title="Changes" count={groups.changes.length} menu={discardMenu}
          actions={[{ label: "Stage all", title: "Stage every non-conflicted change in one batch",
            disabledReason: stageAll.length === 0 ? "Nothing left to stage (conflicted files stay out)" : null, onClick: () => stage(stageAll, false) }]}>
          {confirmation(null)}
          {rowsOf(groups.changes, false)}
        </CollapsibleSection>
      )}
    </div>
  );
}
