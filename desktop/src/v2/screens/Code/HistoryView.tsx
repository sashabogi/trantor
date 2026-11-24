// The History column (#13988): search, scope, and commit rows with lane dot, seat avatar, card and branch.
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { Chip } from "../../ui/Chip";
import { seatLabel } from "../../ui/identity";
import { filterHistory, parseSearch, type HistoryRow } from "./model";
import { NotWiredBlock } from "./parts";

export const UNLANDED_KEY = "unlanded";

function Lane({ first, last }: { first: boolean; last: boolean }) {
  return (
    <span aria-hidden className="relative flex w-3 shrink-0 justify-center self-stretch">
      <span className="absolute w-px bg-[var(--v2-edge-2)]" style={{ top: first ? "50%" : 0, bottom: last ? "50%" : 0 }} />
      <span className="relative mt-[13px] h-[9px] w-[9px] rounded-full border-2 border-[var(--v2-panel)]" style={{ background: first ? "var(--v2-accent)" : "var(--v2-track)" }} />
    </span>
  );
}

function Row({ row, branch, first, last, on, onSelect }: { row: HistoryRow; branch: string | null; first: boolean; last: boolean; on: boolean; onSelect: () => void }) {
  const who = row.seat ?? row.author;
  return (
    <button type="button" onClick={onSelect} aria-pressed={on} data-sha={row.sha}
      className={`flex w-full items-stretch gap-2 border-0 px-3 text-left ${on ? "bg-[var(--v2-accent-soft)]" : "bg-transparent hover:bg-[var(--v2-raised)]"}`}>
      <Lane first={first} last={last} />
      <span className="flex min-w-0 flex-1 flex-col gap-1 py-2">
        <span className="truncate text-[12.5px] font-medium text-[var(--v2-text)]">{row.subject}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--v2-muted)]">
          <Avatar name={who} size={14} />
          <span className="truncate">{seatLabel(who)}</span>
          {row.card !== null && <span className="v2-mono text-[var(--v2-accent)]">#{row.card}</span>}
          <span className="shrink-0">· {row.when}</span>
          {first && branch && <Chip mono>{branch}</Chip>}
        </span>
      </span>
    </button>
  );
}

export function HistoryView({ rows, branch, unlanded, selected, onSelect, seatBacked }: {
  rows: HistoryRow[]; branch: string | null; unlanded: number | null; selected: string | null; onSelect: (key: string) => void; seatBacked: boolean;
}) {
  const [query, setQuery] = useState("");
  const result = useMemo(() => filterHistory(rows, parseSearch(query)), [rows, query]);
  return (
    <div className="flex w-[320px] shrink-0 flex-col border-r border-[var(--v2-edge)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--v2-edge)] px-3 py-2">
        <label htmlFor="v2-history-search" className="sr-only">Search history</label>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2 py-1">
          <Search size={12} aria-hidden className="shrink-0 text-[var(--v2-muted)]" />
          <input id="v2-history-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="text, author:, file:, seat:, card:"
            className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[var(--v2-text)] outline-none" />
        </div>
        <div role="group" aria-label="History scope" className="flex shrink-0 text-[11px]">
          <button type="button" disabled title="History reads the checked-out branch only. Other branches need a git log command." className="rounded-l-md border border-[var(--v2-edge-2)] bg-transparent px-1.5 py-1 text-[var(--v2-muted)] disabled:opacity-50">All</button>
          <button type="button" aria-pressed title="The checked-out branch" className="rounded-r-md border border-l-0 border-[var(--v2-edge-2)] bg-[var(--v2-hover)] px-1.5 py-1 text-[var(--v2-text)]">Current branch</button>
        </div>
      </div>
      {result.fileUnsupported && <div className="border-b border-[var(--v2-edge)] px-3 py-1.5 text-[11px] text-[var(--v2-warn)]">file: is ignored. The log has no per-commit file lists yet.</div>}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" role="group" aria-label="Commits">
        {!seatBacked && <div className="p-3"><NotWiredBlock title="History is not readable for the checkout" line="Reading the project checkout's log needs a git log command. Pick a seat in the branch picker to read its branch." /></div>}
        {seatBacked && unlanded ? (
          <button type="button" onClick={() => onSelect(UNLANDED_KEY)} aria-pressed={selected === UNLANDED_KEY} data-sha={UNLANDED_KEY}
            className={`border-0 border-b border-[var(--v2-edge)] px-3 py-2 text-left text-[12px] ${selected === UNLANDED_KEY ? "bg-[var(--v2-accent-soft)]" : "bg-transparent hover:bg-[var(--v2-raised)]"}`}>
            <span className="font-medium text-[var(--v2-text)]">{unlanded} {unlanded === 1 ? "commit" : "commits"} not on main yet</span>
            <span className="block text-[11px] text-[var(--v2-muted)]">The whole branch against its merge base</span>
          </button>
        ) : null}
        {seatBacked && result.rows.length === 0 && <div className="px-3 py-4 text-[12px] text-[var(--v2-muted)]">{rows.length === 0 ? "No commits yet." : "No commits match."}</div>}
        {result.rows.map((r, i) => <Row key={r.sha} row={r} branch={branch} first={i === 0} last={i === result.rows.length - 1} on={selected === r.sha} onSelect={() => onSelect(r.sha)} />)}
      </div>
      {seatBacked && <div className="border-t border-[var(--v2-edge)] px-3 py-1.5 text-[10.5px] text-[var(--v2-muted)]">Latest {rows.length} commits on this branch</div>}
    </div>
  );
}
