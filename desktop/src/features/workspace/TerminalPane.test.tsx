// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "./TerminalPane";
import {
  emitAttachedBytes,
  lastTerminal,
  resetTerminalMocks,
  resizeObserverInstances,
} from "./testTerminalMocks";
import { orchestratorOpen, termAttach, termDetach, termResize, termWrite } from "./herdr";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@xterm/xterm", () => import("./testTerminalMocks").then(m => ({ Terminal: m.MockTerminal })));
vi.mock("@xterm/addon-fit", () => import("./testTerminalMocks").then(m => ({ FitAddon: m.MockFitAddon })));
vi.mock("@xterm/addon-webgl", () => import("./testTerminalMocks").then(m => ({ WebglAddon: m.MockWebglAddon })));
vi.mock("./herdr", async () => {
  const actual = await vi.importActual<typeof import("./herdr")>("./herdr");
  return {
    ...actual,
    surfaceFor: vi.fn(async () => "pane-1"),
    orchestratorOpen: vi.fn(async () => "opened-pane"),
    termAttach: vi.fn(async (_target: string, onBytes: (bytes: number[]) => void) => {
      emitAttachedBytes.current = onBytes;
      return 42;
    }),
    termWrite: vi.fn(async () => undefined),
    termResize: vi.fn(async () => undefined),
    termDetach: vi.fn(async () => undefined),
  };
});

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

describe("TerminalPane", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTerminalMocks();
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("attaches the selected herdr surface and streams bytes into xterm", async () => {
    await act(async () => root.render(<TerminalPane project="trantor" agent="codex" />));
    await flush();

    expect(termAttach).toHaveBeenCalledWith("pane-1", expect.any(Function));
    emitAttachedBytes.current?.([36, 32]);
    expect(lastTerminal()?.writes).toEqual([new Uint8Array([36, 32])]);
  });

  it("sends xterm input straight to term_write and detaches on unmount", async () => {
    await act(async () => root.render(<TerminalPane project="trantor" agent="codex" />));
    await flush();

    lastTerminal()?.emitData("\u001b[A");
    expect(termWrite).toHaveBeenCalledWith(42, "\u001b[A");

    act(() => root.unmount());
    expect(termDetach).toHaveBeenCalledWith(42);
  });

  it("records keystroke-to-echo latency when streamed bytes return", async () => {
    await act(async () => root.render(<TerminalPane project="trantor" agent="codex" />));
    await flush();

    lastTerminal()?.emitData("x");
    await new Promise(resolve => setTimeout(resolve, 8));
    await act(async () => {
      emitAttachedBytes.current?.([120]);
      await Promise.resolve();
    });

    const measured = Number((host.textContent ?? "").match(/echo (\d+)ms/)?.[1]);
    console.log(`terminal_echo_latency_ms=${measured}`);
    expect(measured).toBeGreaterThanOrEqual(0);
    expect(measured).toBeLessThan(100);
  });

  it("fits and resizes the pty after attach and container resize", async () => {
    await act(async () => root.render(<TerminalPane project="trantor" agent="codex" />));
    await flush();

    expect(termResize).toHaveBeenCalledWith(42, 100, 30);
    resizeObserverInstances[resizeObserverInstances.length - 1]?.fire();
    expect(termResize).toHaveBeenLastCalledWith(42, 100, 30);
  });

  it("opens a project session when no pane exists", async () => {
    vi.mocked(termAttach).mockClear();
    const herdr = await import("./herdr");
    vi.mocked(herdr.surfaceFor).mockResolvedValueOnce(null);

    await act(async () => root.render(<TerminalPane project="trantor" agent="codex" />));
    await flush();

    await act(async () => {
      host.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(orchestratorOpen).toHaveBeenCalledWith("trantor");
    expect(termAttach).toHaveBeenCalledWith("opened-pane", expect.any(Function));
  });
});
