// The editor tab strip (#13988): the Source control tab, file tabs, PR and merge tabs, and +.
import { AlertTriangle, GitBranch, GitPullRequest, PanelLeftOpen, Plus, SquareSplitHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../../ui/IconButton";
import type { MainTab } from "./model";

export type CodeTab = { id: string; kind: MainTab; label: string; scope: string | null; path?: string };

export const SOURCE_TAB: CodeTab = { id: "source", kind: "source", label: "Source control", scope: null };

const ICON = {
  source: <GitBranch size={13} aria-hidden />,
  pr: <GitPullRequest size={13} aria-hidden />,
  conflict: <AlertTriangle size={13} aria-hidden className="text-[var(--v2-bad)]" />,
  file: null,
} satisfies Record<MainTab, ReactNode>;

function fileBadge(path: string): string {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
  return ext.slice(0, 2).toUpperCase() || "··";
}

export function TabBar({ tabs, activeId, sidebarFolded, onActivate, onClose, onShowSidebar, onNew }: {
  tabs: CodeTab[]; activeId: string; sidebarFolded: boolean;
  onActivate: (id: string) => void; onClose: (id: string) => void; onShowSidebar: () => void; onNew: () => void;
}) {
  return (
    <div role="tablist" aria-label="Open tabs" className="flex h-[38px] shrink-0 items-center gap-0.5 border-b border-[var(--v2-edge)] bg-[var(--v2-chrome)] px-1.5">
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
            </button>
            {t.kind !== "source" && <IconButton label={`Close ${t.label}`} title="Close tab" size={18} onClick={() => onClose(t.id)}><X size={11} aria-hidden /></IconButton>}
          </div>
        );
      })}
      <IconButton label="New tab" title="New tab: search for a file to open" size={28} onClick={onNew}><Plus size={14} aria-hidden /></IconButton>
      <span className="flex-1" />
      <IconButton label="Split editor" title="Split editor is not available yet" size={28} disabled><SquareSplitHorizontal size={14} aria-hidden /></IconButton>
    </div>
  );
}
