// @vitest-environment happy-dom
// #14047 drill: Branches and seats lists the main checkout and every seat with branch and unlanded
// count, marks the scope on screen, disables worktree-less seats with the reason in the title, and
// a row click re-scopes the sidebar. Fakes: the Tauri IPC and a per-test localStorage.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { BranchesSection } from "./BranchesSection";
import type { SeatInfo } from "../../screens/Code/model";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAIN_PANEL = { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, status: [], counts: [], log: [] };
const SEAT_PANEL = { branch: "seat/glm-5", upstream: null, ahead: 2, behind: null, status: [], counts: [], log: [] };

const SEATS: SeatInfo[] = [
  { seat: "glm-5", presence: "working", branch: "seat/glm-5", ahead: 2, machine: null, hasWorktree: true },
  { seat: "kimi-9", presence: "offline", branch: null, ahead: null, machine: "netcup", hasWorktree: false },
];

type IpcArgs = { scope?: string; agent?: string; limit?: number };
let calls: IpcArgs[];
let picked: (string | null)[];
let scope: string | null;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls = []; picked = []; scope = "glm-5";
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC((command, payload) => {
    if (command !== "git_panel") return null;
    // SAFETY: mockIPC types payload as unknown; git_panel is invoked with an object of named args.
    const args = (payload ?? {}) as IpcArgs;
    calls.push(args);
    return JSON.stringify(args.agent ? SEAT_PANEL : MAIN_PANEL);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove(); clearMocks(); vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const render = async () => {
  await act(async () => {
    root.render(<BranchesSection project="trantor" scope={scope} seats={SEATS} onPickScope={s => picked.push(s)} />);
  });
  await flush();
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const row = (name: string) => host.querySelector<HTMLButtonElement>(`button[data-scope-row="${name}"]`);

describe("Branches and seats", () => {
  it("reads the main checkout's branch through the git bridge and labels the row", async () => {
    await render();
    expect(calls).toEqual([{ project: "trantor", scope: "project" }]);
    expect(row("main")?.textContent).toContain("main");
    expect(row("main")?.textContent).toContain("main checkout");
    expect(row("main")?.title).toContain("main");
  });

  it("lists every seat with its label, branch and unlanded count", async () => {
    await render();
    expect(row("glm-5")?.textContent).toContain("glm-5");
    expect(row("glm-5")?.textContent).toContain("seat/glm-5");
    expect(row("glm-5")?.textContent).toContain("↑2");
  });

  it("marks the scope on screen current and only that row", async () => {
    await render();
    expect(row("glm-5")?.getAttribute("aria-pressed")).toBe("true");
    expect(row("main")?.getAttribute("aria-pressed")).toBe("false");
    expect(row("kimi-9")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("a seat row click re-scopes, the main row goes back to the checkout", async () => {
    await render();
    await click(row("glm-5"));
    await click(row("main"));
    expect(picked).toEqual(["glm-5", null]);
  });

  it("a seat with no worktree is disabled with the reason in its title", async () => {
    await render();
    const kimi = row("kimi-9");
    expect(kimi?.disabled).toBe(true);
    expect(kimi?.title).toContain("no worktree");
    await click(kimi);
    expect(picked).toEqual([]);
  });

  it("no seats says so instead of stub rows", async () => {
    await act(async () => {
      root.render(<BranchesSection project="trantor" scope={null} seats={[]} onPickScope={s => picked.push(s)} />);
    });
    await flush();
    expect(host.textContent).toContain("No seat sessions for this project.");
  });
});
