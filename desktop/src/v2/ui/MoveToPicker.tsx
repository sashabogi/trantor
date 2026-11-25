// A small picker for Move to (#14106): walk the project's folders one level at a time, then move here.
import { useEffect, useState } from "react";
import { ChevronLeft, Folder } from "lucide-react";
import { projectFiles, type FileEntry } from "../../features/code/fileApi";
import { Button } from "./Button";
import { parentOf } from "./explorerOps";

export function MoveToPicker({ project, seat, entry, onPick, onClose }: {
  project: string; seat: string | null; entry: FileEntry; onPick: (dir: string) => void; onClose: () => void;
}) {
  const [dir, setDir] = useState(parentOf(entry.path));
  const [folders, setFolders] = useState<FileEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    setFolders(null);
    projectFiles(project, dir || undefined, seat ?? undefined)
      .then(list => { if (alive) setFolders(list.filter(e => e.dir && e.path !== entry.path)); })
      .catch(() => { if (alive) setFolders([]); });
    return () => { alive = false; };
  }, [project, seat, dir, entry.path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-label={`Move ${entry.name} to`} className="m-2 flex flex-col gap-1 rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-2 text-v2-body">
      <div className="flex items-center gap-1 text-[var(--v2-text-2)]">
        <button type="button" aria-label="Up one folder" title="Up one folder" disabled={dir === ""} onClick={() => setDir(parentOf(dir))}
          className="v2-hover inline-flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent text-inherit disabled:opacity-40">
          <ChevronLeft size={13} aria-hidden />
        </button>
        <span className="v2-mono min-w-0 flex-1 truncate" data-current>{dir || "project root"}</span>
      </div>
      <div className="flex max-h-[200px] flex-col overflow-y-auto">
        {folders === null && <span className="px-2 py-1 text-[var(--v2-muted)]">reading</span>}
        {folders?.length === 0 && <span className="px-2 py-1 text-[var(--v2-muted)]">No folders here</span>}
        {folders?.map(f => (
          <button key={f.path} type="button" data-folder={f.path} onClick={() => setDir(f.path)}
            className="v2-hover flex items-center gap-1.5 rounded border-0 bg-transparent px-2 py-1 text-left text-v2-body text-[var(--v2-text-2)]">
            <Folder size={12} aria-hidden className="shrink-0 opacity-70" />
            <span className="truncate">{f.name}</span>
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onPick(dir)} disabledReason={dir === parentOf(entry.path) ? "It is already in this folder" : null}>Move here</Button>
      </div>
    </div>
  );
}
