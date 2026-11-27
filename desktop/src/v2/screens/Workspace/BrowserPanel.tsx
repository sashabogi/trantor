// The history / favorites / site permissions panel (artboard F4, #14516): one panel, three tabs,
// each read from its browser command. A history or favorite row navigates; Revoke forgets a host
// (browser_permission_revoke). Everything in it is per project, like sign-ins.
import { useEffect, useState } from "react";
import { History, ShieldCheck, Star, X } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { useEscape } from "../../ui/useEscape";
import { ago, hostOf, type BrowserFavorite, type BrowserHistoryEntry, type BrowserPermission } from "./browserModel";
import type { BrowserLoad } from "./useBrowser";

export type BrowserPanelTab = "history" | "favorites" | "permissions";

const TABS: ReadonlyArray<{ id: BrowserPanelTab; label: string }> = [
  { id: "history", label: "History" },
  { id: "favorites", label: "Favorites" },
  { id: "permissions", label: "Site permissions" },
];
const TAB = "v2-hover inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border-0 px-2.5 text-v2-body";
const TAB_ON = "bg-[var(--v2-raised)] font-medium text-[var(--v2-text)]";
const TAB_OFF = "bg-transparent text-[var(--v2-muted)]";
const ROW = "v2-hover flex w-full items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-v2-body text-[var(--v2-text)]";
const EMPTY = "px-2.5 py-2 text-v2-body text-[var(--v2-muted)]";
const NOTE = "border-t border-[var(--v2-edge)] px-3.5 py-2 text-v2-small leading-relaxed text-[var(--v2-muted)]";
const REVOKE = "v2-hover inline-flex h-[22px] shrink-0 items-center rounded-md border border-[var(--v2-edge-2)] bg-transparent px-2 text-v2-small font-medium text-[var(--v2-text)]";

export function BrowserPanel({ tab, onTab, load, onNavigate, onRevoke, onClose }: {
  tab: BrowserPanelTab;
  onTab: (tab: BrowserPanelTab) => void;
  load: BrowserLoad;
  onNavigate: (url: string) => void;
  onRevoke: (host: string) => void;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<readonly BrowserHistoryEntry[] | null>(null);
  const [favorites, setFavorites] = useState<readonly BrowserFavorite[] | null>(null);
  const [permissions, setPermissions] = useState<readonly BrowserPermission[] | null>(null);
  useEscape(onClose);

  useEffect(() => { void load.history().then(r => setHistory(r ?? [])); }, [load]);
  useEffect(() => { void load.favorites().then(r => setFavorites(r ?? [])); }, [load]);
  useEffect(() => { void load.permissions().then(r => setPermissions(r ?? [])); }, [load]);

  // The row leaves at once; the refetch settles whatever the core really kept.
  const revoke = (host: string): void => {
    onRevoke(host);
    setPermissions(p => (p === null ? p : p.filter(x => x.host !== host)));
  };

  return (
    <div role="dialog" aria-label="History, favorites and site permissions"
      className="absolute right-0 top-full z-30 mt-1 flex max-h-[60vh] w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1.5 shadow-lg">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--v2-edge)] pb-1.5 pt-0.5">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === tab}
            onClick={() => onTab(t.id)} className={`${TAB} ${t.id === tab ? TAB_ON : TAB_OFF}`}>
            {t.id === "history" && <History size={12} aria-hidden />}
            {t.id === "favorites" && <Star size={12} aria-hidden />}
            {t.id === "permissions" && <ShieldCheck size={12} aria-hidden />}
            {t.label}
          </button>
        ))}
        <span className="flex-1" />
        <IconButton label="Close panel" title="Close (Esc)" size={18} onClick={onClose}><X size={11} aria-hidden /></IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1">
        {tab === "history" && (history !== null && history.length > 0 ? history.map(row => (
          <button key={`${row.url}-${row.at}`} type="button" title={`Open ${row.url}`} onClick={() => onNavigate(row.url)} className={ROW}>
            <span className="min-w-0 flex-1 truncate">{row.title || row.url}</span>
            <span className="v2-mono shrink-0 text-v2-small text-[var(--v2-muted)]">{hostOf(row.url)}</span>
            <span className="shrink-0 text-v2-small text-[var(--v2-muted)]">{ago(row.at)}</span>
          </button>
        )) : <div className={EMPTY}>No pages visited yet in this project.</div>)}
        {tab === "favorites" && (favorites !== null && favorites.length > 0 ? favorites.map(row => (
          <button key={row.url} type="button" title={`Open ${row.url}`} onClick={() => onNavigate(row.url)} className={ROW}>
            <Star size={12} aria-hidden className="shrink-0 text-[var(--v2-muted)]" />
            <span className="min-w-0 flex-1 truncate">{row.title || row.url}</span>
            <span className="v2-mono shrink-0 text-v2-small text-[var(--v2-muted)]">{hostOf(row.url)}</span>
          </button>
        )) : <div className={EMPTY}>No favorite sites yet. Add the open page from the More menu.</div>)}
        {tab === "permissions" && (permissions !== null && permissions.length > 0 ? permissions.map(row => (
          <div key={row.host} className="flex items-center gap-2.5 px-2.5 py-1.5">
            <span className="v2-mono min-w-0 flex-1 truncate text-v2-body text-[var(--v2-text)]">{row.host}</span>
            <span className="shrink-0 text-v2-small text-[var(--v2-muted)]">allowed for agents</span>
            <button type="button" className={REVOKE} onClick={() => revoke(row.host)}>Revoke</button>
          </div>
        )) : <div className={EMPTY}>No site permissions yet. Allowing a new site for agents adds one.</div>)}
      </div>
      <div className={NOTE}>Per project, like sign-ins. Clear browsing data asks first, then signs this project's browser out of everything.</div>
    </div>
  );
}
