// The seat's live terminal — the one-surface mockup's center block. W3-C replaces the old
// read-only pane snapshot with a client pty attached to herdr, so xterm sees raw bytes and its
// onData goes straight back to Rust.
//
// HONESTY RULE carries over from the scaffold: when the selected seat has no herdr surface, this
// component renders NOTHING and the workspace keeps its stated-placeholder ghost — a fallback,
// not an error, and never an imitation of a live pane.
import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  orchestratorOpen,
  surfaceFor,
  termAttach,
  termDetach,
  terminalBytes,
  termResize,
  termWrite,
  type TerminalBytes,
} from "./herdr";

const SEATS_POLL_MS = 12_000;

// The design tokens the card names (#5367): the pane container's #101013, the app's text
// #ececf0, SF Mono at 12px — matching the record rail's mono rows, not a terminal-product look.
const THEME = {
  background: "#101013",
  foreground: "#ececf0",
  cursor: "#ececf0",
  selectionBackground: "rgba(20, 184, 166, 0.25)",
};

export function TerminalPane({ project, agent }: { project: string; agent: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<number | null>(null);
  const lastInputAtRef = useRef<number | null>(null);
  const [surface, setSurface] = useState<string | null | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  // Resolve (and re-resolve) the seat's herdr surface. Surfaces change when the crew restarts,
  // so this keeps polling at the hub-data cadence; terminal bytes stream over the pty once attached.
  useEffect(() => {
    let alive = true;
    setSurface(undefined);
    setLatencyMs(null);
    setOpenError(null);
    const lookup = () =>
      surfaceFor(project, agent)
        .then(s => { if (alive) setSurface(s); })
        .catch(() => { if (alive) setSurface(null); });
    lookup();
    const iv = setInterval(lookup, SEATS_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [project, agent]);

  const attachOpenSession = useCallback(async () => {
    setOpening(true);
    setOpenError(null);
    try {
      setSurface(await orchestratorOpen(project));
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }, [project]);

  // Open xterm, attach to the Rust pty, and keep resize/input lifecycles tied to this component.
  // Frequent terminal bytes stay inside refs and xterm; React only sees the low-rate latency chip.
  useEffect(() => {
    if (!surface || !hostRef.current) return;
    subRef.current = null;
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: '"SF Mono", ui-monospace, "Menlo", monospace',
      theme: THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const webgl = new WebglAddon();
    term.loadAddon(fit);
    try { term.loadAddon(webgl); } catch { /* WebGL can be unavailable; xterm falls back to DOM. */ }
    term.open(hostRef.current);
    fit.fit();

    let alive = true;
    const onData = term.onData(data => {
      lastInputAtRef.current = performance.now();
      const sub = subRef.current;
      if (sub !== null) void termWrite(sub, data);
    });
    const resize = () => {
      if (!hostRef.current) return;
      try { fit.fit(); } catch { return; }
      const sub = subRef.current;
      if (sub !== null) void termResize(sub, term.cols, term.rows);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(hostRef.current);

    const onBytes = (bytes: TerminalBytes) => {
      term.write(terminalBytes(bytes));
      const inputAt = lastInputAtRef.current;
      if (inputAt !== null) {
        setLatencyMs(Math.max(0, Math.round(performance.now() - inputAt)));
        lastInputAtRef.current = null;
      }
    };

    termAttach(surface, onBytes)
      .then(sub => {
        if (!alive) {
          void termDetach(sub);
          return;
        }
        subRef.current = sub;
        resize();
      })
      .catch(err => {
        if (alive) term.writeln(`\r\nterminal attach failed: ${err instanceof Error ? err.message : String(err)}`);
      });

    return () => {
      alive = false;
      ro.disconnect();
      onData.dispose();
      const sub = subRef.current;
      subRef.current = null;
      if (sub !== null) void termDetach(sub);
      webgl.dispose();
      fit.dispose();
      term.dispose();
    };
  }, [surface]);

  if (!surface) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="tr-card-ghost max-w-[460px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
          <div>
            This seat has no herdr terminal pane. Its work is still in the record rail.
          </div>
          <button
            type="button"
            onClick={attachOpenSession}
            disabled={opening}
            className="mt-3 rounded-[8px] bg-tr-ok px-3 py-1.5 text-[12px] font-semibold text-[#07130f] disabled:opacity-60"
          >
            {opening ? "Opening..." : "Open session"}
          </button>
          {openError && <div className="mt-2 text-[11.5px] text-tr-danger">{openError}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="relative min-h-0 flex-1" data-pane={surface}>
      <div ref={hostRef} className="h-full min-h-0" />
      {latencyMs !== null && (
        <div className="tr-mono absolute right-2 top-2 rounded-[7px] bg-black/50 px-2 py-1 text-[11px] text-tr-muted">
          echo {latencyMs}ms
        </div>
      )}
    </div>
  );
}
