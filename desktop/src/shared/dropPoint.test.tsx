// @vitest-environment happy-dom
// #11513: one drop, two claimants. The webview delivers the SAME payload position to the chat
// composer and the workspace terminal pane, and both resolve it to the topmost element in CSS px
// (shared/dropPoint); the layout is the operator's — terminal LEFT, composer RIGHT, Retina dpr 2.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { Composer } from "../features/chat/Composer";
import { draftSlots } from "../features/chat/composerDraft";
import { TerminalPane } from "../features/workspace/TerminalPane";
import { installResizeObserver, makeTerminalDouble, type TerminalDouble } from "../features/workspace/terminalDouble";
import { dropPointToCss } from "./dropPoint";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installResizeObserver();

// The operator's canvas: 1440x900 CSS px at dpr 2. A real physical payload on this display can
// name x up to 2880 — the exact ambiguity dropPointToCss resolves by the window bounds.
Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });

// A test-scoped localStorage stub — this happy-dom integration exposes none (as Composer.test).
let store: Map<string, string>;
// SAFETY: the cast narrows globalThis to the exact optional key the stub owns; nothing else is
// asserted away, and the stub object itself is typed Storage by annotation, never by cast.
const stubGlobal = globalThis as { localStorage?: Storage };
const installStore = () => {
  store = new Map<string, string>();
  const stub: Storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  stubGlobal.localStorage = stub;
};

// The event envelope @tauri-apps/api's listen hands its handler, and the drop payload shape the
// onDragDropEvent wrapper reads — the two contracts the double must reproduce verbatim.
type TauriEventEnvelope = { event: string; id: number; payload: { type: string; paths?: string[]; position?: { x: number; y: number } } };
type InvokeResult = number | string | null | { bytes: number };
type TauriInternals = {
  metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
  transformCallback: (cb: (e: TauriEventEnvelope) => void) => number;
  invoke: (cmd: string, args?: InvokeArgs) => Promise<InvokeResult>;
};
// SAFETY: the cast adds exactly these two optional internals keys to happy-dom's window type;
// the objects below implement them, so nothing else about window is reinterpreted.
const w = window as typeof window & { __TAURI_INTERNALS__?: TauriInternals; __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: () => void } };

// The Tauri internals the composer's REAL subscription traverses: transformCallback hands back a
// handler id, plugin:event|listen registers it, and emitTauriDrop delivers the event envelope to
// every registered handler — the same channel the composer and the genesis sheet subscribe through.
const callbacks = new Map<number, (e: TauriEventEnvelope) => void>();
const regs: Array<{ event: string; cb: (e: TauriEventEnvelope) => void }> = [];
const traces: string[] = [];
let seq = 0;
const installInternals = () => {
  callbacks.clear(); regs.length = 0; traces.length = 0; seq = 0;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: cb => { const id = ++seq; callbacks.set(id, cb); return id; },
    invoke: (cmd: string, args?: InvokeArgs): Promise<InvokeResult> => {
      if (cmd === "plugin:event|listen") {
        // SAFETY: plugin:event|listen's args are { event, target, handler } by the api's own
        // listen(); the cast names the two fields read here, never a guess.
        const a = (args ?? {}) as { event: string; handler: number };
        const cb = callbacks.get(a.handler);
        if (cb) regs.push({ event: a.event, cb });
        return Promise.resolve(++seq);
      }
      if (cmd === "plugin:event|unlisten") return Promise.resolve(null);
      if (cmd === "app_log") {
        // SAFETY: app_log's command contract is { line: string } (changes.rs); the cast names it.
        traces.push(String((args as { line: string }).line));
        return Promise.resolve(null);
      }
      if (cmd === "attachment_info") return Promise.resolve({ bytes: 12 });
      return Promise.resolve("{}");
    },
  };
  // SAFETY: the api's unlisten reads this registry off window; an empty unregister is the honest
  // no-op — the double owns listener liveness itself (regs is cleared per test).
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
};

// The webview's drop bus: every registered handler hears every drop, exactly like production
// where the composer and each mounted pane all hold a tauri://drag-drop subscription.
const emitTauriDrop = (payload: { paths: string[]; position?: { x: number; y: number } }) => {
  for (const r of [...regs]) {
    if (r.event !== "tauri://drag-drop") continue;
    r.cb({ event: "tauri://drag-drop", id: ++seq, payload: { type: "drop", ...payload } });
  }
};

// Declared side-by-side geometry — happy-dom lays nothing out, so each claimant's rect is stated
// the way the operator's window places them: terminal 0..900, chat composer 1000..1440.
const rect = (x: number, y: number, w: number, h: number): DOMRect => {
  // SAFETY: the object carries every DOMRect field getBoundingClientRect must return; the cast
  // names that shape rather than minting a class.
  return { x, y, top: y, left: x, right: x + w, bottom: y + h, width: w, height: h, toJSON: () => null } as DOMRect;
};
const place = (el: Element, r: DOMRect) =>
  Object.defineProperty(el, "getBoundingClientRect", { value: () => r, configurable: true });

// A plain elementFromPoint over the declared rects: the DEEPEST element containing the point wins
// (children sit above parents), which is the one fact the handlers read from real hit-testing.
const realElementFromPoint = document.elementFromPoint.bind(document);
const installHitTesting = () => {
  document.elementFromPoint = (x: number, y: number): Element | null => {
    let best: Element | null = null;
    let bestDepth = -1;
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      let depth = 0;
      for (let p: Element | null = el; p; p = p.parentElement) depth += 1;
      if (depth >= bestDepth) { best = el; bestDepth = depth; }
    }
    return best;
  };
};

describe("a drop between the terminal and the composer (#11513)", () => {
  let termHost: HTMLDivElement;
  let chatHost: HTMLDivElement;
  let termRoot: Root;
  let chatRoot: Root;
  let d: TerminalDouble;

  beforeEach(() => {
    // #11665: drafts outlive a composer by design, so each case starts from a fresh launch.
    draftSlots.reset();
    installStore();
    installInternals();
    installHitTesting();
    d = makeTerminalDouble();
    termHost = document.createElement("div");
    chatHost = document.createElement("div");
    document.body.append(termHost, chatHost);
    termRoot = createRoot(termHost);
    chatRoot = createRoot(chatHost);
  });

  afterEach(() => {
    act(() => termRoot.unmount());
    act(() => chatRoot.unmount());
    termHost.remove();
    chatHost.remove();
    document.elementFromPoint = realElementFromPoint;
  });

  const renderSideBySide = async () => {
    await act(async () => {
      termRoot.render(<TerminalPane project="trantor" agent="codex" deps={d.deps} />);
      chatRoot.render(
        <Composer
          project="trantor"
          target="orchestrator"
          live
          liveWhy=""
          model="opus"
          modelSource="reported"
          working={false}
          userTexts={[]}
          context={{ tokens: null, window: 200000, frac: null }}
          fontStep="m"
          onFontStep={() => {}}
          onSent={() => {}}
          onLongRunChange={() => {}}
          onDispatch={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const paneHostEl = termHost.querySelector("[data-pane] > div");
    const composerRootEl = chatHost.firstElementChild;
    expect(paneHostEl).toBeTruthy();
    expect(composerRootEl).toBeTruthy();
    if (paneHostEl) place(paneHostEl, rect(0, 0, 900, 900));
    if (composerRootEl) place(composerRootEl, rect(1000, 400, 440, 500));
  };

  const drop = async (x: number, y: number, path = "/Users/me/PRD.png") => {
    await act(async () => {
      emitTauriDrop({ paths: [path], position: { x, y } });
      d.emitDragDrop({ type: "drop", paths: [path], position: { x, y } });
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("a drop on the composer makes a chip and writes NOTHING to the terminal beside it", async () => {
    await renderSideBySide();
    await drop(1200, 600); // composer's CSS coords; the old /dpr math looked at (600, 300) — the terminal
    const chip = chatHost.querySelector('[title="/Users/me/PRD.png"]');
    expect(chip).toBeTruthy();
    expect(chatHost.querySelector("textarea")?.value).toBe("");
    expect(d.written).toEqual([]);
    expect(traces.some(t => t.startsWith("drop #11513 composer") && t.includes("point=1200,600") && t.includes("takes=true"))).toBe(true);
    expect(traces.some(t => t.startsWith("drop #11513 pane(codex)") && t.includes("point=1200,600") && t.includes("over=false"))).toBe(true);
  });

  it("a drop on the terminal still types the quoted path, and the composer takes no chip", async () => {
    await renderSideBySide();
    await drop(450, 450);
    expect(d.written).toEqual([{ sub: 42, data: "'/Users/me/PRD.png' " }]);
    expect(chatHost.querySelector('[title="/Users/me/PRD.png"]')).toBeNull();
  });
});

describe("dropPointToCss", () => {
  it("a point inside the window is already CSS px — never divided", () => {
    expect(dropPointToCss({ x: 1200, y: 600 })).toEqual({ x: 1200, y: 600 });
  });
  it("a point beyond the window can only be physical, so it divides by dpr", () => {
    expect(dropPointToCss({ x: 2400, y: 1200 })).toEqual({ x: 1200, y: 600 });
    expect(dropPointToCss({ x: 2880, y: 1800 })).toEqual({ x: 1440, y: 900 });
  });
});
