// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { registerCommands } from "../../shell/commands";
import { KeyboardPage } from "./KeyboardPage";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

describe("Keyboard page", () => {
  it("lists only commands that have a shortcut, grouped, from the registry", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const off = registerCommands([
      { id: "k.a", title: "Alpha action", group: "Go to", shortcut: "Mod+P", run: () => undefined },
      { id: "k.b", title: "Beta action", group: "View", shortcut: "Ctrl+`", listOnly: true, run: () => undefined },
      { id: "k.c", title: "No key action", group: "View", run: () => undefined },
    ]);
    act(() => root.render(<KeyboardPage />));
    expect(host.querySelector('section[aria-label="Go to"]')?.textContent).toContain("Alpha action");
    expect(host.querySelector('section[aria-label="View"]')?.textContent).toContain("Beta action");
    expect(host.textContent).not.toContain("No key action");
    expect(host.querySelectorAll("kbd")).toHaveLength(2);
    act(() => off());
    expect(host.textContent).toContain("No shortcuts are registered.");
    act(() => root.unmount());
  });
});
