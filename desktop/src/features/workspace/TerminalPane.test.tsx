// @vitest-environment happy-dom
//
// The pane is exercised through injected dependencies, never through module mocking: it runs its
// real effects against a faithful stand-in (terminalDouble.ts) that implements the same surface
// the production wiring does.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalPane } from "./TerminalPane";
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

describe("TerminalPane drag-drop (#5949)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let d: TerminalDouble;

  const render = () =>
    act(async () => root.render(<TerminalPane project="trantor" agent="codex" deps={d.deps} />));

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

  it("a dropped file is written shell-quoted with a trailing space, like typed input", async () => {
    await render();
    await act(async () => { await Promise.resolve(); }); // attach resolves
    const writesBefore = d.written.length;
    d.emitDragDrop({ type: "enter", paths: [], position: { x: 10, y: 10 } });
    expect(d.dragOver).toBe(true);
    d.emitDragDrop({ type: "drop", paths: ["/Users/me/My Shot.png"], position: { x: 10, y: 10 } });
    expect(d.dragOver).toBe(false);
    const dropped = d.written.slice(writesBefore);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].sub).toBe(42);
    expect(dropped[0].data).toBe("'/Users/me/My Shot.png' ");
  });

  it("several dropped paths arrive space-separated, quotes spelled the POSIX way", async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    d.emitDragDrop({ type: "drop", paths: ["/a b.png", "/c's d.md"], position: { x: 1, y: 1 } });
    expect(d.written[d.written.length - 1]?.data).toBe("'/a b.png' '/c'\\''s d.md' ");
  });

  it("unicode paths survive byte-for-byte", async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    d.emitDragDrop({ type: "drop", paths: ["/Users/me/照片.md"], position: { x: 1, y: 1 } });
    expect(d.written[d.written.length - 1]?.data).toBe("'/Users/me/照片.md' ");
  });
});
