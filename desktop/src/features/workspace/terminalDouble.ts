// A faithful stand-in for everything TerminalPane reaches outside itself.
//
// It implements the SAME PaneSession/TerminalDeps surface the real wiring implements, so the pane
// under test runs its real code path against a real object. Nothing rewrites the module graph
// underneath it, which is what the anti-slop no-module-mocking rule is protecting: a pane that
// passes here passes because its own logic is right, not because an import was swapped.
//
// It also records what the pane did, and exposes the two things only the outside world can
// trigger: bytes arriving from the pty, and the user typing.
import type { PaneSession, PaneDragDropEvent, TerminalDeps } from "./TerminalPane";
import type { TerminalBytes } from "./herdr";

export type TerminalDouble = {
  deps: TerminalDeps;
  /** every chunk the pane wrote into the terminal, in order */
  writes: Uint8Array[];
  /** lines the pane wrote itself (attach failures) */
  lines: string[];
  attached: string[];
  opened: string[];
  written: Array<{ sub: number; data: string }>;
  resized: Array<{ sub: number; cols: number; rows: number }>;
  detached: number[];
  fits: number;
  disposed: boolean;
  /** the pane's drag-over ring is showing (#5949) */
  dragOver: boolean;
  /** drive the pty: bytes arrive from Rust */
  emitBytes(bytes: TerminalBytes): void;
  /** drive the user: a keystroke reaches xterm's onData */
  emitData(data: string): void;
  /** drive the container: the ResizeObserver fires */
  fireResize(): void;
  /** drive a webview drag-drop event into the pane (#5949) */
  emitDragDrop(event: PaneDragDropEvent): void;
};

type ResizeCallback = () => void;
const resizeCallbacks: ResizeCallback[] = [];

/** happy-dom has no ResizeObserver. This is a plain implementation, not a mock: the pane observes
 *  a node and we call it back, which is the whole contract the pane depends on. */
class TestResizeObserver implements ResizeObserver {
  private readonly fire: ResizeCallback;
  constructor(callback: ResizeObserverCallback) {
    // The pane ignores entries entirely (it re-fits from the live element), so firing with an
    // empty set is faithful, not a shortcut.
    this.fire = () => callback([], this);
    resizeCallbacks.push(this.fire);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    const i = resizeCallbacks.indexOf(this.fire);
    if (i >= 0) resizeCallbacks.splice(i, 1);
  }
}

export function installResizeObserver(): void {
  globalThis.ResizeObserver = TestResizeObserver;
}

export function makeTerminalDouble(opts: {
  surface?: string | null;
  opened?: string;
  sub?: number;
  cols?: number;
  rows?: number;
} = {}): TerminalDouble {
  const surface = opts.surface === undefined ? "pane-1" : opts.surface;
  const openedPane = opts.opened ?? "opened-pane";
  const sub = opts.sub ?? 42;
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 30;

  let onDataCb: ((data: string) => void) | null = null;
  let onBytesCb: ((bytes: TerminalBytes) => void) | null = null;
  let dragCb: ((event: PaneDragDropEvent) => void) | null = null;
  const d: TerminalDouble = {
    dragOver: false,
    deps: {
      createSession(): PaneSession {
        const session: PaneSession = {
          onData(cb) {
            onDataCb = cb;
            return { dispose() { onDataCb = null; } };
          },
          write(bytes) { d.writes.push(bytes); },
          writeln(text) { d.lines.push(text); },
          fit() { d.fits += 1; },
          cols,
          rows,
          dispose() { d.disposed = true; },
        };
        return session;
      },
      surfaceFor: async () => surface,
      orchestratorOpen: async project => { d.opened.push(project); return openedPane; },
      termAttach: async (target, onBytes) => {
        d.attached.push(target);
        onBytesCb = onBytes;
        return sub;
      },
      termWrite: async (s, data) => {
        d.written.push({ sub: s, data });
        return "1"; // the chunk count the trace reports; a double never chunks
      },
      termResize: async (s, c, r) => { d.resized.push({ sub: s, cols: c, rows: r }); },
      termDetach: async s => { d.detached.push(s); },
      subscribeDragDrop(handler) {
        dragCb = handler;
        return () => { dragCb = null; };
      },
    },
    writes: [],
    lines: [],
    attached: [],
    opened: [],
    written: [],
    resized: [],
    detached: [],
    fits: 0,
    disposed: false,
    emitBytes(bytes) { onBytesCb?.(bytes); },
    emitData(data) { onDataCb?.(data); },
    fireResize() { for (const cb of [...resizeCallbacks]) cb(); },
    emitDragDrop(event) {
      dragCb?.(event);
      d.dragOver = event.type === "enter" || event.type === "over";
    },
  };
  return d;
}
