// @vitest-environment happy-dom
// #13987/#14044 drill: the left column is a source control sidebar that folds to a rail, resizes,
// remembers itself, opens files, and opens Code on a clicked change or commit. Fakes sit at the
// Tauri IPC and the hub transport only; the terminal is injected through panes.tsx like Workspace.test does.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { MODE_KEY } from "../../shell/shellMode";
import { takeOpenIntent } from "../../shell/openIntent";
import { WorkspaceScreen } from "./index";
import { DEFAULT_PANES, WorkspacePanesContext } from "./panes";
import { FILES_OPEN_KEY, FILES_WIDTH_KEY } from "./chatColumnState";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANES = { ...DEFAULT_PANES, TerminalPane: () => <div data-testid="terminal" />, RightPanel: () => <section aria-label="Project panel" /> };
const client = () => new HubClient("http://hub.test", async () => ({ status: 200, body: JSON.stringify({ peers: [], tasks: [], holds: [] }) }));
const ROOTS = JSON.stringify([{ name: "README.md", path: "README.md", dir: false }]);
const PANEL = {
  branch: "main", upstream: "origin/main", ahead: 0, behind: 0,
  status: [{ path: "bin/a.mjs", x: " ", y: "M" }, { path: "src/staged.ts", x: "M", y: " " }],
  counts: [{ path: "bin/a.mjs", plus: 4, minus: 1 }],
  log: [{ sha: "abc1234", author: "orchestrator", when: "2 hours ago", subject: "#13988 Land the checkout panel" }],
};

let host: HTMLDivElement;
let root: Root;
let navigated: string[];
let herdrSeatsReply = "[]";
beforeEach(() => {
  navigated = [];
  herdrSeatsReply = "[]";
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC((command, payload) => {
    if (command === "herdr_seats") return herdrSeatsReply;
    if (command === "identity_name") return "sasha";
    if (command === "project_files") return ROOTS;
    if (command === "git_panel") {
      // SAFETY: mockIPC types payload as unknown; git_panel is invoked with an object of named args.
      const args = (payload ?? {}) as { agent?: string; scope?: string };
      if (args.agent) return JSON.stringify({ ...PANEL, branch: `seat/${args.agent}`, upstream: null, ahead: 3, behind: null });
      return JSON.stringify(PANEL);
    }
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

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const mountScreen = async (c?: ReturnType<typeof client>) => {
  await act(async () => {
    root.render(<WorkspacePanesContext.Provider value={PANES}>
      <WorkspaceScreen client={c ?? client()} project="trantor" onNavigate={s => { navigated.push(s); }} />
    </WorkspacePanesContext.Provider>);
  });
  await settle();
  await settle();
};
const handle = () => host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize files"]');
const column = () => host.querySelector<HTMLElement>('aside[aria-label="Source control"]');
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

describe("the source control sidebar (#14044)", () => {
  beforeEach(() => { localStorage.setItem(FILES_OPEN_KEY, "true"); });

  it("reads Source control with the branch, the scope name and all three sections", async () => {
    await mountScreen();
    const col = column();
    expect(col?.textContent).toContain("Source control");
    expect(col?.textContent).toContain("main");
    expect(col?.textContent).toContain("project checkout");
    expect(col?.querySelector('[data-section-body="changes"]')).not.toBeNull();
    expect(col?.querySelector('[data-section-body="files"]')).not.toBeNull();
    expect(col?.querySelector('[data-section-body="commits"]')).not.toBeNull();
  });

  it("clicking a changed file opens Code on that file's diff", async () => {
    await mountScreen();
    await click(column()?.querySelector('button[title="Show the diff for bin/a.mjs"]') ?? null);
    expect(navigated).toEqual(["code"]);
    expect(takeOpenIntent("trantor")).toEqual({ kind: "change", path: "bin/a.mjs", seat: undefined });
  });

  it("clicking a commit opens Code on History with that commit", async () => {
    await mountScreen();
    await click(column()?.querySelector('[data-sha="abc1234"]') ?? null);
    expect(navigated).toEqual(["code"]);
    expect(takeOpenIntent("trantor")).toEqual({ kind: "commit", sha: "abc1234", seat: undefined });
  });

  it("still opens a file from the tree through a file intent", async () => {
    await mountScreen();
    const row = [...(column()?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(b => b.textContent?.includes("README.md"));
    expect(row).toBeDefined();
    await click(row ?? null);
    expect(navigated).toEqual(["code"]);
    expect(takeOpenIntent("trantor")).toEqual({ kind: "file", path: "README.md", seat: undefined });
  });
});

describe("Branches and seats (#14047)", () => {
  beforeEach(() => {
    localStorage.setItem(MODE_KEY, "developer");
    localStorage.setItem(FILES_OPEN_KEY, "true");
    herdrSeatsReply = JSON.stringify([{ project: "trantor", agent: "orchestrator", surface: "s1", kind: "orch" }]);
  });

  const seatPeersClient = () => new HubClient("http://hub.test", async ({ path }) => {
    const peers = [{ session: "codex-8:trantor", project: "trantor", online: true, kind: "agent", llm: "codex" }];
    if (path.startsWith("/peers")) return { status: 200, body: JSON.stringify({ peers }) };
    return { status: 200, body: JSON.stringify({ tasks: [], holds: [] }) };
  });

  it("lists the main checkout and each seat with its branch and unlanded count", async () => {
    await mountScreen(seatPeersClient());
    const col = column();
    expect(col?.querySelector('button[data-scope-row="main"]')?.textContent).toContain("main checkout");
    const row = col?.querySelector<HTMLButtonElement>('button[data-scope-row="codex-8"]');
    expect(row?.textContent).toContain("codex-8");
    expect(row?.textContent).toContain("seat/codex-8");
    expect(row?.textContent).toContain("↑3");
    expect(row?.disabled).toBe(false);
  });

  it("clicking a seat row reads that seat's changes in the sidebar; the main row returns to the checkout", async () => {
    await mountScreen(seatPeersClient());
    await click(column()?.querySelector('button[data-scope-row="codex-8"]') ?? null);
    await settle(); await settle();
    expect(column()?.querySelector("header")?.textContent).toContain("seat/codex-8");
    expect(column()?.querySelector('button[data-scope-row="codex-8"]')?.getAttribute("aria-pressed")).toBe("true");
    await click(column()?.querySelector('button[data-scope-row="main"]') ?? null);
    await settle(); await settle();
    expect(column()?.querySelector("header")?.textContent).toContain("main");
    expect(column()?.querySelector('button[data-scope-row="main"]')?.getAttribute("aria-pressed")).toBe("true");
  });
});
