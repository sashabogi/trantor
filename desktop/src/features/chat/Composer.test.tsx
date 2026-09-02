// @vitest-environment happy-dom
//
// The composer's drag handle, proven against the REAL component (#6070 bounce): the pure geometry
// was green while the built app's handle sat inert — the moves rode the element's own pointermove
// under WKWebView pointer capture and never arrived. The fix rides window listeners; this drill
// dispatches pointerdown → window pointermove → pointerup and asserts the height actually reaches
// the textarea's style and lands in localStorage. The Tauri surface is stubbed at its one real
// boundary (window.__TAURI_INTERNALS__) — the component's own try/catches do the rest.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Composer } from "./Composer";
import { clampComposerPx, maxComposerPx, minComposerPx } from "./composerHeight";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SAFETY: the Tauri IPC boundary as the webview provides it — invoke answers the autonomy read with
// an empty state; everything else the composer reaches is caught by its own try/catches. The cast
// names the one key happy-dom's window type does not carry.
const w = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<string> } };
w.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve("{}") };

// A test-scoped localStorage stub — this happy-dom integration exposes none. Fresh per test, so
// every drill starts "nothing was ever persisted".
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

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  installStore();
  host = document.createElement("div");
  document.body.appendChild(host);
  // SAFETY: the pane the composer measures against — happy-dom lays nothing out, so the host's
  // clientHeight is declared the way tabStrip.test.tsx declares the strip's width. 800px pane →
  // the 60% ceiling the drags below are asserted against.
  Object.defineProperty(host, "clientHeight", { value: 800, configurable: true });
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const renderComposer = () => {
  act(() => root.render(
    <Composer
      project="p"
      target="orch"
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
  ));
};

describe("the composer's drag handle (#6070 bounce)", () => {
  it("starts at the two-line floor when the content is smaller", () => {
    renderComposer();
    const ta = host.querySelector("textarea");
    expect(ta).toBeTruthy();
    expect(ta?.style.height).toBe(`${minComposerPx()}px`);
  });

  it("pointerdown on the handle + window move/up drives the textarea's height, and the choice persists", () => {
    renderComposer();
    const ta = host.querySelector("textarea");
    const handle = host.querySelector<HTMLDivElement>("[role='separator']");
    expect(ta).toBeTruthy();
    expect(handle).toBeTruthy();
    if (!ta || !handle) return;

    const min = minComposerPx();
    const max = maxComposerPx(800);
    const dragBy = 120;

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { clientY: 500, pointerId: 1, bubbles: true, cancelable: true }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientY: 500 + dragBy, pointerId: 1, bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientY: 500 + dragBy, pointerId: 1, bubbles: true }));
    });

    const expected = clampComposerPx(min + dragBy, min, max);
    // The height REACHED the style — the exact leg the operator's bounce said to prove.
    expect(expected).toBe(min + dragBy);
    expect(ta.style.height).toBe(`${expected}px`);
    // …and the choice is remembered.
    expect(store.get("trantor.chat.composerHeight")).toBe(String(expected));
  });

  it("a drag cannot push the box past the pane's ceiling", () => {
    renderComposer();
    const ta = host.querySelector("textarea");
    const handle = host.querySelector<HTMLDivElement>("[role='separator']");
    expect(ta).toBeTruthy();
    expect(handle).toBeTruthy();
    if (!ta || !handle) return;

    const max = maxComposerPx(800);

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { clientY: 500, pointerId: 1, bubbles: true, cancelable: true }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientY: 500 + 10_000, pointerId: 1, bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientY: 500 + 10_000, pointerId: 1, bubbles: true }));
    });

    expect(ta.style.height).toBe(`${max}px`);
    expect(store.get("trantor.chat.composerHeight")).toBe(String(max));
  });
});
