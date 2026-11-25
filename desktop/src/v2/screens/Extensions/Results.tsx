// Middle column: search box, sort chips, live Open VSX result rows (#13993).
import { useState } from "react";
import type { SearchState } from "./hooks";
import type { Ext, SortKey } from "./openvsx";
import { Button, Chip } from "../..";
import { monogram } from "../../ui/identity";

const SORTS: { id: SortKey; label: string }[] = [
  { id: "relevance", label: "Relevant" },
  { id: "downloadCount", label: "Most installed" },
  { id: "timestamp", label: "Recently updated" },
  { id: "verified", label: "Verified publishers" },
];

export const INSTALL_REASON = "Installs open after the extension-host spike (#13985)";

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} k`;
  return String(n);
}

export function IconTile({ ext, size = 36 }: { ext: Ext; size?: number }) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size };
  if (ext.iconUrl && !broken) {
    return <img src={ext.iconUrl} alt="" style={box} onError={() => setBroken(true)} className="shrink-0 rounded-lg bg-[var(--v2-panel-2)] object-cover" />;
  }
  return (
    <span aria-hidden style={box} className="v2-mono flex shrink-0 items-center justify-center rounded-lg bg-[var(--v2-panel-2)] text-v2-small text-[var(--v2-text-2)]">
      {monogram(ext.displayName)}
    </span>
  );
}

type Props = {
  query: string; onQuery: (q: string) => void; sort: SortKey; onSort: (s: SortKey) => void;
  state: SearchState; selectedId: string | null; onSelect: (e: Ext) => void;
};

export function Results({ query, onQuery, sort, onSort, state, selectedId, onSelect }: Props) {
  return (
    <section aria-label="Browse" className="flex min-w-0 flex-1 flex-col overflow-y-auto border-r border-[var(--v2-edge)]">
      <div className="flex flex-col gap-2 border-b border-[var(--v2-edge)] p-3">
        <label htmlFor="ext-search" className="sr-only">Search extensions and tools</label>
        <input id="ext-search" type="search" value={query} onChange={e => onQuery(e.target.value)} placeholder="Search Open VSX extensions"
          className="rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel)] px-3 py-2 text-v2-base text-[var(--v2-text)] outline-none" />
        <div className="flex flex-wrap gap-1.5">
          {SORTS.map(s => (
            <button key={s.id} type="button" aria-pressed={sort === s.id} onClick={() => onSort(s.id)}
              className={`rounded-md border px-2.5 py-1 text-v2-body ${sort === s.id ? "border-[var(--v2-accent)] bg-[var(--v2-accent-soft)] text-[var(--v2-accent-hi)]" : "border-[var(--v2-edge)] text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <Body state={state} selectedId={selectedId} onSelect={onSelect} />
      <p className="m-3 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)] p-2.5 text-v2-body leading-snug text-[var(--v2-muted)]">
        Looking for Pylance, C/C++ or Remote-SSH? They are Microsoft-only and not on Open VSX. Open alternatives: basedpyright, clangd, Open Remote SSH.
      </p>
    </section>
  );
}

function Body({ state, selectedId, onSelect }: Pick<Props, "state" | "selectedId" | "onSelect">) {
  if (state.status === "loading") return <div role="status" className="p-4 text-v2-base text-[var(--v2-muted)]">Searching Open VSX...</div>;
  if (state.status === "error") {
    return <div role="alert" className="m-3 rounded-lg border border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] p-3 text-v2-base text-[var(--v2-warn)]">Open VSX could not be read: {state.message}. Check the network and try again.</div>;
  }
  const { items, total } = state.data;
  if (items.length === 0) return <div className="p-4 text-v2-base text-[var(--v2-muted)]">No extensions match that search.</div>;
  return (
    <>
      <div className="px-3 pt-2.5 text-v2-body text-[var(--v2-muted)]">{total.toLocaleString("en-US")} results on Open VSX</div>
      <ul className="m-0 flex list-none flex-col gap-1 p-2">
        {items.map(e => <Row key={e.id} ext={e} selected={e.id === selectedId} onSelect={onSelect} />)}
      </ul>
    </>
  );
}

function Row({ ext, selected, onSelect }: { ext: Ext; selected: boolean; onSelect: (e: Ext) => void }) {
  return (
    <li className={`flex items-center gap-3 rounded-lg border p-2.5 ${selected ? "border-[var(--v2-accent)] bg-[var(--v2-panel-2)]" : "border-transparent hover:bg-[var(--v2-panel)]"}`}>
      <button type="button" aria-label={`Open ${ext.displayName}`} title={`Open ${ext.displayName}`} onClick={() => onSelect(ext)}
        className="flex min-w-0 flex-1 items-start gap-3 bg-transparent p-0 text-left text-[var(--v2-text)]">
        <IconTile ext={ext} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2"><span className="truncate text-v2-base font-semibold">{ext.displayName}</span><Chip>Editor</Chip></span>
          <span className="text-v2-body text-[var(--v2-muted)]">
            {ext.namespace}{ext.verified ? " (verified)" : ""} · {ext.version} · {formatCount(ext.downloads)} installs · {ext.rating === null ? "no rating" : `${ext.rating.toFixed(1)} stars`}
          </span>
          <span className="truncate text-v2-body text-[var(--v2-text-2)]">{ext.description}</span>
        </span>
      </button>
      <Button variant="primary" disabledReason={INSTALL_REASON}>Install</Button>
    </li>
  );
}
