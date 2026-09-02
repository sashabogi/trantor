// @vitest-environment happy-dom
//
// The pane is exercised through injected dependencies, never through module mocking: it runs its
// real effects against a faithful stand-in (terminalDouble.ts) that implements the same surface
// the production wiring does.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalPane } from "./TerminalPane";
import { quotePaths } from "./quotePaths";
import { installResizeObserver, makeTerminalDouble, type TerminalDouble } from "./terminalDouble";

// SAFETY: React reads this flag off the global object to enable act(); it is not in lib.dom's
// typing because it is React's own contract, not a platform API. The assertion only widens
// globalThis by that one boolean and writes it, so nothing else is reinterpreted.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installResizeObserver();

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

describe("TerminalPane", () => {
  let host: HTMLDivElement;
  let root: Root;
  let d: TerminalDouble;

  const render = (double: TerminalDouble) =>
    act(async () => root.render(<TerminalPane project="trantor" agent="codex" deps={double.deps} />));

  beforeEach(() => {
    d = makeTerminalDouble();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("attaches the selected herdr surface and streams bytes into xterm", async () => {
    await render(d);
    await flush();

    expect(d.attached).toEqual(["pane-1"]);
    d.emitBytes([36, 32]);
    expect(d.writes).toEqual([new Uint8Array([36, 32])]);
  });

  it("sends xterm input straight to term_write and detaches on unmount", async () => {
    await render(d);
    await flush();

    d.emitData("[A");
    expect(d.written).toEqual([{ sub: 42, data: "[A" }]);

    act(() => root.unmount());
    expect(d.detached).toEqual([42]);
    expect(d.disposed).toBe(true);
  });

  it("coalesces a printable multi-char burst into ONE bracketed paste", async () => {
    await render(d);
    await flush();

    d.emitData("hello ");
    d.emitData("world ");
    d.emitData("again");
    expect(d.written).toEqual([]); // buffered, nothing written mid-burst
    await new Promise(resolve => setTimeout(resolve, 45));
    expect(d.written).toEqual([{ sub: 42, data: "\x1b[200~hello world again\x1b[201~" }]);
  });

  it("records keystroke-to-echo latency when streamed bytes return", async () => {
    await render(d);
    await flush();

    d.emitData("x");
    await new Promise(resolve => setTimeout(resolve, 8));
    await act(async () => {
      d.emitBytes([120]);
      await Promise.resolve();
    });

    const measured = Number((host.textContent ?? "").match(/echo (\d+)ms/)?.[1]);
    console.log(`terminal_echo_latency_ms=${measured}`);
    expect(measured).toBeGreaterThanOrEqual(0);
    expect(measured).toBeLessThan(100);
  });

  it("fits and resizes the pty after attach and container resize", async () => {
    await render(d);
    await flush();

    expect(d.resized).toEqual([{ sub: 42, cols: 100, rows: 30 }]);
    d.fireResize();
    expect(d.resized[d.resized.length - 1]).toEqual({ sub: 42, cols: 100, rows: 30 });
  });

  it("opens a project session when the ORCHESTRATOR has no pane", async () => {
    const empty = makeTerminalDouble({ surface: null });
    await act(async () => root.render(
      <TerminalPane project="trantor" agent="orchestrator" deps={empty.deps} />,
    ));
    await flush();

    expect(empty.attached).toEqual([]);

    await act(async () => {
      host.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(empty.opened).toEqual(["trantor"]);
    expect(empty.attached).toEqual(["opened-pane"]);
  });

  // "Wake session" starts the OPERATOR's session. Offering it on a seat meant clicking it under
  // kimi opened your own session and rendered it under kimi's name.
  it("never offers to open a session on a SEAT that has no pane", async () => {
    const empty = makeTerminalDouble({ surface: null });
    await render(empty);
    await flush();

    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("trantor up codex");
    expect(empty.opened).toEqual([]);
  });
});

describe("TerminalPane drag-drop (#5949, leak fixed #5949-bounce)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let d: TerminalDouble;
  let sheet: HTMLDivElement | null = null;

  const render = () =>
    act(async () => root.render(<TerminalPane project="trantor" agent="codex" deps={d.deps} />));

  // elementFromPoint decides "over this pane": point it at the pane's own host div, or at a
  // floating sheet ABOVE the pane to reproduce the leak (a rectangle test passed then, too).
  const pointInsidePane = () => {
    document.elementFromPoint = () => document.querySelector('[data-pane] > div');
  };
  const pointAtCoveringSheet = () => {
    sheet = document.createElement("div");
    sheet.setAttribute("data-testid", "sheet");
    document.body.appendChild(sheet);
    document.elementFromPoint = () => sheet;
  };

  beforeEach(() => {
    d = makeTerminalDouble();
    sheet = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    sheet?.remove();
    sheet = null;
    document.elementFromPoint = () => null;
  });

  it("a dropped file is written shell-quoted with a trailing space, like typed input", async () => {
    await render();
    await act(async () => { await Promise.resolve(); }); // attach resolves
    pointInsidePane();
    act(() => { d.emitDragDrop({ type: "enter", paths: [], position: { x: 10, y: 10 } }); });
    expect(host.querySelector("[data-drag-over]")?.getAttribute("data-drag-over")).toBe("true");
    act(() => { d.emitDragDrop({ type: "drop", paths: ["/Users/me/My Shot.png"], position: { x: 10, y: 10 } }); });
    expect(host.querySelector("[data-drag-over]")?.getAttribute("data-drag-over")).toBe("false");
    const dropped = d.written.slice(d.written.length - 1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].sub).toBe(42);
    expect(dropped[0].data).toBe("'/Users/me/My Shot.png' ");
  });

  it("several dropped paths arrive space-separated, quotes spelled the POSIX way", async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    pointInsidePane();
    act(() => { d.emitDragDrop({ type: "drop", paths: ["/a b.png", "/c's d.md"], position: { x: 1, y: 1 } }); });
    expect(d.written[d.written.length - 1]?.data).toBe(quotePaths(["/a b.png", "/c's d.md"]) + " ");
  });

  it("a drop on a sheet covering the pane writes NOTHING — the topmost element decides", async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    pointAtCoveringSheet();
    const writesBefore = d.written.length;
    act(() => { d.emitDragDrop({ type: "enter", paths: [], position: { x: 10, y: 10 } }); });
    // the ring stays OFF: the topmost element is the sheet, not this pane
    expect(host.querySelector("[data-drag-over]")?.getAttribute("data-drag-over")).toBe("false");
    act(() => { d.emitDragDrop({ type: "drop", paths: ["/Users/me/PRD.md"], position: { x: 10, y: 10 } }); });
    expect(d.written.length).toBe(writesBefore);
  });

  it("a drop with no position is never ours", async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    const writesBefore = d.written.length;
    act(() => { d.emitDragDrop({ type: "drop", paths: ["/Users/me/x.png"], position: undefined }); });
    expect(d.written.length).toBe(writesBefore);
  });

  it("unicode paths survive byte-for-byte", async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    pointInsidePane();
    act(() => { d.emitDragDrop({ type: "drop", paths: ["/Users/me/照片.md"], position: { x: 1, y: 1 } }); });
    expect(d.written[d.written.length - 1]?.data).toBe("'/Users/me/照片.md' ");
  });
});
