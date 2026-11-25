// The changed-file chip strip above a full-width diff (#13988): chips on top so the diff keeps the width.
import { useMemo, useState } from "react";
import { Rows3 } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { DiffView, type ApplyPatch, type DiffLayout } from "./DiffView";
import { parseUnifiedDiff } from "./diff";
import { Counts, StatusLetter } from "./parts";
import type { Letter } from "./model";

export type ChipFile = { path: string; letter: Letter | "U"; plus: number | null; minus: number | null };
export type PatchState = { kind: "loading" } | { kind: "error"; reason: string } | { kind: "ok"; patch: string; truncated?: boolean };

export function DiffPane({ chips, selected, onSelect, patch, onAddToChat, onOpenFile, onApply, empty, project, scope }: {
  chips: ChipFile[]; selected: string | null; onSelect: (path: string) => void; patch: PatchState;
  onAddToChat: (text: string) => void; onOpenFile?: (path: string) => void; onApply?: ApplyPatch; empty: string;
  project?: string; scope?: string | null;
}) {
  const [layout, setLayout] = useState<DiffLayout>("combined");
  const [all, setAll] = useState(false);
  const parsed = useMemo(() => (patch.kind === "ok" ? parseUnifiedDiff(patch.patch) : []), [patch]);
  const shown = all || !selected ? parsed : parsed.filter(f => f.path === selected);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-[var(--v2-edge)] px-3 py-1.5">
        <span className="shrink-0 whitespace-nowrap pr-1 text-[11.5px] text-[var(--v2-muted)]">{chips.length} {chips.length === 1 ? "file" : "files"}</span>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="group" aria-label="Changed files">
          {chips.map(c => (
            <button key={c.path} type="button" aria-pressed={!all && selected === c.path} onClick={() => { setAll(false); onSelect(c.path); }} title={c.path}
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-[3px] text-[11.5px] ${
                !all && selected === c.path ? "border-[var(--v2-accent)] bg-[var(--v2-accent-soft)] text-[var(--v2-text)]" : "border-[var(--v2-edge-2)] bg-transparent text-[var(--v2-text-2)] hover:bg-[var(--v2-raised)]"}`}>
              <StatusLetter letter={c.letter} />{c.path}<Counts plus={c.plus} minus={c.minus} />
            </button>
          ))}
        </div>
        <IconButton label="Open every changed file in one diff" title="Open all in one diff" size={24} aria-pressed={all} onClick={() => setAll(a => !a)}><Rows3 size={13} aria-hidden /></IconButton>
      </div>
      {patch.kind === "loading" && <div className="px-4 py-6 text-[12.5px] text-[var(--v2-muted)]">Reading the diff</div>}
      {patch.kind === "error" && <div role="alert" className="px-4 py-6 text-[12.5px] text-[var(--v2-bad)]">{patch.reason}</div>}
      {patch.kind === "ok" && patch.truncated && <div className="border-b border-[var(--v2-edge)] px-4 py-1.5 text-[11.5px] text-[var(--v2-warn)]">The patch is capped at 400 KB, so this diff is partial.</div>}
      {patch.kind === "ok" && (parsed.length === 0
        ? <div className="px-4 py-6 text-[12.5px] text-[var(--v2-muted)]">{empty}</div>
        : <DiffView files={shown} layout={layout} onLayout={setLayout} onAddToChat={onAddToChat} onOpenFile={onOpenFile} onApply={onApply} project={project} scope={scope} />)}
    </div>
  );
}
