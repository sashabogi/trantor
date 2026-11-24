// The full Source control tab (#13988): History (commit list and detail) or Changes (file list and
// diff). The sidebar is folded away while this tab is open, so the diff gets the whole width.
import { useMemo, useState } from "react";
import { conflictPaths } from "../../../features/code/gitApi";
import type { Card } from "../../../shared/api/client";
import { Button } from "../../ui/Button";
import type { Navigate } from "../../routes";
import { ChangesList } from "./ChangesList";
import { CommitDetail, UnlandedDetail } from "./CommitDetail";
import { DiffPane, type ChipFile } from "./DiffPane";
import { HistoryView, UNLANDED_KEY } from "./HistoryView";
import { fileChipLabel, toRow, type HistoryRow } from "./model";
import { useFileDiff, useSeatDiff } from "./usePatch";
import type { ScmView } from "./Toolbar";
import type { ScopeSnapshot } from "./useScopeGit";

export type ChatActs = { addToChat: (text: string) => void; copy: (text: string) => void };

/** Changes when the working tree does; the diff readers refetch on it. */
export function statusSignature(snap: ScopeSnapshot): string {
  return `${snap.status.map(s => `${s.x}${s.y}${s.path}`).join("|")}#${snap.ahead ?? ""}`;
}

function changeChips(snap: ScopeSnapshot): ChipFile[] {
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

function ChangesBody(p: { project: string; snap: ScopeSnapshot; acts: ChatActs; onMutated: () => void; onOpenFile: (path: string) => void; onOpenConflict: (path: string) => void }) {
  const chips = useMemo(() => changeChips(p.snap), [p.snap]);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked && chips.some(c => c.path === picked) ? picked : chips[0]?.path ?? null;
  const patch = useFileDiff(p.project, p.snap.scope, selected, statusSignature(p.snap));
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex w-[320px] shrink-0 flex-col border-r border-[var(--v2-edge)]">
        <ChangesList project={p.project} snap={p.snap} selected={selected} onSelect={setPicked} onMutated={p.onMutated} onOpenConflict={p.onOpenConflict} />
      </div>
      <DiffPane chips={chips} selected={selected} onSelect={setPicked} patch={patch} onAddToChat={p.acts.addToChat} onOpenFile={p.onOpenFile}
        empty={chips.length === 0 ? "Nothing has changed on this checkout." : "Git shows no text diff for this file."} />
    </div>
  );
}

function HistoryBody(p: { project: string; snap: ScopeSnapshot; cards: Card[]; selectedKey: string | null; onSelect: (k: string) => void; acts: ChatActs; onNavigate: Navigate; seats: readonly string[] }) {
  const ctx = useMemo(() => ({ seats: p.seats, branch: p.snap.branch }), [p.seats, p.snap.branch]);
  const rows: HistoryRow[] = useMemo(() => p.snap.log.map(c => toRow(c, ctx)), [p.snap.log, ctx]);
  const ahead = p.snap.seatBacked && p.snap.ahead ? p.snap.ahead : null;
  const key = p.selectedKey ?? (ahead ? UNLANDED_KEY : rows[0]?.sha ?? null);
  const diff = useSeatDiff(p.project, p.snap.scope, key === UNLANDED_KEY, statusSignature(p.snap));
  const row = rows.find(r => r.sha === key) ?? null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <HistoryView rows={rows} branch={p.snap.branch} unlanded={ahead} selected={key} onSelect={p.onSelect} seatBacked={p.snap.seatBacked} />
      {key === UNLANDED_KEY && ahead
        ? <UnlandedDetail branch={p.snap.branch} count={ahead} diff={diff} acts={p.acts} />
        : <CommitDetail row={row} project={p.project} scope={p.snap.scope} cards={p.cards} acts={p.acts} onNavigate={p.onNavigate} />}
    </div>
  );
}

export function SourceControlTab(p: {
  project: string; snap: ScopeSnapshot; view: ScmView; cards: Card[]; seats: readonly string[]; selectedKey: string | null; onSelectKey: (k: string) => void;
  acts: ChatActs; onNavigate: Navigate; onMutated: () => void; onOpenFile: (path: string) => void; onOpenConflict: (path: string | null) => void;
}) {
  const conflicts = conflictPaths(p.snap.status);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {conflicts.length > 0 && (
        <div role="status" className="flex items-center gap-3 border-b border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-4 py-2 text-[12px] text-[var(--v2-text-2)]">
          <span className="flex-1">Git lists {conflicts.length} {conflicts.length === 1 ? "file" : "files"} as unmerged here. Something is paused until they are resolved.</span>
          <Button onClick={() => p.onOpenConflict(conflicts[0])}>Resolve conflicts</Button>
        </div>
      )}
      {p.view === "changes"
        ? <ChangesBody project={p.project} snap={p.snap} acts={p.acts} onMutated={p.onMutated} onOpenFile={p.onOpenFile} onOpenConflict={p.onOpenConflict} />
        : <HistoryBody project={p.project} snap={p.snap} cards={p.cards} selectedKey={p.selectedKey} onSelect={p.onSelectKey} acts={p.acts} onNavigate={p.onNavigate} seats={p.seats} />}
    </div>
  );
}
