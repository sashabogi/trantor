// One Explorer row: icon, status-tinted name, then line counts and the git letter at the right (#13987 drill).
import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, File as FileIcon, Folder } from "lucide-react";
import type { FileEntry } from "../../features/code/fileApi";
import { Popover, MenuItem } from "../shell/Popover";
import { TONE_VAR, countsLabel, decorationTitle, folderTitle, type Decoration, type FolderMark } from "./explorerStatus";

export type RowMark = { deco: Decoration | null; folder?: FolderMark; plus?: number | null; minus?: number | null };

export function rowTitle(entry: FileEntry, m: RowMark): string {
  if (entry.dir) return m.folder ? `${entry.path} — ${folderTitle(m.folder.count)}` : entry.path;
  const parts = [m.deco ? decorationTitle(m.deco) : "", countsLabel(m.plus, m.minus)].filter(Boolean);
  return parts.length ? `${entry.path} — ${parts.join(" · ")}` : entry.path;
}

export function NameInput({ depth, initial = "", placeholder, onCommit, onCancel }: {
  depth: number; initial?: string; placeholder?: string; onCommit: (name: string) => void; onCancel: () => void;
}) {
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (commit: boolean, value: string) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value.trim()); else onCancel();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") finish(true, e.currentTarget.value);
    if (e.key === "Escape") finish(false, "");
  };
  return (
    <div className="flex items-center py-[2px] pr-2" style={{ paddingLeft: 26 + depth * 12 }}>
      <input ref={ref} defaultValue={initial} placeholder={placeholder} aria-label={placeholder ?? "Name"} onKeyDown={onKey}
        onBlur={e => finish(true, e.currentTarget.value)}
        className="min-w-0 flex-1 rounded border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2 py-0.5 text-[12px] text-[var(--v2-text)] outline-none focus:border-[var(--v2-accent)]" />
    </div>
  );
}

export type RowAction = "new-file" | "new-folder" | "rename" | "delete";

export function ExplorerRow({ entry, depth, open, mark, selected, focusable, menuOpen, renaming, onActivate, onFocusRow, onMenu, onCloseMenu, onAction, onRenamed, onRenameCancel }: {
  entry: FileEntry; depth: number; open: boolean; mark: RowMark; selected: boolean; focusable: boolean;
  menuOpen: boolean; renaming: boolean;
  onActivate: () => void; onFocusRow: () => void; onMenu: () => void; onCloseMenu: () => void;
  onAction: (a: RowAction) => void; onRenamed: (name: string) => void; onRenameCancel: () => void;
}) {
  if (renaming) return <NameInput depth={depth} initial={entry.name} placeholder="New name" onCommit={onRenamed} onCancel={onRenameCancel} />;
  const { deco, folder } = mark;
  const tone = entry.dir ? folder?.top.tone : deco?.tone;
  const color = tone ? TONE_VAR[tone] : "var(--v2-text-2)";
  const counts = entry.dir ? "" : countsLabel(mark.plus, mark.minus);
  return (
    <div className="relative">
      <div role="treeitem" aria-level={depth + 1} aria-expanded={entry.dir ? open : undefined} aria-selected={selected}
        data-path={entry.path} tabIndex={focusable ? 0 : -1} title={rowTitle(entry, mark)}
        onClick={onActivate} onFocus={onFocusRow} onContextMenu={e => { e.preventDefault(); onMenu(); }}
        className={`v2-hover flex cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-[12px] ${selected ? "bg-[var(--v2-raised)]" : ""}`}
        style={{ paddingLeft: 6 + depth * 12 }}>
        {entry.dir
          ? (open ? <ChevronDown size={12} aria-hidden className="shrink-0" /> : <ChevronRight size={12} aria-hidden className="shrink-0" />)
          : <span className="w-3 shrink-0" />}
        {entry.dir ? <Folder size={12} aria-hidden className="shrink-0 opacity-70" /> : <FileIcon size={12} aria-hidden className="shrink-0 opacity-70" />}
        <span data-name className={`min-w-0 flex-1 truncate ${deco?.letter === "D" ? "line-through" : ""}`} style={{ color }}>{entry.name}</span>
        {counts && <span data-counts className="v2-mono shrink-0 text-[10px] tabular-nums text-[var(--v2-muted)]">{counts}</span>}
        {!entry.dir && deco && (
          <span data-letter={deco.letter} aria-label={decorationTitle(deco)} className="v2-mono w-3 shrink-0 text-center text-[11px] font-semibold" style={{ color: TONE_VAR[deco.tone] }}>{deco.letter}</span>
        )}
        {entry.dir && folder && <span data-folder-dot={folder.top.tone} aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE_VAR[folder.top.tone] }} />}
      </div>
      <Popover open={menuOpen} onClose={onCloseMenu} label={`Actions for ${entry.name}`}>
        <MenuItem onSelect={() => onAction("new-file")}>New file</MenuItem>
        {entry.dir && <MenuItem onSelect={() => onAction("new-folder")}>New folder</MenuItem>}
        <MenuItem onSelect={() => onAction("rename")}>Rename</MenuItem>
        <MenuItem onSelect={() => onAction("delete")}>Delete</MenuItem>
      </Popover>
    </div>
  );
}
