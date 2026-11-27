// @vitest-environment happy-dom
// #13987 drill: the chat column resizes, folds to a rail, and its header is icons over the chat, not four tabs.
// Fakes sit at the Tauri IPC and the hub transport only; the terminal is injected through panes.tsx like Workspace.test does.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { WorkspaceScreen } from "./index";
import { RightPanel } from "./RightPanel";
import { DEFAULT_PANES, WorkspacePanesContext } from "./panes";
import { OPEN_KEY, WIDTH_KEY } from "./chatColumnState";
import { takeOpenIntent } from "../../shell/openIntent";
import { getPanelSlot, togglePanel } from "../../shell/panelSlots";
import type { SeatView } from "./seatModel";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #14512: no close X rides the chat column anymore; the real panel closes from the More menu
// and the top bar's right toggle, which these tests drive through the slot the screen registers.
const PANES = { ...DEFAULT_PANES, TerminalPane: () => <div data-testid="terminal" />, RightPanel: () => <section aria-label="Project panel" /> };
const client = () => new HubClient("http://hub.test", async () => ({ status: 200, body: JSON.stringify({ peers: [], tasks: [], holds: [] }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC(command => {
    if (command === "herdr_seats") return "[]";
    if (command === "identity_name") return "sasha";
    if (command === "handoff_states") return [];
    if (command === "sessions_list") return "[]";
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  // Chat's event listeners unlisten through the Tauri bridge a tick after unmount; keep it alive until then.
  await act(async () => { await new Promise(r => setTimeout(r, 5)); });
  host.remove(); clearMocks(); vi.unstubAllGlobals();
});

const mountScreen = async () => {
  await act(async () => { root.render(<WorkspacePanesContext.Provider value={PANES}><WorkspaceScreen client={client()} project="trantor" onNavigate={() => {}} /></WorkspacePanesContext.Provider>); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
};
const handle = () => host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize chat"]');
const column = () => host.querySelector<HTMLElement>('aside[aria-label="Chat column"]');
const widthNow = () => Number(handle()?.getAttribute("aria-valuenow"));
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const pointer = (type: string, clientX: number, target: EventTarget) => act(async () => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
});
const key = (k: string) => act(async () => { handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
const drag = async (from: number, to: number) => {
  const h = handle();
  if (!h) throw new Error("no resize handle");
  await pointer("pointerdown", from, h);
  await pointer("pointermove", to, window);
  await pointer("pointerup", to, window);
};

describe("resizing", () => {
  it("is a focusable vertical separator with its range", async () => {
    await mountScreen();
    const h = handle();
    expect(h?.getAttribute("aria-orientation")).toBe("vertical");
    expect(h?.tabIndex).toBe(0);
    expect(widthNow()).toBe(400);
    expect(h?.getAttribute("aria-valuemin")).toBe("320");
    expect(Number(h?.getAttribute("aria-valuemax"))).toBe(Math.floor(window.innerWidth * 0.6));
  });

  it("dragging left widens it and the width persists", async () => {
    await mountScreen();
    await drag(600, 500);
    expect(widthNow()).toBe(500);
    expect(column()?.style.width).toBe("500px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("500");
  });

  it("arrow keys move it 16px and double-click resets", async () => {
    await mountScreen();
    await key("ArrowLeft");
    expect(widthNow()).toBe(416);
    await key("ArrowRight");
    await key("ArrowRight");
    expect(widthNow()).toBe(384);
    await act(async () => { handle()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(widthNow()).toBe(400);
  });

  it("clamps to the minimum and to 60% of the workspace", async () => {
    await mountScreen();
    await drag(100, 900);
    expect(widthNow()).toBe(320);
    await drag(900, 0);
    expect(widthNow()).toBe(Math.floor(window.innerWidth * 0.6));
  });

  it("reads the saved width on mount", async () => {
    localStorage.setItem(WIDTH_KEY, "470");
    await mountScreen();
    expect(widthNow()).toBe(470);
  });
});

describe("panes as panels (#14250)", () => {
  it("the chat column is its own panel and its splitter fills the gap on its left", async () => {
    await mountScreen();
    const col = column();
    expect(col?.className).not.toContain("border-l");
    const pane = col?.firstElementChild;
    expect(pane?.className).toContain("rounded-lg");
    expect(pane?.className).toContain("border-[var(--v2-edge)]");
    expect(pane?.className).toContain("bg-[var(--v2-side)]");
    expect(pane?.className).toContain("overflow-hidden");
    expect(handle()?.className).toContain("-left-[6px]");
  });

  it("the closed rail is a rounded panel, not a border-l strip", async () => {
    localStorage.setItem(OPEN_KEY, "false");
    await mountScreen();
    const rail = host.querySelector('aside[aria-label="Chat rail"]');
    expect(rail?.className).toContain("rounded-lg");
    expect(rail?.className).toContain("border-[var(--v2-edge)]");
    expect(rail?.className).not.toContain("border-l");
  });
});

describe("collapsing", () => {
  it("closes to a rail from the top bar's right toggle, reopens at the same width, and remembers", async () => {
    await mountScreen();
    await drag(600, 520);
    expect(getPanelSlot("right")?.open).toBe(true);
    await act(async () => { togglePanel("right"); });
    expect(column()).toBeNull();
    expect(host.querySelector('aside[aria-label="Chat rail"]')).not.toBeNull();
    expect(localStorage.getItem(OPEN_KEY)).toBe("false");
    expect(getPanelSlot("right")?.open).toBe(false);
    await click(byLabel("Open chat"));
    expect(widthNow()).toBe(480);
    expect(localStorage.getItem(OPEN_KEY)).toBe("true");
  });

  it("stays a rail when it was saved closed", async () => {
    localStorage.setItem(OPEN_KEY, "false");
    await mountScreen();
    expect(byLabel("Open chat")).not.toBeNull();
  });
});

describe("header", () => {
  const mountPanel = async (onClose = () => {}) => {
    await act(async () => { root.render(<RightPanel project="trantor" seat={undefined} orchestrator={undefined} changed={2} onNavigate={() => {}} onClose={onClose} />); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  };

  it("has icon buttons, no Files button, no close X and no tablist", async () => {
    await mountPanel();
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(byLabel("Files")).toBeNull();
    for (const l of ["New chat", "Sessions", "Git", "More"]) {
      const b = byLabel(l);
      expect(b, l).not.toBeNull();
      expect(b?.title, l).not.toBe("");
    }
    expect(byLabel("Close chat")).toBeNull();
    expect(byLabel("New chat")?.disabled).toBe(false);
  });

  it("opens Sessions as a sheet over the chat and Back returns to it", async () => {
    await mountPanel();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await click(byLabel("Sessions"));
    expect(host.querySelector('[role="dialog"][aria-label="Sessions"]')).not.toBeNull();
    expect(host.querySelector("[data-v2-chat]")).not.toBeNull();
    await click(byLabel("Back to chat"));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Git sets a source-control intent for the selected crew seat and opens Code", async () => {
    const nav: string[] = [];
    const target = { key: "codex-8", label: "codex-8", agent: "codex-8", brand: "codex", session: "codex-8:trantor", online: true, isOrchestrator: false };
    const seat: SeatView = { ...target, presence: "working", words: "working", target };
    await act(async () => { root.render(<RightPanel project="trantor" seat={seat} orchestrator={undefined} changed={0} onNavigate={s => { nav.push(s); }} onClose={() => {}} />); });
    await click(byLabel("Git"));
    expect(byLabel("Git")?.title).toBe("Open source control");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(nav).toEqual(["code"]);
    expect(takeOpenIntent("trantor")).toEqual({ kind: "source-control", seat: "codex-8" });
  });

  it("Git with no crew seat selected targets the project checkout", async () => {
    await mountPanel();
    await click(byLabel("Git"));
    expect(takeOpenIntent("trantor")).toEqual({ kind: "source-control", seat: undefined });
  });

  it("New chat is a menu whose hand off item invokes the classic handoff_now after a confirm", async () => {
    const calls: unknown[] = [];
    mockIPC((command, args) => {
      if (command === "handoff_now") { calls.push(args); return "ok"; }
      if (command === "plugin:event|listen") return 1;
      if (command === "handoff_states") return [];
      return command === "sessions_list" || command === "herdr_seats" ? "[]" : null;
    });
    await mountPanel();
    await click(byLabel("New chat"));
    const item = () => [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(i => /hand off/i.test(i.textContent ?? "")) ?? null;
    expect(item()?.textContent).toContain("Writes a recap, opens a fresh session that takes over");
    expect([...host.querySelectorAll('[role="menuitem"]')].some(i => i.textContent?.includes("clear"))).toBe(false);
    await click(item());
    expect(calls).toEqual([]);
    await click(item());
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(calls).toEqual([{ project: "trantor", reason: "clicked" }]);
  });

  it("the menu closes the chat", async () => {
    let closed = 0;
    await mountPanel(() => { closed += 1; });
    await click(byLabel("More"));
    await click([...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(i => i.textContent === "Close chat") ?? null);
    expect(closed).toBe(1);
  });
});
