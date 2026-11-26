// Staged and unstaged files with the commit box (#13988). Every mutation goes through the scoped
// git commands; discard asks for confirmation and copies the work to the Trash first.
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Minus, MoreHorizontal, Plus, Undo2 } from "lucide-react";
import { bucketStatus, isUnmerged, lineCountFor, stageableChanges, type GitStatusEntry } from "../../../features/code/gitApi";
import { IconButton } from "../../ui/IconButton";
import { Kbd } from "../../ui/Kbd";
import { SplitButton } from "../../ui/SplitButton";
import { Popover } from "../../shell/Popover";
import { Counts, PathLabel, SectionLabel, StatusLetter } from "./parts";
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
    <div data-selected={selected || undefined} className={`group flex items-center gap-1.5 px-3 py-1 text-v2-body ${selected ? "bg-[var(--v2-accent-soft)]" : "hover:bg-[var(--v2-raised)]"}`}>
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
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const mode = useShellMode();
  const pushRefusal = checkoutMutationRefusal(snap.scope, mode);
  const pushed = !!snap.upstream && snap.ahead === 0;
  const noCommit = snap.log.length === 0;
  const historyReason = historyMutationRefusal(snap.scope, mode) ?? (noCommit ? "There is no commit to change" : pushed ? "The last commit is already pushed" : null);
  const reason = !amend && staged === 0 ? "Nothing is staged yet" : !message.trim() ? "Write a commit message first" : amend && historyReason ? historyReason : busy ? "Working" : null;
  const expanded = staged > 0 || amend;
  const full = description.trim() ? `${message}\n\n${description.trim()}` : message;
  const reset = () => { setMessage(""); setDescription(""); setAmend(false); };
  const commit = (push = false) => {
    setBusy(true);
    void (amend ? scopeAmend(project, snap.scope, full) : scopeCommit(project, snap.scope, full))
      .then(() => push ? scopePush(project, snap.scope) : undefined)
      .then(() => { reset(); onDone(); })
      .catch(e => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const undo = () => {
    setBusy(true);
    void scopeUndo(project, snap.scope)
      .then(previous => { setMessage(previous); setDescription(""); setAmend(false); onDone(); })
      .catch(e => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const toggleAmend = () => {
    setAmend(value => !value);
    setMessage(amend ? "" : (snap.log[0]?.subject ?? ""));
    setDescription("");
  };
  // #14344: Cmd+Enter commits from either field.
  const onKey = (e: KeyboardEvent<HTMLElement>) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !reason) commit(); };
  const undoReason = busy ? "Working" : historyReason;
  const amendItem = { label: "Amend last commit", onSelect: toggleAmend, disabledReason: busy ? "Working" : historyReason };
  const undoItem = { label: "Undo last commit", onSelect: undo, disabledReason: undoReason };
  const last = snap.log[0];
  const length = message.length;
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="relative flex items-center gap-1">
        <label htmlFor="v2-commit-msg" className="sr-only">Commit message</label>
        <input id="v2-commit-msg" value={message} onChange={e => setMessage(e.target.value)} onKeyDown={onKey}
          placeholder="Message for your commit"
          className={`min-w-0 flex-1 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] py-1.5 pl-2.5 text-v2-base text-[var(--v2-text)] outline-none ${expanded ? "pr-9" : "pr-2.5"}`} />
        {expanded && <span data-char-count className={`v2-mono pointer-events-none absolute right-2.5 text-v2-small ${length > 72 ? "text-[var(--v2-warn)]" : "text-[var(--v2-muted)]"}`}>{length}</span>}
        {!expanded && (
          <span className="relative shrink-0">
            <IconButton label="More commit actions" title="Amend or undo the last commit" size={28} onClick={() => setMoreOpen(o => !o)}><MoreHorizontal size={14} aria-hidden /></IconButton>
            <Popover open={moreOpen} onClose={() => setMoreOpen(false)} label="More commit actions" align="right">
              {[amendItem, undoItem].map(item => (
                <button key={item.label} type="button" role="menuitem" disabled={!!item.disabledReason} title={item.disabledReason ?? undefined}
                  onClick={() => { setMoreOpen(false); item.onSelect(); }}
                  className="v2-hover flex w-full items-center rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-v2-base text-[var(--v2-text-2)] disabled:opacity-45">{item.label}</button>
              ))}
            </Popover>
          </span>
        )}
      </div>
      {expanded && (
        <>
          <label htmlFor="v2-commit-desc" className="sr-only">Commit description</label>
          <textarea id="v2-commit-desc" value={description} onChange={e => setDescription(e.target.value)} onKeyDown={onKey} rows={2}
            placeholder="Description (optional)"
            className="w-full resize-none rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-1.5 text-v2-body text-[var(--v2-text)] outline-none" />
          {amend && (
            <div className="flex items-center gap-2 text-v2-small text-[var(--v2-muted)]">
              <span className="flex-1">Amending the last commit</span>
              <button type="button" onClick={toggleAmend} className="border-0 bg-transparent p-0 text-v2-small text-[var(--v2-link)]">Cancel</button>
            </div>
          )}
          <SplitButton label={amend ? "Amend commit" : `Commit ${staged} ${staged === 1 ? "file" : "files"}`} onPrimary={() => commit()} disabledReason={reason}
            menuLabel="More commit actions" hint={<Kbd>⌘↵</Kbd>}
            items={[{ label: "Commit and push", onSelect: () => commit(true), disabledReason: reason ?? pushRefusal }, amendItem, undoItem]} />
        </>
      )}
      {snap.status.length === 0 && !amend && (
        <div className="flex flex-col text-v2-small">
          <span className="text-[var(--v2-text-2)]">Nothing to commit</span>
          {last && <span className="truncate text-[var(--v2-faint)]" title={last.subject}>{last.subject} · {last.when}</span>}
        </div>
      )}
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
