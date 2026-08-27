// The project's file tree, in the sidebar, with git state on every row.
//
// This exists for the operator Sasha named as the audience: a developer who wants to SEE and TOUCH
// the code rather than trust an agent's summary of it. So the tree's job is not navigation, it is
// WITNESS — which files the crew is touching, right now, without asking anyone.
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File as FileIcon, Folder } from "lucide-react";
import { projectFiles, statusColor, statusLabel, type FileEntry } from "./fileApi";

const POLL_MS = 10_000;

function Row({ entry, depth, project, seat, onOpen }: { entry: FileEntry; depth: number; project: string; seat: string | null; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<FileEntry[] | null>(null);

  // Children load when the folder opens, and refresh on the same cadence as the root while it
  // stays open — a closed folder costs nothing.
  useEffect(() => {
    if (!open || !entry.dir) return;
    let alive = true;
    const load = () => { projectFiles(project, entry.path, seat ?? undefined).then(k => { if (alive) setKids(k); }).catch(() => {}); };
    load();
    const iv = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [open, entry.dir, entry.path, project, seat]);

  const color = statusColor(entry.status);
  return (
    <>
      <button
        type="button"
        onClick={() => (entry.dir ? setOpen(o => !o) : onOpen(entry.path))}
        title={entry.status ? `${entry.path} — ${statusLabel(entry.status)}` : entry.path}
        className="flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[12px] text-tr-muted hover:bg-white/[0.04]"
        style={{ paddingLeft: 6 + depth * 11 }}
      >
        {entry.dir
          ? (open ? <ChevronDown size={12} strokeWidth={2} className="shrink-0" /> : <ChevronRight size={12} strokeWidth={2} className="shrink-0" />)
          : <span className="w-3 shrink-0" />}
        {entry.dir
          ? <Folder size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
          : <FileIcon size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />}
        <span className="min-w-0 flex-1 truncate" style={color ? { color } : undefined}>{entry.name}</span>
        {/* The WORD, never git's code. "??" is porcelain's way of saying untracked, which means
            nothing to someone watching their crew work — and showing an internal id where a name
            belongs is exactly the habit this codebase bans elsewhere. */}
        {entry.status && (
          <span className="shrink-0 text-[10px]" style={{ color }}>{statusLabel(entry.status)}</span>
        )}
      </button>
      {open && kids?.map(k => <Row key={k.path} entry={k} depth={depth + 1} project={project} seat={seat} onOpen={onOpen} />)}
    </>
  );
}

export function FileTree({ project, seat, onOpen }: { project: string; seat: string | null; onOpen: (path: string) => void }) {
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    projectFiles(project, undefined, seat ?? undefined)
      .then(r => { setRoots(r); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [project, seat]);

  useEffect(() => {
    setRoots(null);
    load();
    const iv = setInterval(load, POLL_MS);
    return () => clearInterval(iv);
  }, [load]);

  // A project whose code is not on this machine is a normal state, not a failure: cards can point
  // at repos that live on someone else's laptop. Say so instead of showing an empty tree.
  if (error) {
    return <div className="px-3 py-1.5 text-[11.5px] leading-relaxed text-tr-muted">{error}</div>;
  }
  if (!roots) {
    return <div className="px-3 py-1.5 text-[11.5px] text-tr-muted">reading…</div>;
  }
  return (
    <div className="flex flex-col">
      {roots.map(e => <Row key={e.path} entry={e} depth={0} project={project} seat={seat} onOpen={onOpen} />)}
    </div>
  );
}
