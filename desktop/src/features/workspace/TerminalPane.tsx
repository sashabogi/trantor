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
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { quotePaths } from "./quotePaths";
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

/** The slice of Tauri's DragDropEvent the pane reacts to. HTML5 drop never fires under Tauri —
 *  onDragDropEvent is the only channel (same receipt as the composer's drop, #5507). */
export type PaneDragDropEvent =
  | { type: "enter"; paths: string[]; position?: { x: number; y: number } }
  | { type: "over"; position?: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position?: { x: number; y: number } }
  | { type: "leave" };

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
  termWrite(sub: number, data: string): Promise<string>;
  termResize(sub: number, cols: number, rows: number): Promise<void>;
  termDetach(sub: number): Promise<void>;
  /** Webview-level drag-drop subscription (#5949); returns the unsubscribe. Injectable so the
   *  drop path is driven by a real object in tests, like every other dep here. */
  subscribeDragDrop(handler: (event: PaneDragDropEvent) => void): () => void;
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
  subscribeDragDrop: handler => {
    let off: (() => void) | undefined;
    try {
      getCurrentWebview()
        .onDragDropEvent(ev => handler(ev.payload))
        .then(un => { off = un; })
        .catch(() => { /* no webview under this window (tests) — drops are a no-op there */ });
    } catch {
      // getCurrentWebview throws outside a Tauri window; the pane still works, just undroppable.
    }
    return () => { try { off?.(); } catch { /* already gone */ } };
  },
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
  const [attachError, setAttachError] = useState<string | null>(null);
  // A file is being dragged over THIS pane (#5949) — the composer's calm ring, borrowed.
  const [dragOver, setDragOver] = useState(false);

  // Resolve (and re-resolve) the seat's herdr surface. Surfaces change when the crew restarts,
  // so this keeps polling at the hub-data cadence; terminal bytes stream over the pty once attached.
  useEffect(() => {
    let alive = true;
    setSurface(undefined);
    setLatencyMs(null);
    setOpenError(null);
    setAttachError(null);
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

  const writeSub = (sub: number, data: string) => {
    const t0 = performance.now();
    void deps.termWrite(sub, data).then(chunks => {
      invoke("app_log", {
        line: `term_write sub=${sub} bytes=${data.length} chunks=${chunks} ms=${Math.max(0, Math.round(performance.now() - t0))}`,
      }).catch(() => {});
    }).catch(() => {});
  };

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
      if (sub !== null) writeSub(sub, data);
    });
    const resize = () => {
      if (!hostRef.current) return;
      try { session.fit(); } catch { return; }
      const sub = subRef.current;
      if (sub !== null) void deps.termResize(sub, session.cols, session.rows);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(hostRef.current);

    // herdr answers a failed attach on STDOUT and exits, so its error arrives as terminal bytes
    // rather than a rejected promise — which is how a raw JSON envelope ended up rendered as the
    // seat's "terminal". Catch that one shape and say what it means instead.
    let sniffed = "";
    const decoder = new TextDecoder();
    const onBytes = (bytes: TerminalBytes) => {
      const chunk = terminalBytes(bytes);
      if (sniffed.length < 400) {
        sniffed += decoder.decode(chunk, { stream: true });
        if (sniffed.includes("agent_not_found")) setAttachError("notAnAgent");
      }
      session.write(chunk);
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

  // Dropped files (#5949, leak fixed #5949-bounce): the paths are written into the seat's
  // terminal shell-quoted and space-separated, through the same term_write path keystrokes use.
  // The event is webview-level, so "over this pane" is decided by the TOPMOST element under the
  // cursor — a rectangle test alone passes whenever a floating sheet covers the pane's rect,
  // which typed a dropped path into the orchestrator's terminal (the operator's bounce). No
  // position = not ours, never a drop. Every write is traced: sub, bytes, chunks, ms (#5921).
  useEffect(() => {
    if (!surface) return;
    const overThisPane = (position: { x: number; y: number } | undefined): boolean => {
      const el = hostRef.current;
      // No position = not ours, never a drop. And the TOPMOST element under the cursor decides:
      // a rectangle test passes whenever a floating sheet covers the pane's rect, which typed a
      // dropped path into the orchestrator's terminal (the operator's bounce, 0.3.110).
      if (!el || !position) return false;
      const dpr = window.devicePixelRatio || 1;
      const top = document.elementFromPoint(position.x / dpr, position.y / dpr);
      return !!top && el.contains(top);
    };
    return deps.subscribeDragDrop(ev => {
      if (ev.type === "leave") { setDragOver(false); return; }
      if (!overThisPane(ev.position)) { setDragOver(false); return; }
      if (ev.type === "drop") {
        setDragOver(false);
        const sub = subRef.current;
        if (sub === null || !ev.paths.length) return;
        const text = quotePaths(ev.paths);
        lastInputAtRef.current = performance.now();
        writeSub(sub, `${text} `);
        return;
      }
      setDragOver(true); // enter / over
    });
  }, [surface, deps]);

  if (attachError === "notAnAgent") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="tr-card-ghost max-w-[460px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
          <div>This pane exists, but herdr is not tracking anything running in it, so there is no terminal to show.</div>
          <div className="mt-2 text-tr-muted">
            That usually means the seat&rsquo;s process exited. It comes back on the seat&rsquo;s next turn.
          </div>
        </div>
      </div>
    );
  }
  if (!surface) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="tr-card-ghost max-w-[460px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
          {/* "Wake" starts the ORCHESTRATOR, which is only the right verb on the orchestrator's
              own pane — the same verb the sidebar's hover button carries, so the two doors into
              one action can never read as two actions. Offering it on a seat meant clicking it
              under kimi opened your own session and rendered it under kimi's name. A seat is
              started by the crew, not from here, so say that instead of offering the wrong
              action. */}
          {agent === "orchestrator" ? (
            <>
              <div>No session is hosted for this project yet.</div>
              <button
                type="button"
                onClick={attachOpenSession}
                disabled={opening}
                className="mt-3 rounded-[8px] bg-tr-ok px-3 py-1.5 text-[12px] font-semibold text-[#07130f] disabled:opacity-60"
              >
                {opening ? "Waking…" : "Wake session"}
              </button>
              {openError && <div className="mt-2 text-[11.5px] text-tr-danger">{openError}</div>}
            </>
          ) : (
            <>
              <div>{agent} has no terminal pane — it is not running under this crew.</div>
              <div className="mt-2 text-tr-muted">
                Start it with <span className="tr-mono">trantor up {agent}</span>. Its past work is
                still in the record rail either way.
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div
      className={`relative min-h-0 flex-1 rounded-lg transition-shadow ${dragOver ? "ring-1 ring-tr-doing/50" : ""}`}
      data-pane={surface}
      data-drag-over={dragOver}
    >
      <div ref={hostRef} className="h-full min-h-0" />
      {latencyMs !== null && (
        <div className="tr-mono absolute right-2 top-2 rounded-[7px] bg-black/50 px-2 py-1 text-[11px] text-tr-muted">
          echo {latencyMs}ms
        </div>
      )}
    </div>
  );
}
