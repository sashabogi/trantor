// The Search sidebar view (#14074): file names (the old behaviour) or text inside files.
import { useEffect, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight } from "lucide-react";
import { searchFiles } from "../../../features/code/fileApi";
import { IconButton } from "../../ui/IconButton";
import { Seg } from "../../ui/Seg";
import { searchText, type TextMatch, type TextSearchResult } from "./textSearch";

type Mode = "text" | "files";
export type OpenAt = (path: string, line?: number, column?: number) => void;
type PaneProps = { project: string; scope: string | null; onOpen: OpenAt };

const INPUT = "m-3 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-1.5 text-[12px] text-[var(--v2-text)] outline-none focus:border-[var(--v2-accent)]";
const MODES = [{ value: "text", label: "Text" }, { value: "files", label: "Files" }] as const;

function FileNameSearch({ project, scope, onOpen }: PaneProps) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    let alive = true;
    searchFiles(project, q, scope ?? undefined).then(h => { if (alive) setHits(h); }).catch(() => { if (alive) setHits([]); });
    return () => { alive = false; };
  }, [project, scope, q]);
  return (
    <>
      <label htmlFor="v2-file-search" className="sr-only">Search files</label>
      <input id="v2-file-search" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Find a file by name" className={INPUT} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hits.map(h => <button key={h} type="button" onClick={() => onOpen(h)} className="v2-hover v2-mono block w-full truncate border-0 bg-transparent px-3 py-1 text-left text-[11.5px] text-[var(--v2-text-2)]">{h}</button>)}
        {q.trim() && hits.length === 0 && <div className="px-3 text-[12px] text-[var(--v2-muted)]">No file matches.</div>}
      </div>
    </>
  );
}

/** The line, trimmed, with the matched substring wrapped in a mark. The column is in the untrimmed line. */
function Highlighted({ match, query }: { match: TextMatch; query: string }) {
  const text = match.text.trimStart();
  const start = match.column - 1 - (match.text.length - text.length);
  if (start < 0 || start + query.length > text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-[2px] bg-[var(--v2-accent-soft)] text-[var(--v2-accent-hi)]">{text.slice(start, start + query.length)}</mark>
      {text.slice(start + query.length)}
    </>
  );
}

type Found = { query: string; data: TextSearchResult };

function useTextSearch(project: string, scope: string | null, query: string, caseSensitive: boolean) {
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!query.trim()) { setFound(null); setError(null); return; }
    let alive = true;
    // Debounce, and ignore an answer that a newer query has already replaced.
    const timer = setTimeout(() => {
      searchText(project, query, scope ?? undefined, caseSensitive)
        .then(data => { if (alive) { setFound({ query, data }); setError(null); } })
        .catch(e => { if (alive) { setFound(null); setError(e instanceof Error ? e.message : String(e)); } });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [project, scope, query, caseSensitive]);
  return { found, error };
}

function Results({ found, onOpen }: { found: Found; onOpen: OpenAt }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const { data, query } = found;
  if (data.files.length === 0) return <div className="px-3 text-[12px] text-[var(--v2-muted)]">No results.</div>;
  const toggle = (p: string) => setClosed(c => { const n = new Set(c); if (!n.delete(p)) n.add(p); return n; });
  return (
    <>
      <div className="px-3 pb-1 text-[11px] text-[var(--v2-muted)]">
        {data.total} {data.total === 1 ? "result" : "results"} in {data.files.length} {data.files.length === 1 ? "file" : "files"}
        {data.truncated && <div>Showing the first 2,000 results</div>}
      </div>
      {data.files.map(f => {
        const shut = closed.has(f.path);
        return (
          <div key={f.path}>
            <button type="button" aria-expanded={!shut} onClick={() => toggle(f.path)} title={f.path}
              className="v2-hover flex w-full items-center gap-1 border-0 bg-transparent px-2 py-1 text-left text-[11.5px] text-[var(--v2-text)]">
              {shut ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
              <span className="v2-mono min-w-0 flex-1 truncate">{f.path}</span>
              <span className="shrink-0 text-[10.5px] text-[var(--v2-muted)]">{f.matches.length}</span>
            </button>
            {!shut && f.matches.map(m => (
              <button key={`${m.line}:${m.column}`} type="button" onClick={() => onOpen(f.path, m.line, m.column)} title={`${f.path}:${m.line}`}
                className="v2-hover flex w-full items-baseline gap-2 border-0 bg-transparent py-0.5 pl-6 pr-3 text-left text-[11.5px] text-[var(--v2-text-2)]">
                <span className="v2-mono w-8 shrink-0 text-right text-[10.5px] text-[var(--v2-muted)]">{m.line}</span>
                <span className="v2-mono min-w-0 flex-1 truncate"><Highlighted match={m} query={query} /></span>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}

function TextSearch({ project, scope, onOpen }: PaneProps) {
  const [q, setQ] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const { found, error } = useTextSearch(project, scope, q, caseSensitive);
  return (
    <>
      <div className="flex items-center gap-1 pr-3">
        <label htmlFor="v2-text-search" className="sr-only">Search text</label>
        <input id="v2-text-search" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search in files" className={`${INPUT} min-w-0 flex-1`} />
        <IconButton label="Match case" title="Match case" size={26} aria-pressed={caseSensitive} onClick={() => setCaseSensitive(v => !v)}
          className={caseSensitive ? "!bg-[var(--v2-accent-soft)] !text-[var(--v2-accent-hi)]" : ""}>
          <CaseSensitive size={15} aria-hidden />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {error && <div role="alert" className="px-3 text-[12px] text-[var(--v2-bad)]">{error}</div>}
        {!error && found && q.trim() && <Results found={found} onOpen={onOpen} />}
      </div>
    </>
  );
}

export function SearchPane(p: PaneProps) {
  const [mode, setMode] = useState<Mode>("text");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pt-3"><Seg label="Search mode" options={MODES} value={mode} onChange={setMode} /></div>
      {mode === "text" ? <TextSearch {...p} /> : <FileNameSearch {...p} />}
    </div>
  );
}
