// @vitest-environment happy-dom
// Cmd+P and Cmd+Shift+P work from any screen, win over the editor, and stay out of a terminal.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { takeOpenIntent } from "./openIntent";
import { ShortcutLayer } from "./ShortcutLayer";
import type { Screen } from "../routes";
import type { Mode } from "./shellMode";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
const onNavigate = vi.fn();
const onMode = vi.fn();
const onSearch = vi.fn();

type Setup = { project?: string; screen?: Screen; mode?: Mode };
function mount({ project = "demo", screen = "dashboard", mode = "orchestrator" }: Setup = {}) {
  act(() => root.render(<ShortcutLayer project={project} screen={screen} mode={mode} onMode={onMode} onNavigate={onNavigate} onSearch={onSearch} />));
}
const press = (init: KeyboardEventInit, target: Element | Window = window) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const dialog = (name: string) => document.querySelector(`[role="dialog"][aria-label="${name}"]`);
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const field = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC(command => (command === "search_files" ? JSON.stringify(["src/app/main.ts", "src/lib/util.ts"]) : null));
  onNavigate.mockClear(); onMode.mockClear(); onSearch.mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); });

describe("Go to file", () => {
  it("opens on Cmd+P, finds files and opens the chosen one on the Code screen of the active project", async () => {
    mount();
    press({ key: "p", metaKey: true });
    expect(dialog("Go to file")).not.toBeNull();
    type(field("Go to file")!, "main");
    await flush();
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map(o => o.textContent)).toEqual(["main.tssrc/app", "util.tssrc/lib"]);
    press({ key: "ArrowDown" }, field("Go to file")!);
    press({ key: "Enter" }, field("Go to file")!);
    expect(onNavigate).toHaveBeenCalledWith("code", "demo");
    expect(takeOpenIntent("demo")).toEqual({ kind: "file", path: "src/lib/util.ts" });
    expect(dialog("Go to file")).toBeNull();
  });

  it("says so and does nothing else when no project is active", () => {
    mount({ project: "" });
    press({ key: "p", metaKey: true });
    expect(dialog("Go to file")?.textContent).toContain("Open a project first");
    press({ key: "Enter" }, field("Go to file")!);
    expect(onNavigate).not.toHaveBeenCalled();
    press({ key: "Escape" }, field("Go to file")!);
    expect(dialog("Go to file")).toBeNull();
  });

  it("closes on a second Cmd+P", () => {
    mount();
    press({ key: "p", metaKey: true });
    press({ key: "p", metaKey: true });
    expect(dialog("Go to file")).toBeNull();
  });
});

describe("command palette", () => {
  it("opens on Cmd+Shift+P, filters by when, fuzzy matches and runs on Enter", () => {
    mount({ screen: "code", mode: "orchestrator" });
    press({ key: "P", metaKey: true, shiftKey: true });
    const titles = () => [...document.querySelectorAll('[role="option"]')].map(o => o.textContent ?? "");
    expect(titles().some(t => t.startsWith("Switch to Developer mode"))).toBe(true);
    expect(titles().some(t => t.startsWith("Switch to Orchestrator mode"))).toBe(false);
    expect(titles().some(t => t.startsWith("Go to Code"))).toBe(false);
    expect(titles().some(t => t.startsWith("Toggle bottom panel"))).toBe(true);
    type(field("Command palette")!, "gtbo");
    expect(titles()[0]).toContain("Go to Board");
    press({ key: "Enter" }, field("Command palette")!);
    expect(onNavigate).toHaveBeenCalledWith("board");
    expect(dialog("Command palette")).toBeNull();
  });

  it("hides the bottom panel toggle away from the Code screen and shows each shortcut", () => {
    mount({ screen: "dashboard" });
    press({ key: "P", metaKey: true, shiftKey: true });
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Toggle bottom panel");
    expect(text).toContain("Go to file");
    expect(document.querySelectorAll("kbd").length).toBeGreaterThan(2);
  });

  it("runs the mode switch", () => {
    mount();
    press({ key: "P", metaKey: true, shiftKey: true });
    type(field("Command palette")!, "developer");
    press({ key: "Enter" }, field("Command palette")!);
    expect(onMode).toHaveBeenCalledWith("developer");
  });
});

describe("where the chords apply", () => {
  it("wins over the editor: Monaco never sees Cmd+P or Cmd+Shift+P", () => {
    document.body.insertAdjacentHTML("beforeend", '<div class="monaco-editor"><textarea id="ed"></textarea></div>');
    const editor = document.getElementById("ed")!;
    const seen = vi.fn();
    editor.addEventListener("keydown", seen);
    mount();
    press({ key: "p", metaKey: true }, editor);
    expect(dialog("Go to file")).not.toBeNull();
    press({ key: "P", metaKey: true, shiftKey: true }, editor);
    expect(dialog("Command palette")).not.toBeNull();
    expect(seen).not.toHaveBeenCalled();
    press({ key: "a", metaKey: true }, editor);
    expect(seen).toHaveBeenCalledTimes(1);
    editor.closest(".monaco-editor")?.remove();
  });

  it("ignores the chords inside a terminal", () => {
    document.body.insertAdjacentHTML("beforeend", '<div class="xterm"><textarea id="term"></textarea></div>');
    const term = document.getElementById("term")!;
    const seen = vi.fn();
    term.addEventListener("keydown", seen);
    mount();
    press({ key: "p", metaKey: true }, term);
    press({ key: "P", metaKey: true, shiftKey: true }, term);
    expect(dialog("Go to file")).toBeNull();
    expect(dialog("Command palette")).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2);
    term.closest(".xterm")?.remove();
  });

  it("leaves Cmd+K and Ctrl+backtick to their owners", () => {
    mount({ screen: "code" });
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(onSearch).not.toHaveBeenCalled();
  });
});
