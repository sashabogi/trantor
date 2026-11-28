// @vitest-environment happy-dom
// Bottom panel frame: real storage, pointer and keyboard events; only tab bodies are fixtures (#14071).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_KEY } from "../../shell/shellMode";
import { getPanelSlot, panelAvailable, togglePanel } from "../../shell/panelSlots";
import { BottomPanel } from "./index";
import { ACTIVE_TAB_KEY, HEIGHT_KEY, MAXIMISED_KEY, OPEN_KEY } from "./state";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const TERMINAL = <div data-testid="terminal-body">Terminal body</div>;
const OUTPUT = <div data-testid="output-body">Output body</div>;
const PROBLEMS = <div data-testid="problems-body">Problems body</div>;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value); },
    removeItem: (key: string) => { mem.delete(key); },
    clear: () => mem.clear(), key: () => null, length: 0,
  });
  localStorage.setItem(MODE_KEY, "developer");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

async function mountPanel(props?: { terminal?: ReactNode; output?: ReactNode; problems?: ReactNode }) {
  await act(async () => {
    root.render(<BottomPanel {...(props ?? { terminal: TERMINAL, output: OUTPUT, problems: PROBLEMS })} />);
  });
}

async function remountPanel() {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await mountPanel();
}

const panel = () => host.querySelector<HTMLElement>('section[aria-label="Bottom panel"]');
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(element => element.textContent === label);
const handle = () => host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize bottom panel"]');
const click = (element: Element | null | undefined) => act(async () => { if (element instanceof HTMLElement) element.click(); });
const ctrlBacktick = () => act(async () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true, bubbles: true }));
});
const arrow = (key: string) => act(async () => {
  handle()?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});
const pointer = (type: string, clientY: number, target: EventTarget) => act(async () => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY }));
});

describe("rendering", () => {
  it("renders neither the panel nor a toggle without bodies, and registers no panel slot", async () => {
    await mountPanel({});
    expect(panel()).toBeNull();
    expect(byLabel("Open bottom panel")).toBeNull();
    expect(panelAvailable("bottom")).toBe(false);
    await ctrlBacktick();
    expect(panel()).toBeNull();
    expect(localStorage.getItem(OPEN_KEY)).toBeNull();
  });

  it("opens in Developer mode with test bodies and filters empty tabs", async () => {
    await mountPanel();
    expect(panel()).not.toBeNull();
    expect(tab("Terminal")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="terminal-body"]')).not.toBeNull();
    await act(async () => { root.render(<BottomPanel output={OUTPUT} />); });
    expect(tab("Terminal")).toBeUndefined();
    expect(tab("Output")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="output-body"]')).not.toBeNull();
  });

  it("starts closed in Orchestrator mode and honours a saved closed Developer choice", async () => {
    localStorage.removeItem(MODE_KEY);
    await mountPanel();
    expect(panel()).toBeNull();
    // #14512: no open button rides the closed panel; the chord and the top bar bring it back.
    expect(byLabel("Open bottom panel")).toBeNull();
    await ctrlBacktick();
    expect(panel()).not.toBeNull();
    await act(async () => { root.unmount(); });
    localStorage.setItem(MODE_KEY, "developer");
    localStorage.setItem(OPEN_KEY, "false");
    root = createRoot(host);
    await mountPanel();
    expect(panel()).toBeNull();
  });
});

describe("the shell's bottom panel slot (#14512)", () => {
  it("registers while mounted and the top bar's togglePanel drives it", async () => {
    await mountPanel();
    expect(getPanelSlot("bottom")?.open).toBe(true);
    await act(async () => { togglePanel("bottom"); });
    expect(panel()).toBeNull();
    expect(getPanelSlot("bottom")?.open).toBe(false);
    await act(async () => { togglePanel("bottom"); });
    expect(panel()).not.toBeNull();
    expect(localStorage.getItem(OPEN_KEY)).toBe("true");
    await act(async () => { root.unmount(); });
    expect(panelAvailable("bottom")).toBe(false);
  });
});

describe("controls", () => {
  it("toggles with Ctrl+backtick from the window", async () => {
    await mountPanel();
    await ctrlBacktick();
    expect(panel()).toBeNull();
    expect(localStorage.getItem(OPEN_KEY)).toBe("false");
    await ctrlBacktick();
    expect(panel()).not.toBeNull();
    expect(localStorage.getItem(OPEN_KEY)).toBe("true");
  });

  it("switches tabs and labels every icon button", async () => {
    await mountPanel();
    await click(tab("Output"));
    expect(tab("Output")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="output-body"]')).not.toBeNull();
    expect(localStorage.getItem(ACTIVE_TAB_KEY)).toBe("output");
    await click(tab("Problems"));
    expect(tab("Problems")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="problems-body"]')).not.toBeNull();
    expect(localStorage.getItem(ACTIVE_TAB_KEY)).toBe("problems");
    for (const label of ["Maximise bottom panel", "Close bottom panel"]) {
      expect(byLabel(label)?.title, label).not.toBe("");
    }
    await click(byLabel("Close bottom panel"));
    expect(panel()).toBeNull();
    // #14512: the closed panel is gone entirely; the slot reports it so the cluster can say so.
    expect(byLabel("Open bottom panel")).toBeNull();
    expect(getPanelSlot("bottom")?.open).toBe(false);
  });

  it("maximises inside its parent and restores the previous height", async () => {
    await mountPanel();
    // SAFETY: #14250 wraps the panel in a frame div that owns the height; the maximised section still fills the column.
    const frame = () => host.querySelector<HTMLElement>('section[aria-label="Bottom panel"]')?.parentElement ?? undefined;
    const originalHeight = frame()?.style.height;
    await click(byLabel("Maximise bottom panel"));
    expect(panel()?.className).toContain("absolute inset-0");
    expect(frame()?.style.height).toBe("");
    expect(localStorage.getItem(MAXIMISED_KEY)).toBe("true");
    expect(handle()).toBeNull();
    await remountPanel();
    expect(byLabel("Restore bottom panel")).not.toBeNull();
    expect(panel()?.className).toContain("absolute inset-0");
    await click(byLabel("Restore bottom panel"));
    expect(frame()?.style.height).toBe(originalHeight);
    expect(localStorage.getItem(MAXIMISED_KEY)).toBe("false");
  });

  it("#14250: the panel is a rounded bordered pane and its splitter fills the 6px gap above it", async () => {
    await mountPanel();
    const pane = panel();
    expect(pane?.className).toContain("rounded-lg");
    expect(pane?.className).toContain("border border-[var(--v2-edge)]");
    expect(pane?.className).not.toContain("border-t");
    expect(handle()?.className).toContain("-top-[6px]");
    expect(handle()?.className).toContain("h-[6px]");
    // #14512: closed renders no slim strip of its own — the top bar's bottom toggle is the affordance.
    await click(byLabel("Close bottom panel"));
    expect(panel()).toBeNull();
    expect(host.querySelector('[aria-label="Open bottom panel"]')).toBeNull();
    expect(host.children.length).toBe(0);
  });
});

describe("resizing and persistence", () => {
  it("uses arrow keys and clamps between 120px and 70% of the column", async () => {
    // SAFETY: the panel's column clamp reads only the rectangle's height.
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ height: 1000 } as DOMRect);
    await mountPanel();
    await arrow("ArrowUp");
    expect(handle()?.getAttribute("aria-valuenow")).toBe("256");
    expect(localStorage.getItem(HEIGHT_KEY)).toBe("256");
    for (let i = 0; i < 40; i++) await arrow("ArrowUp");
    expect(handle()?.getAttribute("aria-valuenow")).toBe("700");
    for (let i = 0; i < 60; i++) await arrow("ArrowDown");
    expect(handle()?.getAttribute("aria-valuenow")).toBe("120");
  });

  it("drags its top edge and restores open state, tab and size after a remount", async () => {
    // SAFETY: the panel's column clamp reads only the rectangle's height.
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ height: 1000 } as DOMRect);
    await mountPanel();
    // SAFETY: the panel was mounted open, so its resize handle exists.
    await pointer("pointerdown", 500, handle() as HTMLElement);
    await pointer("pointermove", 400, window);
    await pointer("pointerup", 400, window);
    expect(handle()?.getAttribute("aria-valuenow")).toBe("340");
    expect(localStorage.getItem(HEIGHT_KEY)).toBe("340");
    await click(tab("Output"));
    await click(byLabel("Close bottom panel"));
    await remountPanel();
    expect(panel()).toBeNull();
    // #14512: the chord opens it again; the open button is gone with the closed strip.
    await ctrlBacktick();
    expect(handle()?.getAttribute("aria-valuenow")).toBe("340");
    expect(tab("Output")?.getAttribute("aria-selected")).toBe("true");
  });
});
