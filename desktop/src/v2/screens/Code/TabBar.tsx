// The editor tab strip (#13988): the Source control tab, file tabs, PR and merge tabs, and +.
// #14072: a dirty tab carries a dot; closing a dirty tab asks first in an inline row under the
// strip, never window.confirm.
// #14241: the strip is the shared Tabs bar, joined to the editor pane below.
import { AlertTriangle, GitBranch, PanelLeftOpen, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Tabs, type TabSpec } from "../../ui/Tabs";
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
  const spec: TabSpec[] = tabs.map(t => ({
    id: t.id,
    label: t.label,
    title: t.path ?? t.label,
    leading: t.kind === "file" ? <span className="v2-mono text-[9.5px] text-[var(--v2-accent)]">{fileBadge(t.path ?? "")}</span> : ICON[t.kind],
    close: t.kind !== "source",
    dirty: dirty.has(t.id),
  }));
  return (
    <div className="shrink-0 bg-[var(--v2-chrome)]">
      <Tabs label="Open tabs" pane="var(--v2-bg)" tabs={spec} activeId={activeId} onSelect={onActivate} onClose={onRequestClose}
        barClassName="h-[38px] px-1.5"
        lead={sidebarFolded ? (
          <IconButton label="Show the source control sidebar" title="Sidebar folded: this tab is the full source control view. Click to show the summary sidebar beside it." size={28} onClick={onShowSidebar}>
            <PanelLeftOpen size={15} aria-hidden />
          </IconButton>
        ) : undefined}
        actions={<IconButton label="New tab" title="New tab: search for a file to open" size={28} onClick={onNew}><Plus size={14} aria-hidden /></IconButton>} />
      {confirming && (
        <div role="alert" className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-3 py-1.5 text-[12px] text-[var(--v2-text)]">
          <span className="min-w-0 flex-1 truncate"><span className="v2-mono">{confirming.path ?? confirming.label}</span> has unsaved changes. Closing it discards them.</span>
          <Button variant="danger" onClick={onConfirmClose}>Discard and close</Button>
          <Button variant="quiet" onClick={onCancelClose}>Keep open</Button>
        </div>
      )}
    </div>
  );
}
