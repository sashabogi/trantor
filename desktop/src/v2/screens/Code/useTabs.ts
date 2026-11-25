// Open tabs of the Code screen (#13988). The Source control tab is always first and never closes.
// #14072: tabs carry a dirty mark (the dot on the strip) and a close that asks first when the tab
// holds unsaved text; a confirmed close discards the draft with the tab.
import { useCallback, useState } from "react";
import { draftDrop } from "./drafts";
import { SOURCE_TAB, type CodeTab } from "./TabBar";

export function openTab(tabs: CodeTab[], tab: CodeTab): CodeTab[] {
  return tabs.some(t => t.id === tab.id) ? tabs : [...tabs, tab];
}

export type TabState = { tabs: CodeTab[]; activeId: string };

/** Closing the active tab lands on its left neighbour, so the strip is never left with nothing selected. */
export function closeTab(tabs: CodeTab[], activeId: string, id: string): TabState {
  if (id === SOURCE_TAB.id) return { tabs, activeId };
  const at = tabs.findIndex(t => t.id === id);
  const next = tabs.filter(t => t.id !== id);
  return { tabs: next, activeId: activeId === id ? next[Math.max(0, at - 1)].id : activeId };
}

export function useTabs(project: string) {
  const [tabs, setTabs] = useState<CodeTab[]>([SOURCE_TAB]);
  const [activeId, setActiveId] = useState(SOURCE_TAB.id);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const open = useCallback((tab: CodeTab) => { setTabs(t => openTab(t, tab)); setActiveId(tab.id); }, []);
  const markDirty = useCallback((id: string, d: boolean) => {
    setDirty(prev => {
      if (prev.has(id) === d) return prev;
      const next = new Set(prev);
      if (d) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const close = useCallback((id: string) => {
    const tab = tabs.find(t => t.id === id);
    if (tab?.kind === "file" && tab.path) draftDrop(project, tab.scope, tab.path);
    setConfirmId(null);
    markDirty(id, false);
    const r = closeTab(tabs, activeId, id);
    setTabs(r.tabs);
    setActiveId(r.activeId);
  }, [tabs, activeId, project, markDirty]);
  /** The strip's X: a dirty tab stops here and the inline row asks; anything else closes now. */
  const requestClose = useCallback((id: string) => {
    if (id !== SOURCE_TAB.id && dirty.has(id)) setConfirmId(id);
    else close(id);
  }, [dirty, close]);
  const confirmClose = useCallback(() => { if (confirmId) close(confirmId); }, [confirmId, close]);
  const cancelClose = useCallback(() => setConfirmId(null), []);
  return { tabs, activeId, active: tabs.find(t => t.id === activeId) ?? SOURCE_TAB, open, close, requestClose, confirmClose, cancelClose, confirmId, dirty, markDirty, activate: setActiveId };
}
