// @vitest-environment happy-dom
//
// #6147 — the webview's drop event is WINDOW-global: the composer and the genesis sheet both
// hear every drop, so a PRD dropped on the sheet's brief also became an attachment chip in the
// chat behind it. The composer's gate (composerTakesDrop) scopes a drop to the composer itself
// and stands down while a modal sheet is open. The Tauri seam is mocked at the module boundary
// and document.elementFromPoint is the geometry seam, so the tests drive REAL drop payloads
// through the REAL gating: positive control first (an in-composer drop lands), then the two
// refusals — a drop whose topmost element is outside the composer, and any drop while the
// sheet's data-modal-sheet-open marker is in the document.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, composerTakesDrop } from "./Composer";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DropPayload = { type: "drop" | "enter" | "over" | "leave"; paths: string[]; position: { x: number; y: number } };

const dragBus = vi.hoisted(() => ({
  handlers: [] as Array<(ev: { payload: unknown }) => void>,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  // SAFETY: the composer only ever registers onDragDropEvent; the mock records the handler so
  // tests fire real drop payloads through the real gate. Unlisten removes it, as the real API does.
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (ev: { payload: unknown }) => void) => {
      dragBus.handlers.push(h);
      return Promise.resolve(() => {
        const i = dragBus.handlers.indexOf(h);
        if (i >= 0) dragBus.handlers.splice(i, 1);
      });
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  // SAFETY: the composer's only mount-time invoke is autonomy_get, parsed as AutonomyJson; an
  // empty resolution renders the dials unknown, which is fine — the drop gate does not read it.
  invoke: (cmd: string) =>
    cmd === "autonomy_get" ? Promise.resolve(JSON.stringify({ resolved: {} })) : Promise.resolve(null),
}));

const fireDrop = (payload: DropPayload) =>
  act(async () => { for (const h of dragBus.handlers) h({ payload }); });

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

describe("Composer drop scoping (#6147)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let elementFromPoint: (x: number, y: number) => Element | null;

  const render = () => {
    act(() => {
      root.render(
        <Composer
          project="p"
          target="orchestrator:p"
          live
          liveWhy=""
          model="fable"
          modelSource="reported"
          working={false}
          userTexts={[]}
          context={{ tokens: 1000, window: 200000, frac: 0.005 }}
          fontStep="m"
          onFontStep={() => {}}
          onSent={() => {}}
          onLongRunChange={() => {}}
          onDispatch={() => {}}
        />,
      );
    });
  };
  const textarea = () => host.querySelector("textarea")!;
  const drop = (paths: string[]) =>
    fireDrop({ type: "drop", paths, position: { x: 12, y: 12 } });

  beforeEach(() => {
    dragBus.handlers.length = 0;
    elementFromPoint = document.elementFromPoint;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelectorAll("[data-modal-sheet-open]").forEach(n => n.remove());
    document.elementFromPoint = elementFromPoint;
    vi.restoreAllMocks();
  });

  it("POSITIVE CONTROL: a drop whose topmost element is inside the composer splices the path", async () => {
    render();
    await flush();
    // The drop point resolves to the textarea itself — inside the composer root.
    vi.spyOn(document, "elementFromPoint").mockReturnValue(textarea());
    await drop(["/tmp/prd.md"]);
    expect(textarea().value).toContain("/tmp/prd.md");
  });

  it("a drop whose topmost element is OUTSIDE the composer produces no chip", async () => {
    render();
    await flush();
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(elsewhere);
    await drop(["/tmp/prd.md"]);
    expect(textarea().value).toBe("");
  });

  it("no drop becomes a chip while a modal sheet is open — even over the composer", async () => {
    render();
    await flush();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(textarea());
    document.body.insertAdjacentHTML("beforeend", '<div data-modal-sheet-open="true"></div>');
    await drop(["/tmp/prd.md"]);
    expect(textarea().value).toBe("");
  });

  it("the gate flips per drop: one lands, the sheet opens, the next is refused", async () => {
    render();
    await flush();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(textarea());
    await drop(["/tmp/first.md"]);
    expect(textarea().value).toContain("/tmp/first.md");
    document.body.insertAdjacentHTML("beforeend", '<div data-modal-sheet-open="true"></div>');
    await drop(["/tmp/second.md"]);
    expect(textarea().value).not.toContain("/tmp/second.md");
    expect(textarea().value).toContain("/tmp/first.md");
  });

  it("composerTakesDrop: null hit or null root refuses; a hit inside the root passes", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    expect(composerTakesDrop(null, parent)).toBe(false);
    expect(composerTakesDrop(child, null)).toBe(false);
    expect(composerTakesDrop(child, parent)).toBe(true);
    expect(composerTakesDrop(document.createElement("div"), parent)).toBe(false);
  });
});
