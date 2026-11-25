// @vitest-environment happy-dom
// The panel answers the actions the command palette sends it: toggle, and show the terminal.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomPanel } from "./index";
import { ACTIVE_TAB_KEY, OPEN_KEY, sendBottomPanel } from "./state";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

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
  localStorage.setItem(OPEN_KEY, "false");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<BottomPanel terminal={<div>Terminal body</div>} output={<div>Output body</div>} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const open = () => host.querySelector('section[aria-label="Bottom panel"]') !== null;

describe("bottom panel actions", () => {
  it("toggle opens a closed panel and closes an open one", () => {
    expect(open()).toBe(false);
    act(() => sendBottomPanel("toggle"));
    expect(open()).toBe(true);
    act(() => sendBottomPanel("toggle"));
    expect(open()).toBe(false);
  });

  it("show terminal opens the panel on the Terminal tab", () => {
    localStorage.setItem(ACTIVE_TAB_KEY, "output");
    act(() => root.render(<BottomPanel key="again" terminal={<div>Terminal body</div>} output={<div>Output body</div>} />));
    act(() => sendBottomPanel("show-terminal"));
    expect(open()).toBe(true);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Terminal");
  });
});
