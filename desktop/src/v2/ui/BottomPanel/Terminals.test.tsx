// @vitest-environment happy-dom
// Project terminals: the real store and component over mocked Tauri IPC; only xterm is a stand-in (#14080).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  focus() { /* no focus under happy-dom */ }
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

  it("removes a shell that exits on its own", async () => {
    await mount();
    await click(button("New terminal"));
    await act(async () => { await emit(SHELL_EXIT_EVENT, 10); });
    await settle();
    expect(rows()).toEqual(["zsh 2"]);
    expect(sessions[0].disposed).toBe(true);
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
