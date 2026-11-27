// The Workspace's reopen tab (#14513): per project in localStorage, and a Browser tab only
// when the project's browser really has a page — an empty Browser never reopens, the tab
// lands on Terminal instead. Stored values only ever come back through tabOf.
import type { BrowserPage, BrowserState } from "./browserModel";
import type { WorkTab } from "./SeatBar";

/** The per-project key the last picked tab lives under. */
export const tabKey = (project: string) => `trantor.v2.workspace.tab.${project}`;

/** The stored value if it names a work tab, else null. */
export function tabOf(stored: string | null): WorkTab | null {
  return stored === "terminal" || stored === "changes" || stored === "browser" ? stored : null;
}

/** The project's remembered tab, or null when nothing valid was stored. */
export function readStoredTab(project: string): WorkTab | null {
  try { return tabOf(localStorage.getItem(tabKey(project))); } catch { return null; }
}

/** Remember the picked tab for this project; a blocked store keeps the session's choice. */
export function storeTab(project: string, tab: WorkTab): void {
  try { localStorage.setItem(tabKey(project), tab); } catch { /* storage blocked: the choice lasts the session */ }
}

/** The browser state fields the page check reads: a wave-1 core sends no page set. */
export type BrowserHasPageState = Pick<BrowserState, "url"> & { pages?: BrowserPage[] };

/** Whether the project's browser has a page to show. Wave 2 reports the page set; a wave-1
 * core only the top-level url — "" and about:blank read as nothing open. */
export function browserHasPage(state: BrowserHasPageState | null | undefined): boolean {
  if (!state) return false;
  if (Array.isArray(state.pages) && state.pages.length > 0) return true;
  const url = state.url ?? "";
  return url !== "" && url !== "about:blank";
}

/** The tab a project reopens on: its remembered tab, except the Browser needs a page. */
export function restoredTab(stored: WorkTab | null, hasPage: boolean): WorkTab {
  if (stored && (stored !== "browser" || hasPage)) return stored;
  return "terminal";
}
