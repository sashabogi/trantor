// @vitest-environment happy-dom
// #14241: one tab bar joined to its pane — active state, arrow keys, close buttons, and the
// lead/actions/end slots around the tablist.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tabs, type TabSpec } from "./Tabs";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TABS: TabSpec[] = [
  { id: "a", label: "Alpha", title: "Alpha tab" },
  { id: "b", label: "Beta", close: true },
  { id: "c", label: "Gamma", close: true, dirty: true },
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function Harness() {
  const [active, setActive] = useState("a");
  const [closed, setClosed] = useState<string[]>([]);
  const live = TABS.filter(t => !closed.includes(t.id));
  return <Tabs label="Test tabs" pane="var(--v2-bg)" tabs={live} activeId={active} onSelect={setActive}
    onClose={id => setClosed(c => [...c, id])}
    lead={<button type="button" aria-label="Lead" />}
    actions={<button type="button" aria-label="Action" />}
    end={<button type="button" aria-label="End" />} />;
}

const mount = async () => { await act(async () => { root.render(<Harness />); }); };
const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const tab = (label: string) => tabs().find(t => t.textContent === label);
const click = (el: Element | null | undefined) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const key = (label: string, k: string) => act(async () => { tab(label)?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });

describe("Tabs", () => {
  it("marks one tab selected and joins it to the pane below", async () => {
    await mount();
    expect(host.querySelector('[role="tablist"][aria-label="Test tabs"]')).not.toBeNull();
    expect(tab("Alpha")?.getAttribute("aria-selected")).toBe("true");
    expect(tab("Beta")?.getAttribute("aria-selected")).toBe("false");
    const rect = tab("Alpha")?.parentElement;
    expect(rect?.style.background).toBe("var(--v2-bg)");
    expect(rect?.style.borderBottom).toContain("var(--v2-bg)");
    expect(rect?.style.marginBottom).toBe("-1px");
    expect(rect?.classList.contains("border-t-[var(--v2-accent)]")).toBe(true);
    const flat = tab("Beta")?.parentElement;
    expect(flat?.style.background).toBe("");
    expect(flat?.classList.contains("border-t-transparent")).toBe(true);
  });

  it("clicking a tab selects it and only it", async () => {
    await mount();
    await click(tab("Beta"));
    expect(tab("Beta")?.getAttribute("aria-selected")).toBe("true");
    expect(tab("Alpha")?.getAttribute("aria-selected")).toBe("false");
  });

  it("arrow keys move focus and selection, wrapping at both ends", async () => {
    await mount();
    await act(async () => { tab("Alpha")?.focus(); });
    await key("Alpha", "ArrowRight");
    expect(document.activeElement).toBe(tab("Beta"));
    expect(tab("Beta")?.getAttribute("aria-selected")).toBe("true");
    await act(async () => { tab("Gamma")?.focus(); });
    await key("Gamma", "ArrowRight");
    expect(document.activeElement).toBe(tab("Alpha"));
    expect(tab("Alpha")?.getAttribute("aria-selected")).toBe("true");
    await key("Alpha", "ArrowLeft");
    expect(document.activeElement).toBe(tab("Gamma"));
    expect(tab("Gamma")?.getAttribute("aria-selected")).toBe("true");
  });

  it("closes only tabs marked close, and the dirty dot stays titled", async () => {
    await mount();
    expect(host.querySelector('button[aria-label="Close Alpha"]')).toBeNull();
    const dot = tab("Gamma")?.querySelector('[title="Unsaved changes"]');
    expect(dot?.getAttribute("aria-label")).toBe("Unsaved changes");
    await click(host.querySelector('button[aria-label="Close Beta"]'));
    expect(tab("Beta")).toBeUndefined();
    expect(tabs()).toHaveLength(2);
  });

  it("lays out lead, tablist, actions, spacer and end in that order", async () => {
    await mount();
    const bar = host.firstElementChild;
    const kinds = Array.from(bar?.children ?? []).map(child => {
      if (child.getAttribute("role") === "tablist") return "tablist";
      if (child.querySelector('button[aria-label="Lead"]')) return "lead";
      if (child.querySelector('button[aria-label="Action"]')) return "actions";
      if (child.querySelector('button[aria-label="End"]')) return "end";
      return "spacer";
    });
    expect(kinds).toEqual(["lead", "tablist", "actions", "spacer", "end"]);
  });
});
