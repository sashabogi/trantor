// History search runs path and full-message filters in git; refs stay attached to each commit row.
import { useEffect, useMemo, useState } from "react";
import { Clock, Search } from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { Chip } from "../../ui/Chip";
import { IconButton } from "../../ui/IconButton";
import { seatLabel } from "../../ui/identity";
import { filterHistory, parseSearch, toRow, type HistoryRow } from "./model";
import { scopeHistory } from "./scopeGitApi";

export const UNLANDED_KEY = "unlanded";

function Lane({ first, last }: { first: boolean; last: boolean }) {
  return (
    <span aria-hidden className="relative flex w-3 shrink-0 justify-center self-stretch">
      <span className="absolute w-px bg-[var(--v2-edge-2)]" style={{ top: first ? "50%" : 0, bottom: last ? "50%" : 0 }} />
      <span className="relative mt-[13px] h-[9px] w-[9px] rounded-full border-2 border-[var(--v2-panel)]" style={{ background: first ? "var(--v2-accent)" : "var(--v2-track)" }} />
    </span>
  );
}

/** Only the real tip of the checked out branch may borrow its name; a filtered or git-read list brings its own refs. */
export function isBranchTip(index: number, native: boolean, row: HistoryRow, source: HistoryRow[]): boolean {
  return index === 0 && !native && row === source[0];
}

function Row({ row, branch, first, tip, last, on, onSelect }: { row: HistoryRow; branch: string | null; first: boolean; tip: boolean; last: boolean; on: boolean; onSelect: () => void }) {
  const who = row.seat ?? row.author;
  const refs = row.refs.length > 0 ? row.refs : tip && branch ? [branch] : [];
  return (
    <button type="button" onClick={onSelect} aria-pressed={on} data-sha={row.sha}
      className={`flex w-full items-stretch gap-2 border-0 px-3 text-left ${on ? "bg-[var(--v2-accent-soft)]" : "bg-transparent hover:bg-[var(--v2-raised)]"}`}>
      <Lane first={first} last={last} />
      <span className="flex min-w-0 flex-1 flex-col gap-1 py-2">
        <span className="truncate text-[12.5px] font-medium text-[var(--v2-text)]">{row.subject}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-[var(--v2-muted)]">
          <Avatar name={who} size={14} />
          <span className="truncate">{seatLabel(who)}</span>
          {row.card !== null && <span className="v2-mono text-[var(--v2-accent)]">#{row.card}</span>}
          <span className="shrink-0">· {row.when}</span>
          {refs.map(ref => <Chip key={ref} mono>{ref}</Chip>)}
        </span>
      </span>
    </button>
  );
}

export function FileHistoryControl({ project, scope, path }: { project: string; scope: string | null; path: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    scopeHistory(project, scope, { all: false, file: path, limit: 200 })
      .then(entries => { if (alive) setRows(entries.map(entry => toRow(entry, { seats: [], branch: null }))); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, project, scope, path]);
  return (
    <span className="relative inline-flex shrink-0">
      <IconButton label={`File history for ${path}`} title="Commits that touched this file" size={24} aria-pressed={open} onClick={() => setOpen(value => !value)}><Clock size={13} aria-hidden /></IconButton>
      {open && (
        <div role="dialog" aria-label={`File history: ${path}`} className="absolute right-0 top-full z-30 max-h-[360px] w-[380px] overflow-y-auto rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel)] shadow-xl">
          <div className="border-b border-[var(--v2-edge)] px-3 py-2 text-[11.5px] font-semibold text-[var(--v2-text)]">File history <span className="v2-mono font-normal text-[var(--v2-muted)]">{path}</span></div>
          {loading && <div className="px-3 py-3 text-[11.5px] text-[var(--v2-muted)]">Reading file history</div>}
          {error && <div role="alert" className="px-3 py-3 text-[11.5px] text-[var(--v2-bad)]">{error}</div>}
          {!loading && !error && rows.length === 0 && <div className="px-3 py-3 text-[11.5px] text-[var(--v2-muted)]">No commits touch this file.</div>}
          {!loading && rows.map(row => (
            <div key={row.sha} className="border-b border-[var(--v2-edge)] px-3 py-2 last:border-b-0">
              <div className="truncate text-[12px] text-[var(--v2-text)]">{row.subject}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-[var(--v2-muted)]"><span>{row.author}</span><span>{row.when}</span><span className="v2-mono">{row.sha.slice(0, 8)}</span></div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

export function HistoryView({ rows, branch, unlanded, selected, onSelect, seatBacked, project, scope, seats, onRows }: {
  rows: HistoryRow[]; branch: string | null; unlanded: number | null; selected: string | null; onSelect: (key: string) => void; seatBacked: boolean;
  project: string; scope: string | null; seats: readonly string[]; onRows: (rows: HistoryRow[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [nativeRows, setNativeRows] = useState<HistoryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parseSearch(query), [query]);
  const native = all || !!parsed.file || !!parsed.message;
  const ctx = useMemo(() => ({ seats, branch }), [seats, branch]);
  useEffect(() => {
    let alive = true;
    if (!native) {
      setNativeRows(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    scopeHistory(project, scope, { all, file: parsed.file, message: parsed.message, limit: 200 })
      .then(entries => { if (alive) setNativeRows(entries.map(entry => toRow(entry, ctx))); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [native, all, parsed.file, parsed.message, project, scope, ctx]);
  const sourceRows = native ? nativeRows ?? [] : rows;
  const result = useMemo(() => filterHistory(sourceRows, parsed), [sourceRows, parsed]);
  useEffect(() => { onRows(sourceRows); }, [sourceRows, onRows]);
  return (
    <div className="flex w-[320px] shrink-0 flex-col border-r border-[var(--v2-edge)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--v2-edge)] px-3 py-2">
        <label htmlFor="v2-history-search" className="sr-only">Search history</label>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2 py-1">
          <Search size={12} aria-hidden className="shrink-0 text-[var(--v2-muted)]" />
          <input id="v2-history-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="text, author:, file:, message:"
            className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[var(--v2-text)] outline-none" />
        </div>
        <div role="group" aria-label="History scope" className="flex shrink-0 text-[11px]">
          <button type="button" aria-pressed={all} title="Search every local and remote branch and tag" onClick={() => setAll(true)} className={`rounded-l-md border border-[var(--v2-edge-2)] px-1.5 py-1 ${all ? "bg-[var(--v2-hover)] text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-muted)]"}`}>All</button>
          <button type="button" aria-pressed={!all} title="The checked-out branch" onClick={() => setAll(false)} className={`rounded-r-md border border-l-0 border-[var(--v2-edge-2)] px-1.5 py-1 ${!all ? "bg-[var(--v2-hover)] text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-muted)]"}`}>Current branch</button>
        </div>
      </div>
      {error && <div role="alert" className="border-b border-[var(--v2-edge)] px-3 py-1.5 text-[11px] text-[var(--v2-bad)]">{error}</div>}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" role="group" aria-label="Commits">
        {!native && seatBacked && unlanded ? (
          <button type="button" onClick={() => onSelect(UNLANDED_KEY)} aria-pressed={selected === UNLANDED_KEY} data-sha={UNLANDED_KEY}
            className={`border-0 border-b border-[var(--v2-edge)] px-3 py-2 text-left text-[12px] ${selected === UNLANDED_KEY ? "bg-[var(--v2-accent-soft)]" : "bg-transparent hover:bg-[var(--v2-raised)]"}`}>
            <span className="font-medium text-[var(--v2-text)]">{unlanded} {unlanded === 1 ? "commit" : "commits"} not on main yet</span>
            <span className="block text-[11px] text-[var(--v2-muted)]">The whole branch against its merge base</span>
          </button>
        ) : null}
        {loading && <div className="px-3 py-4 text-[12px] text-[var(--v2-muted)]">Reading commits</div>}
        {!loading && result.length === 0 && <div className="px-3 py-4 text-[12px] text-[var(--v2-muted)]">{sourceRows.length === 0 ? "No commits yet." : "No commits match."}</div>}
        {!loading && result.map((r, i) => <Row key={r.sha} row={r} branch={branch} first={i === 0} tip={isBranchTip(i, native, r, sourceRows)} last={i === result.length - 1} on={selected === r.sha} onSelect={() => onSelect(r.sha)} />)}
      </div>
      <div className="border-t border-[var(--v2-edge)] px-3 py-1.5 text-[10.5px] text-[var(--v2-muted)]">Latest {sourceRows.length} commits {all ? "across all branches" : "on this branch"}</div>
    </div>
  );
}
