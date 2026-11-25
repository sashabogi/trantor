// @vitest-environment happy-dom
// Project terminals: the real store and component over mocked Tauri IPC; only xterm is a stand-in (#14080).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminals } from "./Terminals";
import { createShellStore, DEFAULT_SHELL_DEPS, SHELL_EXIT_EVENT, type ShellSession, type ShellStore } from "./shellStore";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSession implements ShellSession {
  el = document.createElement("div");
  typed: Array<(data: string) => void> = [];
  visible = false;
  disposed = false;
  cols = 80;
  rows = 24;
  write() { /* output is not under test */ }
  onData(cb: (data: string) => void) { this.typed.push(cb); return { dispose() { /* none */ } }; }
  attach(parent: HTMLElement) { parent.appendChild(this.el); }
  show(visible: boolean) { this.visible = visible; }
  fit() { /* no layout under happy-dom */ }
  focused = 0;
  cleared = 0;
  pasted: string[] = [];
  selected = "";
  titled: Array<(title: string) => void> = [];
  focus() { this.focused += 1; }
  onTitle(cb: (title: string) => void) { this.titled.push(cb); return { dispose() { /* none */ } }; }
  selection() { return this.selected; }
  paste(text: string) { this.pasted.push(text); }
  clear() { this.cleared += 1; }
  title(value: string) { this.titled.forEach(cb => cb(value)); }
  dispose() { this.disposed = true; this.el.remove(); }
  type(data: string) { this.typed.forEach(cb => cb(data)); }
}

type Args = { sub?: number; data?: string; project?: string };
type Call = { command: string; args: Args };
let calls: Call[];
let sessions: FakeSession[];
let nextSub: number;
let store: ShellStore;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls = [];
  sessions = [];
  nextSub = 10;
  mockIPC((command, payload) => {
    // SAFETY: only the three terminal commands are issued here, and their payloads are the Args shape.
    const args = (payload ?? {}) as Args;
    calls.push({ command, args });
    if (command === "term_shell_open") return nextSub++;
    return undefined;
  }, { shouldMockEvents: true });
  store = createShellStore({ ...DEFAULT_SHELL_DEPS, createSession: () => { const s = new FakeSession(); sessions.push(s); return s; } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  clearMocks();
});

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const mount = async (project = "alpha") => { await act(async () => { root.render(<Terminals project={project} store={store} />); }); await settle(); };
const rows = () => [...host.querySelectorAll("ul li")].map(li => li.textContent ?? "");
const click = async (el: HTMLElement | null) => { await act(async () => { el?.click(); }); await settle(); };
const button = (label: string) => host.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
const projectsOpened = () => calls.filter(c => c.command === "term_shell_open").map(c => c.args.project);
const countOf = (command: string) => calls.filter(c => c.command === command).length;

describe("Terminals", () => {
  it("starts one shell on its own when the tab opens with none", async () => {
    await mount();
    expect(countOf("term_shell_open")).toBe(1);
    expect(calls.find(c => c.command === "term_shell_open")?.args.project).toBe("alpha");
    expect(rows()).toEqual(["zsh 1"]);
    expect(sessions[0].visible).toBe(true);
  });

  it("adds a second shell with New terminal and selects it", async () => {
    await mount();
    await click(button("New terminal"));
    expect(rows()).toEqual(["zsh 1", "zsh 2"]);
    expect(sessions.map(s => s.visible)).toEqual([false, true]);
  });

  it("switches the visible shell when a row is clicked", async () => {
    await mount();
    await click(button("New terminal"));
    await click(host.querySelector<HTMLElement>("ul li button"));
    expect(sessions.map(s => s.visible)).toEqual([true, false]);
  });

  it("sends keystrokes to term_write with the right sub", async () => {
    await mount();
    await click(button("New terminal"));
    await act(async () => { sessions[0].type("ls\r"); sessions[1].type("pwd\r"); });
    const writes = calls.filter(c => c.command === "term_write").map(c => c.args);
    expect(writes).toEqual([{ sub: 10, data: "ls\r" }, { sub: 11, data: "pwd\r" }]);
  });

  it("kills a shell through term_detach and drops its row", async () => {
    await mount();
    await click(button("New terminal"));
    await click(button("Kill terminal zsh 1"));
    expect(calls.filter(c => c.command === "term_detach").map(c => c.args)).toEqual([{ sub: 10 }]);
    expect(rows()).toEqual(["zsh 2"]);
    expect(sessions[0].disposed).toBe(true);
    expect(sessions[1].visible).toBe(true);
  });

  it("leaves an empty state with New terminal after the last kill, without respawning", async () => {
    await mount();
    await click(button("Kill terminal zsh 1"));
    expect(rows()).toEqual([]);
    expect(countOf("term_shell_open")).toBe(1);
    const fresh = [...host.querySelectorAll<HTMLElement>("button")].find(b => b.textContent?.includes("New terminal") && !b.getAttribute("aria-label"));
    expect(fresh).toBeTruthy();
    await click(fresh ?? null);
    expect(rows()).toEqual(["zsh 2"]);
  });

  it("keeps a shell that exits on its own, shows its code and restarts it in place", async () => {
    await mount();
    await click(button("New terminal"));
    await click(host.querySelector<HTMLElement>("ul li button"));
    await act(async () => { await emit(SHELL_EXIT_EVENT, { sub: 10, code: 3 }); });
    await settle();
    expect(rows()).toEqual(["zsh 1", "zsh 2"]);
    expect(host.querySelector("[role=status]")?.textContent).toContain("Process exited with code 3");
    expect(countOf("term_detach")).toBe(1);
    await click([...host.querySelectorAll<HTMLElement>("[role=status] button")].find(b => b.textContent === "Restart") ?? null);
    expect(rows()).toEqual(["zsh 1", "zsh 2"]);
    expect(sessions[0].disposed).toBe(true);
    expect(host.querySelector("[role=status]")).toBeNull();
    expect(countOf("term_shell_open")).toBe(3);
    await act(async () => { sessions[2].type("ls\r"); });
    expect(calls.filter(c => c.command === "term_write").map(c => c.args)).toEqual([{ sub: 12, data: "ls\r" }]);
  });

  it("says only that the process exited when the pty gave no code", async () => {
    await mount();
    await act(async () => { await emit(SHELL_EXIT_EVENT, { sub: 10, code: null }); });
    await settle();
    expect(host.querySelector("[role=status]")?.textContent).toContain("Process exited");
    expect(host.querySelector("[role=status]")?.textContent).not.toContain("code");
  });

  it("names a shell by its folder or running command and keeps zsh N without a title", async () => {
    await mount();
    await click(button("New terminal"));
    await act(async () => { sessions[0].title("me@mac:~/code/trantor"); sessions[1].title("npm run dev"); });
    expect(rows()).toEqual(["trantor", "npm run dev"]);
    await act(async () => { sessions[0].title("me@mac:~"); });
    expect(rows()[0]).toBe("~");
    await act(async () => { sessions[1].title("  "); });
    expect(rows()[1]).toBe("npm run dev");
  });

  it("focuses the shell when the terminal area is clicked", async () => {
    await mount();
    const before = sessions[0].focused;
    await click(host.querySelector<HTMLElement>("[data-testid=terminal-host]"));
    expect(sessions[0].focused).toBe(before + 1);
  });

  it("opens a Copy, Paste, Clear menu on right click and runs each", async () => {
    await mount();
    const writes: string[] = [];
    const clipboard = { writeText: async (text: string) => { writes.push(text); }, readText: async () => "pasted text" };
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    sessions[0].selected = "selected text";
    const area = host.querySelector<HTMLElement>("[data-testid=terminal-host]");
    const menu = () => host.querySelector("[role=menu]");
    const item = (label: string) => [...host.querySelectorAll<HTMLElement>("[role=menuitem]")].find(b => b.textContent === label) ?? null;
    const prevented = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => { area?.dispatchEvent(prevented); });
    expect(prevented.defaultPrevented).toBe(true);
    expect([...host.querySelectorAll("[role=menuitem]")].map(b => b.textContent)).toEqual(["Copy", "Paste", "Clear"]);
    await click(item("Copy"));
    expect(writes).toEqual(["selected text"]);
    expect(menu()).toBeNull();
    await act(async () => { area?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    await click(item("Paste"));
    expect(sessions[0].pasted).toEqual(["pasted text"]);
    await act(async () => { area?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    await click(item("Clear"));
    expect(sessions[0].cleared).toBe(1);
    vi.unstubAllGlobals();
  });

  it("keeps shells alive across unmount and shows them per project", async () => {
    await mount("alpha");
    await act(async () => { root.render(<div />); });
    expect(sessions[0].disposed).toBe(false);
    await mount("alpha");
    expect(countOf("term_shell_open")).toBe(1);
    expect(rows()).toEqual(["zsh 1"]);
    await mount("beta");
    expect(projectsOpened()).toEqual(["alpha", "beta"]);
    expect(rows()).toEqual(["zsh 1"]);
  });
});
