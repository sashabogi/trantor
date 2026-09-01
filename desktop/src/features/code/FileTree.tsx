// The project's file tree, in the sidebar, with git state on every row.
//
// This exists for the operator Sasha named as the audience: a developer who wants to SEE and TOUCH
// the code rather than trust an agent's summary of it. So the tree's job is not navigation, it is
// WITNESS — which files the crew is touching, right now, without asking anyone.
//
// The tree also supports create/rename/delete operations, all path-guarded so that
// no operation can escape the project root.
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File as FileIcon, Folder, Plus, Trash2, Pencil } from "lucide-react";
import { projectFiles, createFile, deleteFile, renameFile, safePath, statusColor, statusLabel, type FileEntry } from "./fileApi";
import { listen } from "@tauri-apps/api/event";

const POLL_MS = 10_000;

function Row({ entry, depth, project, seat, onOpen, onRefresh, openPath }: { entry: FileEntry; depth: number; project: string; seat: string | null; onOpen: (path: string) => void; onRefresh: () => void; openPath?: string | null }) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<FileEntry[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState(entry.name);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !entry.dir) return;
    let alive = true;
    const load = () => { projectFiles(project, entry.path, seat ?? undefined).then(k => { if (alive) setKids(k); }).catch(() => {}); };
    load();
    const iv = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [open, entry.dir, entry.path, project, seat]);

  const color = statusColor(entry.status);

  const handleRename = async () => {
    const newName = renameName.trim();
    if (!newName || newName === entry.name) { setRenaming(false); return; }
    const parent = entry.path.includes("/") ? entry.path.substring(0, entry.path.lastIndexOf("/")) : "";
    const newPath = parent ? `${parent}/${newName}` : newName;
    const guarded = safePath(newPath);
    if (!guarded) { setError("path escapes the project"); setRenaming(false); return; }
    try {
      await renameFile(project, entry.path, newPath, seat ?? undefined);
      setRenaming(false);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRenaming(false);
    }
  };

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name) { setCreating(false); return; }
    const newPath = entry.path ? `${entry.path}/${name}` : name;
    const guarded = safePath(newPath);
    if (!guarded) { setError("path escapes the project"); setCreating(false); return; }
    if (entry.dir && !name.includes(".")) {
      // Creating a folder — create a .gitkeep placeholder so it appears in git
      try {
        await createFile(project, `${newPath}/.gitkeep`, seat ?? undefined, "");
        setCreating(false);
        onRefresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setCreating(false);
      }
      return;
    }
    try {
      await createFile(project, newPath, seat ?? undefined, "");
      setCreating(false);
      onRefresh();
      if (!entry.dir) onOpen(newPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete ${entry.path}?`)) return;
    try {
      await deleteFile(project, entry.path, seat ?? undefined);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div
        className={`relative flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[12px] hover:bg-white/[0.04] ${
          /* the OPEN file's row says so (2026-09-01, operator: "the picker doesn't even know
             you selected it") — same treatment the sidebar gives the active project */
          !entry.dir && openPath === entry.path
            ? "bg-white/[0.07] font-medium text-[var(--color-tr-text)]"
            : "text-tr-muted"
        }`}
        style={{ paddingLeft: 6 + depth * 11 }}
        onContextMenu={e => { e.preventDefault(); setMenuOpen(true); }}
      >
        {menuOpen && (
          <div className="absolute left-0 top-0 z-10 rounded-md border border-tr-edge bg-[#1a1a1e] py-1 shadow-lg" style={{ minWidth: 120 }}>
            <button type="button" onClick={() => { setMenuOpen(false); setCreating(true); setCreateName(""); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-[11.5px] text-tr-muted hover:bg-white/[0.04]">
              <Plus size={10} strokeWidth={1.5} className="shrink-0" /> New file
            </button>
            {entry.dir && (
              <button type="button" onClick={() => { setMenuOpen(false); setCreating(true); setCreateName(""); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-[11.5px] text-tr-muted hover:bg-white/[0.04]">
                <Plus size={10} strokeWidth={1.5} className="shrink-0" /> New folder
              </button>
            )}
            <hr className="my-1 border-tr-edge" />
            <button type="button" onClick={() => { setMenuOpen(false); setRenaming(true); setRenameName(entry.name); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-[11.5px] text-tr-muted hover:bg-white/[0.04]">
              <Pencil size={10} strokeWidth={1.5} className="shrink-0" /> Rename
            </button>
            <button type="button" onClick={() => { setMenuOpen(false); handleDelete(); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-[11.5px] text-tr-danger hover:bg-white/[0.04]">
              <Trash2 size={10} strokeWidth={1.5} className="shrink-0" /> Delete
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => (entry.dir ? setOpen(o => !o) : onOpen(entry.path))}
          title={entry.status ? `${entry.path} — ${statusLabel(entry.status)}` : entry.path}
          // text-left: a native button centers its text, and the name span fills the row —
          // in the 300px pane the names floated mid-row (0.3.92, seen on screen).
          className="flex flex-1 items-center gap-1.5 min-w-0 text-left"
        >
          {entry.dir
            ? (open ? <ChevronDown size={12} strokeWidth={2} className="shrink-0" /> : <ChevronRight size={12} strokeWidth={2} className="shrink-0" />)
            : <span className="w-3 shrink-0" />}
          {entry.dir
            ? <Folder size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
            : <FileIcon size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />}
          <span className="min-w-0 flex-1 truncate" style={color ? { color } : undefined}>{entry.name}</span>
          {entry.status && (
            <span className="shrink-0 text-[10px]" style={{ color }}>{statusLabel(entry.status)}</span>
          )}
          {/* the change-size chip (#5811), colored from the same git decoration tokens the SCM
              rows use. Absent for untracked/binary — no count, no chip, never a fake zero. */}
          {entry.plus !== undefined && entry.minus !== undefined && (
            <span className="tr-mono shrink-0 text-[9.5px] tabular-nums" title="lines changed vs HEAD">
              <span style={{ color: "var(--git-decoration-added)" }}>+{entry.plus}</span>{" "}
              <span style={{ color: "var(--git-decoration-deleted)" }}>−{entry.minus}</span>
            </span>
          )}
        </button>
      </div>
      {renaming && (
        <div className="flex items-center gap-1" style={{ paddingLeft: 6 + depth * 11 + 24 }}>
          <input
            type="text"
            value={renameName}
            onChange={e => setRenameName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setRenaming(false); }}
            onBlur={handleRename}
            autoFocus
            className="flex-1 rounded border border-tr-edge bg-[#101013] px-2 py-0.5 text-[12px] text-tr-text outline-none"
          />
        </div>
      )}
      {creating && (
        <div className="flex items-center gap-1" style={{ paddingLeft: 6 + depth * 11 + 24 }}>
          <input
            type="text"
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
            onBlur={handleCreate}
            autoFocus
            placeholder={entry.dir ? "folder or file name" : "file name"}
            className="flex-1 rounded border border-tr-edge bg-[#101013] px-2 py-0.5 text-[12px] text-tr-text outline-none"
          />
        </div>
      )}
      {error && <div className="px-3 py-0.5 text-[11px] text-tr-danger" style={{ paddingLeft: 6 + depth * 11 + 24 }}>{error}</div>}
      {open && kids?.map(k => <Row key={k.path} entry={k} depth={depth + 1} project={project} seat={seat} onOpen={onOpen} onRefresh={onRefresh} openPath={openPath} />)}
    </>
  );
}

export function FileTree({ project, seat, onOpen, openPath }: { project: string; seat: string | null; onOpen: (path: string) => void; openPath?: string | null }) {
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    projectFiles(project, undefined, seat ?? undefined)
      .then(r => { setRoots(r); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [project, seat]);

  useEffect(() => {
    setRoots(null);
    refresh();
    const unlisten = listen<{ project: string; paths: string[] }>("file-changed", ev => {
      if (ev.payload.project !== project) return;
      refresh();
    });
    const iv = setInterval(refresh, POLL_MS);
    return () => { clearInterval(iv); unlisten.then(u => u()).catch(() => {}); };
  }, [refresh, project]);

  if (error) {
    return <div className="px-3 py-1.5 text-[11.5px] leading-relaxed text-tr-muted">{error}</div>;
  }
  if (!roots) {
    return <div className="px-3 py-1.5 text-[11.5px] text-tr-muted">reading…</div>;
  }
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-3 py-1">
        <button
          type="button"
          onClick={() => {
            const name = prompt("New file name (relative path, e.g. src/foo.ts):");
            if (!name) return;
            const guarded = safePath(name);
            if (!guarded) { alert("path escapes the project"); return; }
            createFile(project, name, seat ?? undefined, "").then(() => refresh()).catch(e => setError(e instanceof Error ? e.message : String(e)));
          }}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-tr-muted hover:bg-white/[0.04]"
          title="Create a new file"
        >
          <Plus size={10} strokeWidth={1.5} /> New file
        </button>
      </div>
      {roots.map(e => <Row key={e.path} entry={e} depth={0} project={project} seat={seat} onOpen={onOpen} onRefresh={refresh} openPath={openPath} />)}
    </div>
  );
}