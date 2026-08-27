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

  it("opens a project session when no pane exists", async () => {
    const empty = makeTerminalDouble({ surface: null });
    await render(empty);
    await flush();

    expect(empty.attached).toEqual([]);

    await act(async () => {
      host.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(empty.opened).toEqual(["trantor"]);
    expect(empty.attached).toEqual(["opened-pane"]);
  });
});
