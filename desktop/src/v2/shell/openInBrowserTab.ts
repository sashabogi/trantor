import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { BROWSER_REVEAL_EVENT, type BrowserState } from "../screens/Workspace/browserModel";

// Read before opening so a first chat link creates a page even before the tab has mounted.
export async function openInBrowserTab(project: string, url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  const state = await invoke<BrowserState>("browser_state", { project });
  await invoke(state.pages.length ? "browser_navigate" : "browser_new_page", { project, url });
  await emit(BROWSER_REVEAL_EVENT, { project });
}
