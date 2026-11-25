// The full Source control tab (#13988), split around the bottom panel (#14241): the changes list
// or the commit history runs full height on the left, and the diff or commit detail fills the
// right column above the panel. The shared state lives in the Code screen, which owns both columns.
import { conflictPaths } from "../../../features/code/gitApi";
import type { Card } from "../../../shared/api/client";
import { Button } from "../../ui/Button";
import type { Navigate } from "../../routes";
import { ChangesList } from "./ChangesList";
import { CommitDetail, UnlandedDetail } from "./CommitDetail";
import { DiffPane, type ChipFile } from "./DiffPane";
import { HistoryView, UNLANDED_KEY } from "./HistoryView";
import { fileChipLabel, type HistoryRow } from "./model";
import { useFileDiff, useSeatDiff } from "./usePatch";
import type { ScmView } from "./Toolbar";
import type { ScopeSnapshot } from "./useScopeGit";
import { scopeApplyPatch } from "./scopeGitApi";

export type ChatActs = { addToChat: (text: string) => void; copy: (text: string) => void; branchRefusal: string | null };

/** Changes when the working tree does; the diff readers refetch on it. The line counts are in it
 *  because a hunk or line discard leaves the file "M" and only the counts move (#14101 drill). */
export function statusSignature(snap: ScopeSnapshot): string {
  const counts = snap.counts.map(c => `${c.path}:${c.plus ?? ""}:${c.minus ?? ""}`).join("|");
  return `${snap.status.map(s => `${s.x}${s.y}${s.path}`).join("|")}#${snap.ahead ?? ""}#${counts}`;
}

/** One chip per changed path, with its letter and line counts. */
export function changeChips(snap: ScopeSnapshot): ChipFile[] {
  const seen = new Set<string>();
  const out: ChipFile[] = [];
  for (const e of snap.status) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    const n = snap.counts.find(c => c.path === e.path);
    out.push({ path: e.path, letter: e.x === "?" ? "U" : fileChipLabel(e.y.trim() ? e.y : e.x), plus: n?.plus ?? null, minus: n?.minus ?? null });
  }
  return out;
}

/** The source tab's full-height left column: the changes list or the commit history (#14241). */
export function SourceListColumn(p: {
  project: string; snap: ScopeSnapshot; view: ScmView; seats: readonly string[];
  rows: HistoryRow[]; onRows: (rows: HistoryRow[]) => void;
  selected: string | null; onSelect: (path: string) => void; selectedKey: string | null; onSelectKey: (k: string) => void;
  onMutated: () => void; onOpenConflict: (path: string) => void;
}) {
  const conflicts = conflictPaths(p.snap.status);
  const ahead = p.snap.seatBacked && p.snap.ahead ? p.snap.ahead : null;
  return (
    <div data-testid="source-list" className="flex min-h-0 shrink-0 flex-col">
      {conflicts.length > 0 && (
        <div role="status" className="flex items-center gap-3 border-b border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-4 py-2 text-[12px] text-[var(--v2-text-2)]">
          <span className="flex-1">Git lists {conflicts.length} {conflicts.length === 1 ? "file" : "files"} as unmerged here. Something is paused until they are resolved.</span>
          <Button onClick={() => p.onOpenConflict(conflicts[0])}>Resolve conflicts</Button>
        </div>
      )}
      {p.view === "changes"
        ? <div className="flex w-[320px] shrink-0 flex-col border-r border-[var(--v2-edge)]">
          <ChangesList project={p.project} snap={p.snap} selected={p.selected} onSelect={p.onSelect} onMutated={p.onMutated} onOpenConflict={p.onOpenConflict} />
        </div>
        : <HistoryView rows={p.rows} branch={p.snap.branch} unlanded={ahead} selected={p.selectedKey} onSelect={p.onSelectKey}
          seatBacked={p.snap.seatBacked} project={p.project} scope={p.snap.scope} seats={p.seats} onRows={p.onRows} />}
    </div>
  );
}

/** The source tab's right column body: the picked change's diff, or the selected commit's detail (#14241). */
export function SourceDetail(p: {
  project: string; snap: ScopeSnapshot; view: ScmView; cards: Card[];
  chips: ChipFile[]; selected: string | null; onPick: (path: string) => void;
  historyRows: HistoryRow[]; selectedKey: string | null; onSelectKey: (k: string) => void;
  acts: ChatActs; onNavigate: Navigate; onMutated: () => void; onError: (message: string) => void; onOpenFile: (path: string) => void;
}) {
  return p.view === "changes"
    ? <ChangesDetail project={p.project} snap={p.snap} chips={p.chips} selected={p.selected} onPick={p.onPick} acts={p.acts} onOpenFile={p.onOpenFile} onMutated={p.onMutated} />
    : <HistoryDetail project={p.project} snap={p.snap} cards={p.cards} historyRows={p.historyRows} selectedKey={p.selectedKey}
      onSelectKey={p.onSelectKey} acts={p.acts} onNavigate={p.onNavigate} onMutated={p.onMutated} onError={p.onError} />;
}

function ChangesDetail(p: { project: string; snap: ScopeSnapshot; chips: ChipFile[]; selected: string | null; onPick: (path: string) => void; acts: ChatActs; onOpenFile: (path: string) => void; onMutated: () => void }) {
  const patch = useFileDiff(p.project, p.snap.scope, p.selected, statusSignature(p.snap));
  const apply = async (text: string, action: "stage" | "unstage" | "discard", path: string) => {
    try { await scopeApplyPatch(p.project, p.snap.scope, path, text, action); }
    finally { p.onMutated(); }
  };
  return (
    <DiffPane chips={p.chips} selected={p.selected} onSelect={p.onPick} patch={patch} onAddToChat={p.acts.addToChat} onOpenFile={p.onOpenFile} onApply={apply} project={p.project} scope={p.snap.scope}
      empty={p.chips.length === 0 ? "Nothing has changed on this checkout." : "Git shows no text diff for this file."} />
  );
}

function HistoryDetail(p: { project: string; snap: ScopeSnapshot; cards: Card[]; historyRows: HistoryRow[]; selectedKey: string | null; onSelectKey: (k: string) => void; acts: ChatActs; onNavigate: Navigate; onMutated: () => void; onError: (message: string) => void }) {
  const ahead = p.snap.seatBacked && p.snap.ahead ? p.snap.ahead : null;
  const key = p.selectedKey ?? (ahead ? UNLANDED_KEY : p.historyRows[0]?.sha ?? null);
  const diff = useSeatDiff(p.project, p.snap.scope, key === UNLANDED_KEY, statusSignature(p.snap));
  const row = p.historyRows.find(r => r.sha === key) ?? null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {key === UNLANDED_KEY && ahead
        ? <UnlandedDetail branch={p.snap.branch} count={ahead} diff={diff} acts={p.acts} project={p.project} scope={p.snap.scope} />
        : <CommitDetail row={row} selectedSha={key === UNLANDED_KEY ? null : key} project={p.project} scope={p.snap.scope} cards={p.cards} acts={p.acts} onNavigate={p.onNavigate} onMutated={p.onMutated} onError={p.onError} onSelectCommit={p.onSelectKey} />}
    </div>
  );
}
