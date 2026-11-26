// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useActivePane } from "./useActivePane";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function Pane({ name, working, children }: { name: string; working?: boolean; children?: ReactNode }) {
  const pane = useActivePane(working);
  return <section {...pane} aria-label={name}><input aria-label={`${name} input`} />{children}</section>;
}
const pane = (name: string) => {
  const el = host.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
  if (!el) throw new Error(`Missing ${name}`);
  return el;
};
const pointer = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });

describe("useActivePane", () => {
  it("activates on pointerdown and focusin, retaining only the last pane after blur", () => {
    act(() => root.render(<><Pane name="chat" /><Pane name="editor" /></>));
    pointer(pane("chat"));
    expect(pane("chat").dataset.active).toBe("true");
    act(() => pane("editor").querySelector("input")?.focus());
    expect(pane("chat").hasAttribute("data-active")).toBe(false);
    expect(pane("editor").dataset.active).toBe("true");
    act(() => pane("editor").querySelector("input")?.blur());
    expect(host.querySelectorAll("[data-active]")).toHaveLength(1);
    expect(pane("editor").dataset.active).toBe("true");
  });

  it("lets nested seat panes own their events", () => {
    act(() => root.render(<Pane name="workspace"><Pane name="seat" /></Pane>));
    const input = pane("seat").querySelector("input");
    if (!input) throw new Error("Missing seat input");
    pointer(input);
    expect(pane("seat").dataset.active).toBe("true");
    expect(pane("workspace").hasAttribute("data-active")).toBe(false);
    act(() => pane("seat").querySelector("input")?.focus());
    expect(pane("workspace").hasAttribute("data-active")).toBe(false);
    pointer(pane("workspace"));
    expect(pane("seat").hasAttribute("data-active")).toBe(false);
  });

  it("keeps one active pane across React roots in the window", () => {
    const other = document.createElement("div");
    document.body.append(other);
    const otherRoot = createRoot(other);
    try {
      act(() => { root.render(<Pane name="chat" />); otherRoot.render(<Pane name="other" />); });
      pointer(pane("chat"));
      const otherPane = other.querySelector("section");
      if (!otherPane) throw new Error("Missing other root's pane");
      pointer(otherPane);
      expect(pane("chat").hasAttribute("data-active")).toBe(false);
      expect(document.querySelectorAll("[data-v2-pane][data-active]")).toHaveLength(1);
    } finally { act(() => otherRoot.unmount()); other.remove(); }
    pointer(pane("chat"));
    expect(pane("chat").dataset.active).toBe("true");
  });

  it("updates working independently of activation and keeps active through rerenders", () => {
    act(() => root.render(<Pane name="seat" working />));
    expect(pane("seat").dataset.working).toBe("true");
    expect(pane("seat").hasAttribute("data-active")).toBe(false);
    pointer(pane("seat"));
    act(() => root.render(<Pane name="seat" working={false} />));
    expect(pane("seat").hasAttribute("data-working")).toBe(false);
    expect(pane("seat").dataset.active).toBe("true");
  });
});
