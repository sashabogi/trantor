// Go to file (Cmd+P): file names of the active project, arrow keys and Enter, one file opens in a tab.
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { searchFiles } from "../../../features/code/fileApi";
import { NOTE, Picker, ROW, rowTone, useListKeys } from "./Picker";

const MAX_ROWS = 50;
type Search = (project: string, query: string) => Promise<string[]>;
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

function useFileHits(project: string, query: string, search: Search) {
  const [hits, setHits] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setFailed(false); return; }
    let alive = true;
    search(project, q)
      .then(found => { if (alive) { setHits(found.slice(0, MAX_ROWS)); setFailed(false); } })
      .catch(() => { if (alive) { setHits([]); setFailed(true); } });
    return () => { alive = false; };
  }, [project, query, search]);
  return { hits, failed };
}

export function QuickOpen({ project, onOpen, onClose, search = searchFiles }: {
  /** The active project, or "" when none is pinned. */
  project: string; onOpen: (path: string) => void; onClose: () => void; search?: Search;
}) {
  const [query, setQuery] = useState("");
  const { hits, failed } = useFileHits(project, query, search);
  const keys = useListKeys(hits.length, query, i => onOpen(hits[i]), onClose);
  if (!project) {
    return (
      <Picker label="Go to file" placeholder="Go to a file by name" query="" onQuery={() => undefined} onKeyDown={keys.onKeyDown} onClose={onClose}>
        <div role="status" className={NOTE}>Open a project first, then go to a file in it.</div>
      </Picker>
    );
  }
  return (
    <Picker label="Go to file" placeholder="Go to a file by name" query={query} onQuery={setQuery} onKeyDown={keys.onKeyDown} onClose={onClose}>
      <div role="listbox" aria-label="Files" className="max-h-[46vh] overflow-y-auto py-1.5">
        {hits.map((path, i) => (
          <button key={path} type="button" role="option" aria-selected={i === keys.sel} onClick={() => onOpen(path)} onMouseEnter={() => keys.setSel(i)}
            className={`${ROW} ${rowTone(i === keys.sel)}`}>
            <FileText size={13} aria-hidden className="shrink-0 text-[var(--v2-muted)]" />
            <span className="shrink-0">{base(path)}</span>
            <span className="v2-mono min-w-0 flex-1 truncate text-[11px] text-[var(--v2-muted)]">{dir(path)}</span>
          </button>
        ))}
        {!query.trim() && <div className={NOTE}>Type part of a file name.</div>}
        {failed && <div role="alert" className={NOTE}>The files could not be searched.</div>}
        {query.trim() && !failed && hits.length === 0 && <div className={NOTE}>No file matches.</div>}
      </div>
    </Picker>
  );
}
