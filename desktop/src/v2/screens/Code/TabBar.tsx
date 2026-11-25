// The editor tab strip (#13988): the Source control tab, file tabs, PR and merge tabs, and +.
// #14072: a dirty tab carries a dot; closing a dirty tab asks first in an inline row under the
// strip, never window.confirm.
import { AlertTriangle, GitBranch, PanelLeftOpen, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import type { MainTab } from "./model";

export type CodeTab = { id: string; kind: MainTab; label: string; scope: string | null; path?: string };

export const SOURCE_TAB: CodeTab = { id: "source", kind: "source", label: "Source control", scope: null };

const ICON = {
  source: <GitBranch size={13} aria-hidden />,
  conflict: <AlertTriangle size={13} aria-hidden className="text-[var(--v2-bad)]" />,
  file: null,
} satisfies Record<MainTab, ReactNode>;

function fileBadge(path: string): string {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
  return ext.slice(0, 2).toUpperCase() || "··";
}

export function TabBar({ tabs, activeId, sidebarFolded, dirty, confirmId, onActivate, onRequestClose, onConfirmClose, onCancelClose, onShowSidebar, onNew }: {
  tabs: CodeTab[]; activeId: string; sidebarFolded: boolean; dirty: ReadonlySet<string>; confirmId: string | null;
  onActivate: (id: string) => void; onRequestClose: (id: string) => void; onConfirmClose: () => void; onCancelClose: () => void;
  onShowSidebar: () => void; onNew: () => void;
}) {
  const confirming = tabs.find(t => t.id === confirmId && t.kind !== "source") ?? null;
  return (
    <div className="shrink-0 border-b border-[var(--v2-edge)] bg-[var(--v2-chrome)]">
      <div role="tablist" aria-label="Open tabs" className="flex h-[38px] items-center gap-0.5 px-1.5">
        {sidebarFolded && (
          <IconButton label="Show the source control sidebar" title="Sidebar folded: this tab is the full source control view. Click to show the summary sidebar beside it." size={28} onClick={onShowSidebar}>
            <PanelLeftOpen size={15} aria-hidden />
          </IconButton>
        )}
        {tabs.map(t => {
          const on = t.id === activeId;
          return (
            <div key={t.id} className={`flex h-[38px] items-center border-b-2 ${on ? "border-[var(--v2-accent)] bg-[var(--v2-bg)]" : "border-transparent"}`}>
              <button type="button" role="tab" aria-selected={on} onClick={() => onActivate(t.id)} title={t.path ?? t.label}
                className={`inline-flex h-full items-center gap-1.5 border-0 bg-transparent pl-2.5 pr-1 text-[12px] ${on ? "text-[var(--v2-text)]" : "text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
                {t.kind === "file" ? <span className="v2-mono text-[9.5px] text-[var(--v2-accent)]">{fileBadge(t.path ?? "")}</span> : ICON[t.kind]}
                <span className="max-w-[160px] truncate">{t.label}</span>
                {dirty.has(t.id) && <span title="Unsaved changes" aria-label="Unsaved changes" role="img" className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--v2-accent)]" />}
              </button>
              {t.kind !== "source" && <IconButton label={`Close ${t.label}`} title="Close tab" size={18} onClick={() => onRequestClose(t.id)}><X size={11} aria-hidden /></IconButton>}
            </div>
          );
        })}
        <IconButton label="New tab" title="New tab: search for a file to open" size={28} onClick={onNew}><Plus size={14} aria-hidden /></IconButton>
        <span className="flex-1" />
      </div>
      {confirming && (
        <div role="alert" className="flex items-center gap-3 border-t border-[var(--v2-edge)] px-3 py-1.5 text-[12px] text-[var(--v2-text)]">
          <span className="min-w-0 flex-1 truncate"><span className="v2-mono">{confirming.path ?? confirming.label}</span> has unsaved changes. Closing it discards them.</span>
          <Button variant="danger" onClick={onConfirmClose}>Discard and close</Button>
          <Button variant="quiet" onClick={onCancelClose}>Keep open</Button>
        </div>
      )}
    </div>
  );
}
