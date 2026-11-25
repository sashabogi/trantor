// Staged and unstaged files with the commit box (#13988). Every mutation goes through the scoped
// git commands; discard asks for confirmation and copies the work to the Trash first.
import { useState, type ReactNode } from "react";
import { Minus, Plus, Undo2 } from "lucide-react";
import { bucketStatus, isUnmerged, lineCountFor, stageableChanges, type GitStatusEntry } from "../../../features/code/gitApi";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { IconButton } from "../../ui/IconButton";
import { Counts, MainCheckoutMark, PathLabel, SectionLabel, StatusLetter } from "./parts";
import { fileChipLabel, type Letter } from "./model";
import { checkoutMutationRefusal, historyMutationRefusal, scopeAmend, scopeCommit, scopePush, scopeStage, scopeUndo } from "./scopeGitApi";
import { DiscardConfirmation, useDiscard } from "./DiscardControls";
import { useShellMode } from "../../shell/shellMode";
import type { ScopeSnapshot } from "./useScopeGit";

export type ChangesListProps = {
  project: string;
  snap: ScopeSnapshot;
  selected: string | null;
  onSelect: (path: string) => void;
  onMutated: () => void;
  /** Offers the conflicted paths a way to open the merge view. */
  onOpenConflict?: (path: string) => void;
};

function FileRow({ entry, letter, snap, selected, onSelect, onToggle, action, conflict, onConflict }: {
  entry: Pick<GitStatusEntry, "path">; letter: Letter | "U"; snap: ScopeSnapshot; selected: boolean;
  onSelect: () => void; onToggle: () => void; action: ReactNode; conflict?: boolean; onConflict?: () => void;
}) {
  const n = lineCountFor(snap.counts, entry.path);
  return (
    <div data-selected={selected || undefined} className={`group flex items-center gap-1.5 px-3 py-[3px] text-v2-body ${selected ? "bg-[var(--v2-accent-soft)]" : "hover:bg-[var(--v2-raised)]"}`}>
      <button type="button" onClick={onSelect} title={`Show the diff for ${entry.path}`}
        onKeyDown={e => { if (e.key === " " && !conflict) { e.preventDefault(); onToggle(); } }} className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left">
        <StatusLetter letter={letter} /><PathLabel path={entry.path} />
      </button>
      {n && <Counts plus={n.plus} minus={n.minus} />}
      {conflict && <button type="button" onClick={onConflict} title="Resolve this conflict" className="rounded bg-[var(--v2-bad-soft)] px-1.5 text-v2-micro text-[var(--v2-bad)]">conflict</button>}
      <span className="flex shrink-0 gap-0.5">{action}</span>
    </div>
  );
}

export function CommitBox({ project, snap, staged, onDone, onError }: {
  project: string; snap: ScopeSnapshot; staged: number; onDone: () => void; onError: (m: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = snap.branch ?? "this checkout";
  const mode = useShellMode();
  const pushRefusal = checkoutMutationRefusal(snap.scope, mode);
  const pushed = !!snap.upstream && snap.ahead === 0;
  const noCommit = snap.log.length === 0;
  const historyReason = historyMutationRefusal(snap.scope, mode) ?? (noCommit ? "There is no commit to change" : pushed ? "The last commit is already pushed" : null);
  const reason = !amend && staged === 0 ? "Nothing is staged yet" : !message.trim() ? "Write a commit message first" : amend && historyReason ? historyReason : busy ? "Working" : null;
  const commit = (push = false) => {
    setBusy(true);
    void (amend ? scopeAmend(project, snap.scope, message) : scopeCommit(project, snap.scope, message))
      .then(() => push ? scopePush(project, snap.scope) : undefined)
      .then(() => { setMessage(""); setAmend(false); onDone(); })
      .catch(e => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const undo = () => {
    setBusy(true);
    void scopeUndo(project, snap.scope)
      .then(previous => { setMessage(previous); setAmend(false); onDone(); })
      .catch(e => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const toggleAmend = () => {
    setAmend(value => !value);
    setMessage(amend ? "" : (snap.log[0]?.subject ?? ""));
  };
  return (
    <div className="flex flex-col gap-1.5 border-b border-[var(--v2-edge)] px-3 py-2.5">
      <label htmlFor="v2-commit-msg" className="sr-only">Commit message</label>
      <input id="v2-commit-msg" value={message} onChange={e => setMessage(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !reason) commit(); }}
        placeholder={`Message (⌘⏎ to commit to ${target})`}
        className="w-full rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-1.5 text-v2-body text-[var(--v2-text)] outline-none focus:border-[var(--v2-accent)]" />
      <div className="flex items-center gap-2 text-v2-body text-[var(--v2-text-2)]">
        <label className="flex items-center gap-1.5" title={historyReason ?? "Replace the last commit with its changes plus what is staged"}>
          <Checkbox checked={amend} disabled={busy || !!historyReason} onChange={toggleAmend} />Amend last commit
        </label>
        <span className="flex-1" />
        <Button variant="quiet" className="!px-2 !py-0.5 !text-v2-small" disabledReason={busy ? "Working" : historyReason} onClick={undo}><Undo2 size={12} aria-hidden />Undo last commit</Button>
      </div>
      {/* #14237: the buttons wrap instead of clipping; alone on its line, each fills the row. */}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="primary" onClick={() => commit()} disabledReason={reason} className="grow shrink-0 basis-auto justify-center">
          {amend ? "Amend commit" : `Commit ${staged} ${staged === 1 ? "file" : "files"}`} to {target}
          {!snap.seatBacked && <MainCheckoutMark />}
        </Button>
        <Button onClick={() => commit(true)} disabledReason={reason ?? pushRefusal} className="grow shrink-0 basis-auto justify-center">Commit and push</Button>
      </div>
    </div>
  );
}

export function ChangesList({ project, snap, selected, onSelect, onMutated, onOpenConflict }: ChangesListProps) {
  const [error, setError] = useState<string | null>(null);
  const mode = useShellMode();
  const discard = useDiscard(project, snap.scope, onMutated);
  const refusal = checkoutMutationRefusal(snap.scope, mode);
  const buckets = bucketStatus(snap.status);
  const changes: { entry: Pick<GitStatusEntry, "path">; letter: Letter | "U" }[] = [
    ...buckets.unstaged.map(e => ({ entry: e, letter: fileChipLabel(e.y) })),
    ...buckets.untracked.map(p => ({ entry: { path: p }, letter: "U" as const })),
  ];
  const stage = (paths: string[], unstage: boolean) => {
    if (paths.length === 0) return;
    scopeStage(project, snap.scope, paths, unstage).then(() => { setError(null); onMutated(); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  };
  const blocked = (e: GitStatusEntry) => isUnmerged(e);
  const allReason = refusal ?? (snap.status.some(blocked) ? "Resolve conflicts before discarding all changes" : null);
  const confirmation = (path: string | null) => discard.target?.path === path
    ? <DiscardConfirmation target={discard.target} busy={discard.busy} onConfirm={discard.confirm} onCancel={() => discard.setTarget(null)} /> : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <CommitBox project={project} snap={snap} staged={buckets.staged.length} onDone={onMutated} onError={setError} />
      {(error ?? discard.error) && <div role="alert" className="border-b border-[var(--v2-edge)] px-3 py-2 text-v2-body text-[var(--v2-bad)]">{error ?? discard.error}</div>}
      <SectionLabel>Staged {buckets.staged.length}</SectionLabel>
      {buckets.staged.length === 0 && <div className="px-3 py-1 text-v2-body text-[var(--v2-muted)]">Nothing staged.</div>}
      {buckets.staged.map(e => <div key={`s-${e.path}`}>
        <FileRow entry={e} letter={fileChipLabel(e.x)} snap={snap} selected={selected === e.path} onSelect={() => onSelect(e.path)} onToggle={() => stage([e.path], true)}
          conflict={blocked(e)} onConflict={() => onOpenConflict?.(e.path)}
          action={<>
            <IconButton label={`Discard ${e.path}`} title={refusal ?? (blocked(e) ? "Resolve this conflict before discarding" : "Copy to Trash, then discard")} size={22}
              disabled={!!refusal || blocked(e)} onClick={() => discard.setTarget({ path: e.path })}><Undo2 size={12} aria-hidden /></IconButton>
            <IconButton label={`Unstage ${e.path}`} title="Unstage" size={22} onClick={() => stage([e.path], true)}><Minus size={12} aria-hidden /></IconButton>
          </>} />
        {confirmation(e.path)}
      </div>)}
      <div className="flex items-center pr-2">
        <div className="flex-1"><SectionLabel>{snap.seatBacked ? "Your changes" : "Changes"} {changes.length}</SectionLabel></div>
        <IconButton label="Discard all changes" title={allReason ?? "Copy every change to Trash, then discard all"} size={22} disabled={snap.status.length === 0 || !!allReason}
          onClick={() => discard.setTarget({ path: null })}><Undo2 size={12} aria-hidden /></IconButton>
        <IconButton label="Stage all" title="Stage all (conflicted files stay out)" size={22} disabled={changes.length === 0}
          onClick={() => stage(stageableChanges(snap.status), false)}><Plus size={12} aria-hidden /></IconButton>
      </div>
      {confirmation(null)}
      {changes.length === 0 && <div className="px-3 py-1 text-v2-body text-[var(--v2-muted)]">No uncommitted changes.</div>}
      {changes.map(({ entry, letter }) => {
        const full = snap.status.find(s => s.path === entry.path);
        const isConflict = !!full && blocked(full);
        const reason = isConflict ? "Staging would erase git's conflict record. Resolve it first." : null;
        const discardReason = refusal ?? (isConflict ? "Resolve this conflict before discarding" : null);
        return <div key={`u-${entry.path}`}>
          <FileRow entry={entry} letter={letter} snap={snap} selected={selected === entry.path} onSelect={() => onSelect(entry.path)} onToggle={() => stage([entry.path], false)}
            conflict={isConflict} onConflict={() => onOpenConflict?.(entry.path)}
            action={<>
              <IconButton label={`Discard ${entry.path}`} title={discardReason ?? "Copy to Trash, then discard"} size={22} disabled={!!discardReason}
                onClick={() => discard.setTarget({ path: entry.path })}><Undo2 size={12} aria-hidden /></IconButton>
              <IconButton label={`Stage ${entry.path}`} title={reason ?? "Stage"} size={22} disabled={!!reason} onClick={() => stage([entry.path], false)}><Plus size={12} aria-hidden /></IconButton>
            </>} />
          {confirmation(entry.path)}
        </div>;
      })}
    </div>
  );
}
