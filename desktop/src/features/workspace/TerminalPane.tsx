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

// Everything this pane reaches outside itself, behind one narrow surface. The component never
// imports xterm or the Rust bridge directly, so a test supplies a faithful stand-in instead of
// rewriting the module graph underneath it (anti-slop: no-module-mocking).
//
// The three xterm objects collapse into ONE session because the pane only ever uses them together:
// a terminal, its fit addon and its webgl addon share a lifetime and are disposed as a unit.
export type PaneSession = {
  onData(cb: (data: string) => void): { dispose(): void };
  write(bytes: Uint8Array): void;
  writeln(text: string): void;
  fit(): void;
  readonly cols: number;
  readonly rows: number;
  dispose(): void;
};

export type TerminalDeps = {
  createSession(host: HTMLElement): PaneSession;
  surfaceFor(project: string, agent: string): Promise<string | null>;
  orchestratorOpen(project: string): Promise<string>;
  termAttach(target: string, onBytes: (bytes: TerminalBytes) => void): Promise<number>;
  termWrite(sub: number, data: string): Promise<void>;
  termResize(sub: number, cols: number, rows: number): Promise<void>;
  termDetach(sub: number): Promise<void>;
};

// The real xterm wiring lives here and nowhere else, so its concrete types line up naturally
// instead of being asserted into place at a call site.
function createXtermSession(host: HTMLElement): PaneSession {
  const term = new Terminal({
    convertEol: true,
    fontSize: 12,
    fontFamily: '"SF Mono", ui-monospace, "Menlo", monospace',
    theme: THEME,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  // WebGL is an optimisation and it is NOT always available in a WKWebView. Two things follow, and
  // getting either wrong takes the whole app down rather than the renderer:
  //   1. Only hold the addon if loadAddon actually accepted it. Disposing an addon that never
  //      activated throws, and that throw lands in a React effect cleanup during a tab switch,
  //      which unmounts the tree and leaves a blank frozen window (observed 2026-08-27).
  //   2. A lost context must dispose the addon, or xterm keeps drawing into a dead surface.
  let webgl: WebglAddon | null = null;
  try {
    const addon = new WebglAddon();
    term.loadAddon(addon);
    addon.onContextLoss(() => { try { addon.dispose(); } catch { /* already gone */ } webgl = null; });
    webgl = addon;
  } catch { webgl = null; }

  term.open(host);
  try { fit.fit(); } catch { /* host not laid out yet; the ResizeObserver fits again shortly. */ }
  return {
    onData: cb => term.onData(cb),
    write: bytes => term.write(bytes),
    writeln: text => term.writeln(text),
    fit: () => fit.fit(),
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    // Teardown runs inside a React cleanup, where a throw is fatal to the whole tree. Each step
    // is independent: one failing addon must not strand the terminal itself undisposed.
    dispose() {
      try { webgl?.dispose(); } catch { /* never activated, or context already lost */ }
      try { fit.dispose(); } catch { /* addon may be detached already */ }
      try { term.dispose(); } catch { /* nothing further we can do here */ }
    },
  };
}

export const DEFAULT_TERMINAL_DEPS: TerminalDeps = {
  createSession: createXtermSession,
  surfaceFor,
  orchestratorOpen,
  termAttach,
  termWrite,
  termResize,
  termDetach,
};

export function TerminalPane({
  project,
  agent,
  deps = DEFAULT_TERMINAL_DEPS,
}: { project: string; agent: string; deps?: TerminalDeps }) {
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
      deps.surfaceFor(project, agent)
        .then(s => { if (alive) setSurface(s); })
        .catch(() => { if (alive) setSurface(null); });
    lookup();
    const iv = setInterval(lookup, SEATS_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [project, agent, deps]);

  const attachOpenSession = useCallback(async () => {
    setOpening(true);
    setOpenError(null);
    try {
      setSurface(await deps.orchestratorOpen(project));
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }, [project, deps]);

  // Open xterm, attach to the Rust pty, and keep resize/input lifecycles tied to this component.
  // Frequent terminal bytes stay inside refs and xterm; React only sees the low-rate latency chip.
  useEffect(() => {
    if (!surface || !hostRef.current) return;
    subRef.current = null;
    const session = deps.createSession(hostRef.current);

    let alive = true;
    const onData = session.onData(data => {
      lastInputAtRef.current = performance.now();
      const sub = subRef.current;
      if (sub !== null) void deps.termWrite(sub, data);
    });
    const resize = () => {
      if (!hostRef.current) return;
      try { session.fit(); } catch { return; }
      const sub = subRef.current;
      if (sub !== null) void deps.termResize(sub, session.cols, session.rows);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(hostRef.current);

    const onBytes = (bytes: TerminalBytes) => {
      session.write(terminalBytes(bytes));
      const inputAt = lastInputAtRef.current;
      if (inputAt !== null) {
        setLatencyMs(Math.max(0, Math.round(performance.now() - inputAt)));
        lastInputAtRef.current = null;
      }
    };

    deps.termAttach(surface, onBytes)
      .then(sub => {
        if (!alive) {
          void deps.termDetach(sub);
          return;
        }
        subRef.current = sub;
        resize();
      })
      .catch(err => {
        if (alive) session.writeln(`\r\nterminal attach failed: ${err instanceof Error ? err.message : String(err)}`);
      });

    return () => {
      alive = false;
      ro.disconnect();
      onData.dispose();
      const sub = subRef.current;
      subRef.current = null;
      if (sub !== null) void deps.termDetach(sub);
      session.dispose();
    };
  }, [surface, deps]);

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
