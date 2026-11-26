import { useCallback, type SyntheticEvent } from "react";

/** One active pane per document, including separate React roots; nested panes own their events. */
export function useActivePane(working = false) {
  const activate = useCallback((event: SyntheticEvent<HTMLElement>) => {
    const pane = event.currentTarget;
    // SAFETY: React pointer and focus events target a DOM element within this pane.
    if ((event.target as Element).closest("[data-v2-pane]") !== pane) return;
    for (const previous of pane.ownerDocument.querySelectorAll("[data-v2-pane][data-active]")) {
      if (previous !== pane) previous.removeAttribute("data-active");
    }
    pane.setAttribute("data-active", "true");
  }, []);
  return { "data-v2-pane": true, "data-working": working || undefined, onPointerDown: activate, onFocus: activate };
}
