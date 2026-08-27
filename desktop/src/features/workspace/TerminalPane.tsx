// The seat's live terminal — the one-surface mockup's center block (#5367). A READ-ONLY mirror
// of the seat's herdr pane: xterm with disableStdin, fed by codex's FROZEN herdr_pane_read
// (#5366) on a 1500ms poll that writes only the DIFF of new output (paneText.ts) so a poll that
// returns mostly-unchanged text never repaints the pane.
//
// HONESTY RULE carries over from the scaffold: when the selected seat has no herdr surface, this
// component renders NOTHING and the workspace keeps its stated-placeholder ghost — a fallback,
// not an error, and never an imitation of a live pane.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { herdrPaneRead, surfaceFor } from "./herdr";
import { paneDiff } from "./paneText";

const POLL_MS = 1500;
const SEATS_POLL_MS = 12_000;

// The design tokens the card names (#5367): the pane container's #101013, the app's text
// #ececf0, SF Mono at 12px — matching the record rail's mono rows, not a terminal-product look.
const THEME = {
  background: "#101013",
  foreground: "#ececf0",
  cursor: "#ececf0",
  selectionBackground: "rgba(20, 184, 166, 0.25)",
};

export function TerminalPane({ project, agent, fallback }: {
  project: string; agent: string;
  /** Rendered while no herdr surface exists for this seat — the workspace's stated-placeholder
   * ghost, passed through so the fallback's wording stays owned where it always lived. */
  fallback?: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState<string | null>(null); // null = lookup not resolved yet

  // Resolve (and re-resolve) the seat's herdr surface. Surfaces change when the crew restarts,
  // so this keeps polling at the hub-data cadence; the pane poll below runs at the 1500ms the
  // card names.
  useEffect(() => {
    let alive = true;
    setSurface(null);
    const lookup = () =>
      surfaceFor(project, agent)
        .then(s => { if (alive) setSurface(s); })
        .catch(() => { if (alive) setSurface(null); });
    lookup();
    const iv = setInterval(lookup, SEATS_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [project, agent]);

  // The mirror itself: open xterm on the container, then poll pane_read and write only what
  // changed. `last` mirrors what the terminal already shows; a non-prefix read (a clear, a TUI
  // redraw) is the one case that justifies a reset-and-rewrite.
  useEffect(() => {
    if (!surface || !hostRef.current) return;
    const term = new Terminal({
      disableStdin: true,
      convertEol: true,
      fontSize: 12,
      fontFamily: '"SF Mono", ui-monospace, "Menlo", monospace',
      theme: THEME,
      scrollback: 5000,
    });
    term.open(hostRef.current);
    let alive = true;
    let last = "";
    let busy = false;
    const poll = async () => {
      if (!alive || busy) return;
      busy = true;
      try {
        const text = await herdrPaneRead(surface);
        if (!alive) return;
        const update = paneDiff(last, text);
        if (!update) return;
        if (update.kind === "replace") { term.reset(); last = ""; }
        term.write(update.text);
        term.scrollToBottom();
        last = text;
      } catch { /* a failed poll keeps the last good frame; seats-poll re-resolves surfaces */ }
      finally { busy = false; }
    };
    poll();
    const iv = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(iv); term.dispose(); };
  }, [surface]);

  if (!surface) return <>{fallback}</>;
  return <div ref={hostRef} className="min-h-0 flex-1" data-pane={surface} />;
}
