// The Search sidebar view (#14074): file names (the old behaviour) or text inside files. #14104:
// regular expression, whole word and include/exclude options, and replace (one result, one file,
// all) behind a "here is what it will do" confirmation.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Ellipsis, Regex, Replace, WholeWord } from "lucide-react";
import { searchFiles } from "../../../features/code/fileApi";
import { IconButton } from "../../ui/IconButton";
import { Seg } from "../../ui/Seg";
import { replaceText, searchText, type FileMatches, type ReplaceAt, type TextMatch, type TextSearchResult } from "./textSearch";

type Mode = "text" | "files";
export type OpenAt = (path: string, line?: number, column?: number) => void;
type PaneProps = { project: string; scope: string | null; onOpen: OpenAt; onMutated: () => void };

const INPUT = "m-3 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-1.5 text-[12px] text-[var(--v2-text)] outline-none focus:border-[var(--v2-accent)]";
const MODES = [{ value: "text", label: "Text" }, { value: "files", label: "Files" }] as const;
const ON = "!bg-[var(--v2-accent-soft)] !text-[var(--v2-accent-hi)]";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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

/** The line, trimmed, with the matched substring wrapped in a mark. The column is in the untrimmed
 *  line; `markLen` (the native side knows it for every mode) falls back to the query's length. */
function Highlighted({ match, query }: { match: TextMatch; query: string }) {
  const text = match.text.trimStart();
  const start = match.column - 1 - (match.text.length - text.length);
  const len = match.markLen ?? query.length;
  if (start < 0 || start + len > text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-[2px] bg-[var(--v2-accent-soft)] text-[var(--v2-accent-hi)]">{text.slice(start, start + len)}</mark>
      {text.slice(start + len)}
    </>
  );
}

type Found = { query: string; data: TextSearchResult };
type Options = { caseSensitive: boolean; regex: boolean; wholeWord: boolean; include: string; exclude: string };

function useTextSearch(project: string, scope: string | null, query: string, opts: Options, nonce: number) {
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!query.trim()) { setFound(null); setError(null); return; }
    // An invalid expression runs nothing: the browser's check catches the common broken patterns
    // (unbalanced brackets) before an IPC round trip; anything else the native error reports.
    if (opts.regex) {
      try { new RegExp(query); } catch (e) { setFound(null); setError(e instanceof Error ? e.message : String(e)); return; }
    }
    let alive = true;
    // Debounce, and ignore an answer that a newer query has already replaced.
    const timer = setTimeout(() => {
      searchText(project, query, scope ?? undefined, opts)
        .then(data => { if (alive) { setFound({ query, data }); setError(null); } })
        .catch(e => { if (alive) { setFound(null); setError(e instanceof Error ? e.message : String(e)); } });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [project, scope, query, opts, nonce]);
  return { found, error };
}

type ReplaceAction = { kind: "one"; path: string; match: TextMatch } | { kind: "file"; path: string } | { kind: "all" };

function Results({ found, onOpen, onReplace }: {
  found: Found; onOpen: OpenAt; onReplace: (action: ReplaceAction) => void;
}) {
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
            <div className="flex items-center pr-2">
              <button type="button" aria-expanded={!shut} onClick={() => toggle(f.path)} title={f.path}
                className="v2-hover flex min-w-0 flex-1 items-center gap-1 border-0 bg-transparent px-2 py-1 text-left text-[11.5px] text-[var(--v2-text)]">
                {shut ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
                <span className="v2-mono min-w-0 flex-1 truncate">{f.path}</span>
                <span className="shrink-0 text-[10.5px] text-[var(--v2-muted)]">{f.matches.length}</span>
              </button>
              <IconButton label={`Replace all in ${f.path}`} title={`Replace all in ${f.path}`} size={20} onClick={() => onReplace({ kind: "file", path: f.path })}>
                <Replace size={11} aria-hidden />
              </IconButton>
            </div>
            {!shut && f.matches.map(m => (
              <div key={`${m.line}:${m.column}`} className="flex items-center pr-2">
                <button type="button" onClick={() => onOpen(f.path, m.line, m.column)} title={`${f.path}:${m.line}`}
                  className="v2-hover flex min-w-0 flex-1 items-baseline gap-2 border-0 bg-transparent py-0.5 pl-6 pr-3 text-left text-[11.5px] text-[var(--v2-text-2)]">
                  <span className="v2-mono w-8 shrink-0 text-right text-[10.5px] text-[var(--v2-muted)]">{m.line}</span>
                  <span className="v2-mono min-w-0 flex-1 truncate"><Highlighted match={m} query={query} /></span>
                </button>
                <IconButton label={`Replace this result in ${f.path}`} title={`Replace this result in ${f.path}`} size={20} onClick={() => onReplace({ kind: "one", path: f.path, match: m })}>
                  <Replace size={11} aria-hidden />
                </IconButton>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

/** The one click that does the writing: runs `replace_text` per target file, then the caller
 *  refreshes the results and the source control view. A refused file surfaces its error; others
 *  that already ran stay replaced — the refresh shows the truth. */
async function applyReplace(args: {
  project: string; scope: string | null; q: string; replacement: string; opts: Options;
  action: ReplaceAction; data: TextSearchResult;
}): Promise<Note | null> {
  const targets: { file: FileMatches; only?: ReplaceAt }[] = [];
  if (args.action.kind === "all") {
    for (const file of args.data.files) targets.push({ file });
  } else {
    for (const file of args.data.files) {
      if (file.path !== args.action.path) continue;
      targets.push({ file, only: args.action.kind === "one" ? { line: args.action.match.line, column: args.action.match.column } : undefined });
    }
  }
  let replaced = 0;
  let files = 0;
  let firstError: string | null = null;
  for (const { file, only } of targets) {
    try {
      const r = await replaceText(args.project, file.path, args.q, args.replacement, args.scope ?? undefined, args.opts, { mtimeMs: file.mtimeMs, bytes: file.bytes }, only);
      replaced += r.replaced;
      files += 1;
    } catch (e) {
      firstError ??= e instanceof Error ? e.message : String(e);
    }
  }
  if (firstError) return { kind: "bad", text: firstError };
  return files > 0 ? { kind: "ok", text: `Replaced ${plural(replaced, "result")} in ${plural(files, "file")}` } : null;
}

type Note = { kind: "ok" | "bad"; text: string };

type Toggles = { caseSensitive: boolean; useRegex: boolean; wholeWord: boolean; showGlobs: boolean };
const TOGGLES_OFF: Toggles = { caseSensitive: false, useRegex: false, wholeWord: false, showGlobs: false };

function replacePreview(data: TextSearchResult, action: ReplaceAction): string | null {
  if (action.kind === "all") return `Replace ${plural(data.total, "result")} in ${plural(data.files.length, "file")}`;
  const f = data.files.find(x => x.path === action.path);
  if (!f) return null;
  return `Replace ${plural(action.kind === "one" ? 1 : f.matches.length, "result")} in ${f.path}`;
}

type BoxesProps = {
  q: string; onQ: (v: string) => void; replacement: string; onReplacement: (v: string) => void;
  include: string; onInclude: (v: string) => void; exclude: string; onExclude: (v: string) => void;
  on: Toggles; flip: (key: keyof Toggles) => void; canReplaceAll: boolean; onReplaceAll: () => void;
};

/** The search box with its option toggles, the replace box, and the include and exclude boxes. */
function SearchBoxes(p: BoxesProps) {
  const toggle = (key: keyof Toggles, label: string, icon: ReactNode) => (
    <IconButton label={label} title={label} size={26} aria-pressed={p.on[key]} onClick={() => p.flip(key)} className={p.on[key] ? ON : ""}>{icon}</IconButton>
  );
  return (
    <>
      <div className="flex items-center gap-1 pr-3">
        <label htmlFor="v2-text-search" className="sr-only">Search text</label>
        <input id="v2-text-search" autoFocus value={p.q} onChange={e => p.onQ(e.target.value)}
          placeholder={p.on.useRegex ? "Search with a regular expression" : "Search in files"} className={`${INPUT} min-w-0 flex-1`} />
        {toggle("caseSensitive", "Match case", <CaseSensitive size={15} aria-hidden />)}
        {toggle("useRegex", "Regular expression", <Regex size={15} aria-hidden />)}
        {toggle("wholeWord", "Whole word", <WholeWord size={15} aria-hidden />)}
        {toggle("showGlobs", "Files to include and exclude", <Ellipsis size={15} aria-hidden />)}
      </div>
      <div className="flex items-center gap-1 pr-3">
        <label htmlFor="v2-text-replace" className="sr-only">Replace with</label>
        <input id="v2-text-replace" value={p.replacement} onChange={e => p.onReplacement(e.target.value)}
          placeholder={p.on.useRegex ? "Replace with, $1 for a group" : "Replace with"} className={`${INPUT} min-w-0 flex-1`} />
        <IconButton label="Replace all" title="Replace all in every file" size={26} disabled={!p.canReplaceAll} onClick={p.onReplaceAll}>
          <Replace size={15} aria-hidden />
        </IconButton>
      </div>
      {p.on.showGlobs && (
        <div className="flex flex-col">
          <label htmlFor="v2-search-include" className="sr-only">Files to include</label>
          <input id="v2-search-include" value={p.include} onChange={e => p.onInclude(e.target.value)}
            placeholder="Files to include, e.g. *.ts, src/**" className={INPUT} />
          <label htmlFor="v2-search-exclude" className="sr-only">Files to exclude</label>
          <input id="v2-search-exclude" value={p.exclude} onChange={e => p.onExclude(e.target.value)}
            placeholder="Files to exclude, e.g. *.md, dist" className={INPUT} />
        </div>
      )}
    </>
  );
}

/** Says what a replace will do and waits for the click that does it. */
function ReplaceConfirm({ text, busy, onRun, onCancel }: { text: string | null; busy: boolean; onRun: () => void; onCancel: () => void }) {
  return (
    <div className="mx-3 mb-1 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-1.5 text-[12px]">
      <div className="text-[var(--v2-text)]">{text}</div>
      <div className="mt-1 flex gap-1">
        <button type="button" disabled={busy} onClick={onRun}
          className="rounded-md border-0 bg-[var(--v2-text)] px-2 py-0.5 text-[11.5px] font-semibold text-[var(--v2-ink)] hover:bg-[var(--v2-knob)] disabled:opacity-50">
          Replace
        </button>
        <button type="button" disabled={busy} onClick={onCancel}
          className="rounded-md border border-[var(--v2-edge-2)] bg-transparent px-2 py-0.5 text-[11.5px] text-[var(--v2-text-2)] disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

function TextSearch({ project, scope, onOpen, onMutated }: PaneProps) {
  const [q, setQ] = useState("");
  const [on, setOn] = useState<Toggles>(TOGGLES_OFF);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [replacement, setReplacement] = useState("");
  const [pending, setPending] = useState<ReplaceAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [nonce, setNonce] = useState(0);
  const opts = useMemo(
    () => ({ caseSensitive: on.caseSensitive, regex: on.useRegex, wholeWord: on.wholeWord, include, exclude }),
    [on.caseSensitive, on.useRegex, on.wholeWord, include, exclude],
  );
  const { found, error } = useTextSearch(project, scope, q, opts, nonce);
  // A new query or option invalidates what a pending replace was confirmed against.
  useEffect(() => { setPending(null); }, [project, scope, q, opts]);
  const data = found?.data ?? null;

  const run = async () => {
    if (!pending || !data || !q.trim()) return;
    setBusy(true);
    const outcome = await applyReplace({ project, scope, q, replacement, opts, action: pending, data });
    setPending(null);
    setBusy(false);
    setNote(outcome);
    setNonce(n => n + 1);
    onMutated();
  };

  return (
    <>
      <SearchBoxes q={q} onQ={setQ} replacement={replacement} onReplacement={setReplacement}
        include={include} onInclude={setInclude} exclude={exclude} onExclude={setExclude}
        on={on} flip={key => setOn(s => ({ ...s, [key]: !s[key] }))}
        canReplaceAll={!!data && data.total > 0 && !busy} onReplaceAll={() => setPending({ kind: "all" })} />
      {error && <div role="alert" className="px-3 pb-1 pt-1 text-[12px] text-[var(--v2-bad)]">{error}</div>}
      {note && (
        <div role={note.kind === "bad" ? "alert" : "status"}
          className={`px-3 pb-1 text-[12px] ${note.kind === "bad" ? "text-[var(--v2-bad)]" : "text-[var(--v2-muted)]"}`}>
          {note.text}
        </div>
      )}
      {pending && data && !error && (
        <ReplaceConfirm text={replacePreview(data, pending)} busy={busy} onRun={() => { void run(); }} onCancel={() => setPending(null)} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!error && found && q.trim() && <Results found={found} onOpen={onOpen} onReplace={setPending} />}
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
