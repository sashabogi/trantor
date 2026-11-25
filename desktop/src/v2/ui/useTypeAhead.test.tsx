// @vitest-environment happy-dom
// Menus with a search field keep the first keystrokes typed right after they open (#14268).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { TopBar } from "../shell/TopBar";
import { QuickOpen } from "./QuickOpen";
import { BranchPicker, type PickerActions } from "../screens/Code/BranchPicker";
import type { ScopeSnapshot } from "../screens/Code/useScopeGit";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
const onProject = vi.fn();
const onClose = vi.fn();
const PROJECTS = ["alpha", "drill-one", "drillbit", "gamma"];
const acts: PickerActions = { onCheckout: vi.fn(), onSeat: vi.fn(), onCompare: vi.fn(), onMessage: vi.fn(), onCopy: vi.fn() };
const snap: ScopeSnapshot = { scope: null, branch: "main", upstream: null, remote: null, ahead: 0, behind: 0, status: [], counts: [], log: [], seatBacked: false, readAt: 0 };

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const keyDown = (target: EventTarget, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
// A person's keys: the focused input takes the character itself, anything else only sees the keydown.
const typeLikeUser = (text: string, from: EventTarget = document.body) => {
  for (const ch of text) {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement) {
      keyDown(el, ch);
      act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, el.value + ch); el.dispatchEvent(new Event("input", { bubbles: true })); });
    } else keyDown(from, ch);
  }
};
const fieldOf =(label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  onProject.mockClear(); onClose.mockClear();
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0 });
  mockIPC(command => (command === "git_branch_list" ? JSON.stringify({ current: "main", branches: [{ name: "main", sha: "a".repeat(40), committed_at: 1, ahead: 0, behind: 0, current: true, remote: false, worktree: null }] }) : null));
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); });

describe("project switcher", () => {
  const open = () => {
    act(() => root.render(<TopBar projects={PROJECTS} project="alpha" onProject={onProject} mode="orchestrator" onMode={vi.fn()}
      onSearch={vi.fn()} needsYou={0} me="me" onNavigate={vi.fn()} onStartProject={vi.fn()} onBackToClassic={vi.fn()} />));
    act(() => { host.querySelector<HTMLButtonElement>('button[title="Switch project"]')!.click(); });
  };
  it("focuses the field the moment the menu opens", () => {
    open();
    expect(document.activeElement).toBe(fieldOf("Find a project"));
  });
  it("keeps keys that reach the trigger before the field has focus", () => {
    open();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    typeLikeUser("drill", host.querySelector('button[title="Switch project"]')!);
    expect(fieldOf("Find a project").value).toBe("drill");
    expect(document.activeElement).toBe(fieldOf("Find a project"));
  });
  it("Escape closes and the arrows move the highlight", () => {
    open();
    typeLikeUser("dr");
    keyDown(fieldOf("Find a project"), "ArrowDown");
    expect(document.querySelector('[role="menuitem"][aria-current]')?.textContent).toContain("drillbit");
    keyDown(document.body, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("Go to file", () => {
  it("catches 'drill' typed immediately and still closes on Escape", async () => {
    act(() => root.render(<QuickOpen project="p" onOpen={vi.fn()} onClose={onClose} search={async () => ["a/drill.ts", "b/drill2.ts"]} />));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    typeLikeUser("drill");
    expect(fieldOf("Go to file").value).toBe("drill");
    await flush();
    keyDown(fieldOf("Go to file"), "Escape");
    expect(onClose).toHaveBeenCalled();
  });
  it("arrow keys still move the highlight", async () => {
    act(() => root.render(<QuickOpen project="p" onOpen={vi.fn()} onClose={onClose} search={async () => ["a/drill.ts", "b/drill2.ts"]} />));
    typeLikeUser("drill");
    await flush();
    const rows = () => [...document.querySelectorAll("button")].filter(b => b.textContent?.includes("drill"));
    const selected = () => rows().findIndex(b => b.className.includes("v2-raised"));
    expect(selected()).toBe(0);
    keyDown(fieldOf("Go to file"), "ArrowDown");
    expect(selected()).toBe(1);
  });
});

describe("branch picker", () => {
  it("catches 'drill' typed immediately", async () => {
    await act(async () => { root.render(<BranchPicker project="trantor" seats={[]} snap={snap} scope={null} acts={acts} onClose={onClose} onMutated={vi.fn()} onError={vi.fn()} onOpenConflict={vi.fn()} />); });
    await flush();
    const field = document.querySelector<HTMLInputElement>("#v2-branch-filter")!;
    expect(document.activeElement).toBe(field);
    field.blur();
    typeLikeUser("drill");
    expect(field.value).toBe("drill");
  });
});
