// The 2.0 file tree for the Workspace Files column and the Code Explorer: git status letters, tinted names and
// folder dots like a real IDE's explorer (#13987 drill). The classic FileTree stays for classic screens.
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { CircleHelp, Plus } from "lucide-react";
import { createFile, deleteFile, renameFile, safePath, type FileEntry } from "../../features/code/fileApi";
import { Popover } from "../shell/Popover";
import { IconButton } from "./IconButton";
import { ExplorerRow, NameInput, type RowAction, type RowMark } from "./ExplorerRow";
import { joinPath, parentOf, renameFolder } from "./explorerOps";
import { MoveToPicker } from "./MoveToPicker";
import { useExplorerOps } from "./useExplorerOps";
import { LEGEND, TONE_VAR, decorate, decorateCode } from "./explorerStatus";
import { useExplorerData, type ExplorerData } from "./useExplorerData";

type Edit = { kind: "create"; dir: string; folder: boolean } | { kind: "rename"; entry: FileEntry } | null;

function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <IconButton label="Git status legend" title="What the letters and colours mean" size={24} onClick={() => setOpen(o => !o)}>
        <CircleHelp size={13} aria-hidden />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} label="Git status legend" align="right">
        <div className="flex flex-col gap-1.5 p-2 text-[11.5px]">
          {LEGEND.map(l => (
            <div key={l.letter} data-legend={l.letter} className="flex items-baseline gap-2">
              <span className="v2-mono w-3 shrink-0 text-center font-semibold" style={{ color: TONE_VAR[l.tone] }}>{l.letter}</span>
              <span className="text-[var(--v2-text-2)]"><span className="text-[var(--v2-text)]">{l.name}</span>: {l.sentence}</span>
            </div>
          ))}
          <div className="border-t border-[var(--v2-edge)] pt-1.5 text-[var(--v2-muted)]">A dot on a folder marks the most important change inside it.</div>
        </div>
      </Popover>
    </span>
  );
}

function markOf(entry: FileEntry, d: ExplorerData): RowMark {
  const g = d.gitStatus.get(entry.path);
  const deco = g ? decorate(g.x, g.y) : decorateCode(entry.status);
  const c = d.counts.get(entry.path);
  return { deco, folder: d.folders.get(entry.path), plus: c ? c.plus : entry.plus, minus: c ? c.minus : entry.minus };
}

/** Arrow keys move, Right/Left open and close folders, Enter opens (WAI-ARIA tree pattern). */
function useTreeKeys(d: ExplorerData, onOpen: (p: string) => void, treeRef: RefObject<HTMLDivElement | null>, startEdit: (e: Edit) => void, remove: (e: FileEntry) => void) {
  const focusPath = (path: string | undefined) => {
    if (path === undefined) return;
    [...(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])].find(el => el.dataset.path === path)?.focus();
  };
  return (e: KeyboardEvent<HTMLDivElement>) => {
    const item = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[role=treeitem]") : null;
    if (!item || (e.target instanceof HTMLElement && e.target.tagName === "INPUT")) return;
    const i = d.rows.findIndex(r => r.entry.path === item.dataset.path);
    const row = d.rows[i];
    if (!row) return;
    const { entry, depth } = row;
    const open = d.expanded.includes(entry.path);
    const handled = () => e.preventDefault();
    if (e.key === "ArrowDown") { handled(); focusPath(d.rows[i + 1]?.entry.path); }
    else if (e.key === "ArrowUp") { handled(); focusPath(d.rows[i - 1]?.entry.path); }
    else if (e.key === "Home") { handled(); focusPath(d.rows[0]?.entry.path); }
    else if (e.key === "End") { handled(); focusPath(d.rows[d.rows.length - 1]?.entry.path); }
    else if (e.key === "ArrowRight" && entry.dir) { handled(); if (!open) d.expand(entry.path); else focusPath(d.rows[i + 1]?.entry.path); }
    else if (e.key === "ArrowLeft") {
      handled();
      if (entry.dir && open) d.toggle(entry.path);
      else focusPath(d.rows.slice(0, i).reverse().find(r => r.depth === depth - 1)?.entry.path);
    } else if (e.key === "Enter" || e.key === " ") { handled(); if (entry.dir) d.toggle(entry.path); else onOpen(entry.path); }
    else if (e.key === "F2") { handled(); startEdit({ kind: "rename", entry }); }
    else if (e.key === "Delete") { handled(); remove(entry); }
  };
}

function Tree({ project, seat, onOpen, openPath }: { project: string; seat: string | null; onOpen: (path: string) => void; openPath?: string | null }) {
  const d = useExplorerData(project, seat);
  const [edit, setEdit] = useState<Edit>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [moving, setMoving] = useState<FileEntry | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [overPath, setOverPath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const scopeSeat = seat ?? undefined;

  const run = (job: Promise<unknown>) => job.then(() => { setNote(null); d.refresh(); }).catch(e => setNote(e instanceof Error ? e.message : String(e)));
  const guard = (path: string) => (safePath(path) ? true : (setNote("path escapes the project"), false));
  const commitCreate = (dir: string, folder: boolean, name: string) => {
    setEdit(null);
    const path = joinPath(dir, name);
    if (!name || !guard(path)) return;
    if (dir) d.expand(dir);
    // A folder has no git identity until it holds a file, so the new one gets a .gitkeep.
    run(createFile(project, folder ? `${path}/.gitkeep` : path, scopeSeat, ""));
  };
  const commitRename = (entry: FileEntry, name: string) => {
    setEdit(null);
    const path = joinPath(parentOf(entry.path), name);
    if (!name || name === entry.name || !guard(path)) return;
    run(entry.dir ? renameFolder(project, entry.path, path, scopeSeat) : renameFile(project, entry.path, path, scopeSeat));
  };
  const ops = useExplorerOps({ project, seat: scopeSeat, run, note: setNote });
  const remove = (entry: FileEntry) => {
    if (entry.dir) return ops.removeFolder(entry);
    if (!confirm(`Delete ${entry.path}?`)) return;
    run(deleteFile(project, entry.path, scopeSeat));
  };
  const act = (entry: FileEntry, a: RowAction) => {
    setMenu(null);
    if (a === "delete") remove(entry);
    else if (a === "rename") setEdit({ kind: "rename", entry });
    else if (a === "move") setMoving(entry);
    else if (a === "copy-path" || a === "copy-relative" || a === "reveal") ops.extra(entry, a);
    else {
      const dir = entry.dir ? entry.path : parentOf(entry.path);
      if (dir) d.expand(dir);
      setEdit({ kind: "create", dir, folder: a === "new-folder" });
    }
  };
  const onKeyDown = useTreeKeys(d, onOpen, treeRef, setEdit, remove);

  if (d.error) return <div className="px-3 py-1.5 text-[11.5px] leading-relaxed text-[var(--v2-muted)]">{d.error}</div>;
  if (!d.roots) return <div className="px-3 py-1.5 text-[11.5px] text-[var(--v2-muted)]">reading</div>;
  const createAt = (dir: string) => edit?.kind === "create" && edit.dir === dir
    ? <NameInput depth={dir ? (d.rows.find(r => r.entry.path === dir)?.depth ?? -1) + 1 : 0} placeholder={edit.folder ? "folder name" : "file name"} onCommit={n => commitCreate(dir, edit.folder, n)} onCancel={() => setEdit(null)} />
    : null;
  const dropOn = (dir: string) => {
    const dragged = d.rows.find(r => r.entry.path === dragPath)?.entry;
    setDragPath(null); setOverPath(null);
    if (dragged) { if (dir) d.expand(dir); ops.move(dragged, dir); }
  };
  const firstPath = d.rows[0]?.entry.path;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-2 py-1" data-root-drop onDragOver={e => { if (dragPath) e.preventDefault(); }} onDrop={e => { e.preventDefault(); dropOn(""); }}>
        <span className="flex-1" />
        <IconButton label="New file" title="Create a new file (relative path, e.g. src/foo.ts)" size={24} onClick={() => setEdit({ kind: "create", dir: "", folder: false })}>
          <Plus size={13} aria-hidden />
        </IconButton>
        <Legend />
      </div>
      {moving && <MoveToPicker project={project} seat={seat} entry={moving} onClose={() => setMoving(null)} onPick={dir => { if (dir) d.expand(dir); ops.move(moving, dir); setMoving(null); }} />}
      {note && <div role="status" className="px-3 pb-1 text-[11px] text-[var(--v2-bad)]">{note}</div>}
      <div ref={treeRef} role="tree" aria-label="Files" onKeyDown={onKeyDown} className="flex flex-col">
        {createAt("")}
        {d.rows.map(({ entry, depth }) => (
          <div key={entry.path} role="none">
            <ExplorerRow entry={entry} depth={depth} open={d.expanded.includes(entry.path)} mark={markOf(entry, d)}
              selected={!entry.dir && openPath === entry.path} focusable={focused === null ? entry.path === firstPath : focused === entry.path}
              menuOpen={menu === entry.path}
              drag={{ over: overPath === entry.path && entry.dir, onStart: () => setDragPath(entry.path), onEnd: () => { setDragPath(null); setOverPath(null); }, onOver: () => setOverPath(entry.path), onDrop: () => dropOn(entry.path) }}
              renaming={edit?.kind === "rename" && edit.entry.path === entry.path}
              onActivate={() => { setFocused(entry.path); if (entry.dir) d.toggle(entry.path); else onOpen(entry.path); }}
              onFocusRow={() => setFocused(entry.path)} onMenu={() => setMenu(entry.path)} onCloseMenu={() => setMenu(null)}
              onAction={a => act(entry, a)} onRenamed={n => commitRename(entry, n)} onRenameCancel={() => setEdit(null)} />
            {entry.dir && d.expanded.includes(entry.path) && createAt(entry.path)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Remounted per project and checkout, so one scope's open folders and status never bleed into another's. */
export function ExplorerTree(p: { project: string; seat: string | null; onOpen: (path: string) => void; openPath?: string | null }) {
  return <Tree key={`${p.project}::${p.seat ?? "project"}`} {...p} />;
}
