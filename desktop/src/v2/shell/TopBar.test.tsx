// @vitest-environment happy-dom
// The project switcher filters by name, walks the filtered list with the arrows and opens on Enter (#14268).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar, filterProjects } from "./TopBar";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
const onProject = vi.fn();
const PROJECTS = ["alpha", "Beta-Store", "gamma", "betamax"];

function mount() {
  act(() => root.render(<TopBar projects={PROJECTS} project="alpha" onProject={onProject} mode="orchestrator" onMode={vi.fn()}
    onSearch={vi.fn()} needsYou={0} me="me" onNavigate={vi.fn()} onStartProject={vi.fn()} onBackToClassic={vi.fn()} />));
  act(() => { host.querySelector<HTMLButtonElement>('button[title="Switch project"]')!.click(); });
}
const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Find a project"]')!;
const type = (value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field(), value);
  field().dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (k: string) => act(() => { field().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const items = () => [...document.querySelectorAll('[role="menuitem"]')].map(o => o.textContent ?? "");

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); onProject.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("project switcher search", () => {
  it("filters case-insensitively by substring", () => {
    expect(filterProjects(PROJECTS, "BETA")).toEqual(["Beta-Store", "betamax"]);
    mount();
    expect(document.activeElement).toBe(field());
    type("ETA");
    expect(items()).toEqual(["Start a project⌘N", "BSBeta-Store", "BEbetamax"]);
  });

  it("says so when nothing matches", () => {
    mount();
    type("zzz");
    expect(document.body.textContent).toContain("No project matches");
    key("Enter");
    expect(onProject).not.toHaveBeenCalled();
  });

  it("moves with the arrow keys and opens the highlighted project on Enter", () => {
    mount();
    type("beta");
    key("ArrowDown");
    key("Enter");
    expect(onProject).toHaveBeenCalledWith("betamax");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("wraps upward from the first match", () => {
    mount();
    type("beta");
    key("ArrowUp");
    key("Enter");
    expect(onProject).toHaveBeenCalledWith("betamax");
  });

  it("closes on Escape", () => {
    mount();
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
