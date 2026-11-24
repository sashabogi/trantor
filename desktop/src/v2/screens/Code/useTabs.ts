// Open tabs of the Code screen (#13988). The Source control tab is always first and never closes.
import { useCallback, useState } from "react";
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

export function useTabs() {
  const [tabs, setTabs] = useState<CodeTab[]>([SOURCE_TAB]);
  const [activeId, setActiveId] = useState(SOURCE_TAB.id);
  const open = useCallback((tab: CodeTab) => { setTabs(t => openTab(t, tab)); setActiveId(tab.id); }, []);
  const close = useCallback((id: string) => {
    const r = closeTab(tabs, activeId, id);
    setTabs(r.tabs);
    setActiveId(r.activeId);
  }, [tabs, activeId]);
  return { tabs, activeId, active: tabs.find(t => t.id === activeId) ?? SOURCE_TAB, open, close, activate: setActiveId };
}
