// @vitest-environment happy-dom
// #13987 drill: the Explorer lives in a left column that folds to a rail, resizes, remembers itself, and really opens files.
// Fakes sit at the Tauri IPC and the hub transport only; the terminal is injected through panes.tsx like Workspace.test does.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { MODE_KEY } from "../../routes";
import { takeOpenIntent } from "../../shell/openIntent";
import { WorkspaceScreen } from "./index";
import { DEFAULT_PANES, WorkspacePanesContext } from "./panes";
import { FILES_OPEN_KEY, FILES_WIDTH_KEY } from "./chatColumnState";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANES = { ...DEFAULT_PANES, TerminalPane: () => <div data-testid="terminal" />, RightPanel: () => <section aria-label="Project panel" /> };
const client = () => new HubClient("http://hub.test", async () => ({ status: 200, body: JSON.stringify({ peers: [], tasks: [], holds: [] }) }));
const ROOTS = JSON.stringify([{ name: "README.md", path: "README.md", dir: false }]);

let host: HTMLDivElement;
let root: Root;
let navigated: string[];
beforeEach(() => {
  navigated = [];
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC(command => {
    if (command === "herdr_seats") return "[]";
    if (command === "identity_name") return "sasha";
    if (command === "project_files") return ROOTS;
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove(); clearMocks(); vi.unstubAllGlobals();
  takeOpenIntent("trantor");
});

const mountScreen = async () => {
  await act(async () => {
    root.render(<WorkspacePanesContext.Provider value={PANES}>
      <WorkspaceScreen client={client()} project="trantor" onNavigate={s => { navigated.push(s); }} />
    </WorkspacePanesContext.Provider>);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
};
const handle = () => host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize files"]');
const column = () => host.querySelector<HTMLElement>('aside[aria-label="Files column"]');
const rail = () => host.querySelector<HTMLElement>('aside[aria-label="Files rail"]');
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const widthNow = () => Number(handle()?.getAttribute("aria-valuenow"));
const key = (k: string) => act(async () => { handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
const pointer = (type: string, clientX: number, target: EventTarget) => act(async () => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
});

describe("defaults by mode", () => {
  it("is a rail in Orchestrator mode", async () => {
    await mountScreen();
    expect(rail()).not.toBeNull();
    expect(column()).toBeNull();
    expect(byLabel("Open files")?.title).not.toBe("");
  });

  it("is open in Developer mode", async () => {
    localStorage.setItem(MODE_KEY, "developer");
    await mountScreen();
    expect(column()).not.toBeNull();
    expect(rail()).toBeNull();
    expect(column()?.textContent).toContain("project checkout");
  });

  it("a stored choice beats the mode default", async () => {
    localStorage.setItem(MODE_KEY, "developer");
    localStorage.setItem(FILES_OPEN_KEY, "false");
    await mountScreen();
    expect(rail()).not.toBeNull();
  });
});

describe("collapse and persistence", () => {
  it("opens from the rail, collapses back, and remembers both", async () => {
    await mountScreen();
    await click(byLabel("Open files"));
    expect(column()).not.toBeNull();
    expect(localStorage.getItem(FILES_OPEN_KEY)).toBe("true");
    await click(byLabel("Collapse files"));
    expect(rail()).not.toBeNull();
    expect(localStorage.getItem(FILES_OPEN_KEY)).toBe("false");
  });
});

describe("resizing", () => {
  beforeEach(() => { localStorage.setItem(FILES_OPEN_KEY, "true"); });

  it("is a vertical separator on the right edge with min 180 and 40% max", async () => {
    await mountScreen();
    expect(handle()?.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle()?.getAttribute("aria-valuemin")).toBe("180");
    expect(Number(handle()?.getAttribute("aria-valuemax"))).toBe(Math.floor(window.innerWidth * 0.4));
    expect(widthNow()).toBe(260);
  });

  it("dragging right widens it and the width persists", async () => {
    await mountScreen();
    const h = handle();
    if (!h) throw new Error("no handle");
    await pointer("pointerdown", 300, h);
    await pointer("pointermove", 360, window);
    await pointer("pointerup", 360, window);
    expect(widthNow()).toBe(320);
    expect(localStorage.getItem(FILES_WIDTH_KEY)).toBe("320");
  });

  it("arrow keys move it 16px, double-click resets, and the clamps hold", async () => {
    await mountScreen();
    await key("ArrowRight");
    expect(widthNow()).toBe(276);
    await key("ArrowLeft");
    await key("ArrowLeft");
    expect(widthNow()).toBe(244);
    await act(async () => { handle()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(widthNow()).toBe(260);
    for (let i = 0; i < 20; i++) await key("ArrowLeft");
    expect(widthNow()).toBe(180);
  });
});

describe("opening a file", () => {
  it("sets a file intent for the project checkout and goes to Code", async () => {
    localStorage.setItem(FILES_OPEN_KEY, "true");
    await mountScreen();
    const row = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(b => b.textContent?.includes("README.md"));
    expect(row).toBeDefined();
    await click(row ?? null);
    expect(navigated).toEqual(["code"]);
    expect(takeOpenIntent("trantor")).toEqual({ kind: "file", path: "README.md", seat: undefined });
  });
});
