// @vitest-environment happy-dom
// #14512: the top-bar cluster and the panel chords drive the slots the current screen registered:
// one left/bottom/right language everywhere, disabled with a tooltip where the screen has no panel.
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelToggles } from "./PanelToggles";
import { ShortcutLayer } from "./ShortcutLayer";
import { getPanelSlot, panelAvailable, setPanelSlot, togglePanel, usePanelSlot, usePanelSlots } from "./panelSlots";
import type { Screen } from "../routes";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Stands in for a screen: holds the panel state a real screen holds, registers it as slots. */
function Probe({ withLeft = true, withBottom = true, withRight = true }: { withLeft?: boolean; withBottom?: boolean; withRight?: boolean }) {
  const [left, setLeft] = useState(false);
  const [bottom, setBottom] = useState(false);
  const [right, setRight] = useState(false);
  usePanelSlot("left", withLeft ? { open: left, toggle: () => setLeft(v => !v) } : null);
  usePanelSlot("bottom", withBottom ? { open: bottom, toggle: () => setBottom(v => !v) } : null);
  usePanelSlot("right", withRight ? { open: right, toggle: () => setRight(v => !v) } : null);
  return null;
}

/** Reads the store like a consumer outside React, to prove the subscription publishes. */
function Reader({ seen }: { seen: { sides: string } }) {
  const slots = usePanelSlots();
  seen.sides = (["left", "bottom", "right"] as const).filter(s => slots[s] !== null).join(",");
  return null;
}

let host: HTMLDivElement;
let root: Root;
let readerHost: HTMLDivElement;
let readerRoot: Root;
let seen = { sides: "" };
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  readerHost = document.createElement("div");
  readerRoot = createRoot(readerHost);
  seen = { sides: "" };});
afterEach(() => { act(() => root.unmount()); act(() => readerRoot.unmount()); host.remove(); readerHost.remove(); });

const mount = async (children: ReactNode, screen: Screen = "workspace") => {
  await act(async () => {
    root.render(<>
      <PanelToggles />
      <ShortcutLayer project="demo" screen={screen} mode="orchestrator" onMode={vi.fn()} onNavigate={vi.fn()} onSearch={vi.fn()} />
      {children}
    </>);
  });
};
const toggles = () => [...host.querySelectorAll<HTMLButtonElement>("div[aria-label='Panel toggles'] button")];
const left = () => host.querySelector<HTMLButtonElement>("button[data-side='left']")!;
const bottom = () => host.querySelector<HTMLButtonElement>("button[data-side='bottom']")!;
const right = () => host.querySelector<HTMLButtonElement>("button[data-side='right']")!;
const press = (init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

describe("the slot store", () => {
  it("registers, publishes, runs the toggle and unregisters", async () => {
    await act(async () => { readerRoot.render(<Reader seen={seen} />); });
    expect(seen.sides).toBe("");
    expect(panelAvailable("left")).toBe(false);
    expect(togglePanel("left")).toBe(false);
    const calls: number[] = [];
    let off: (() => void) | undefined;
    try {
      await act(async () => { off = setPanelSlot("left", { open: true, toggle: () => { calls.push(1); } }); });
      expect(getPanelSlot("left")?.open).toBe(true);
      expect(seen.sides).toBe("left");
      expect(togglePanel("left")).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      await act(async () => { off?.(); });
    }
    expect(panelAvailable("left")).toBe(false);
    expect(seen.sides).toBe("");
  });

  it("a null slot stays unregistered: no panel on this screen", async () => {
    await act(async () => { root.render(<Probe withLeft={false} withBottom={false} withRight={false} />); });
    expect(panelAvailable("left")).toBe(false);
    expect(panelAvailable("bottom")).toBe(false);
    expect(panelAvailable("right")).toBe(false);
  });
});

describe("the cluster", () => {
  it("with no slots: three disabled toggles whose tooltips say the screen has no panel", async () => {
    await mount(null, "dashboard");
    expect(toggles()).toHaveLength(3);
    for (const t of toggles()) expect(t.disabled).toBe(true);
    expect(left().title).toBe("No source control column on this screen");
    expect(bottom().title).toBe("No bottom panel on this screen");
    expect(right().title).toBe("No chat column on this screen");
    expect(left().getAttribute("aria-pressed")).toBe("false");
  });

  it("reflects each registered panel, the tooltip previews the click, and the buttons drive the panels", async () => {
    await mount(<Probe />);
    for (const t of toggles()) expect(t.disabled).toBe(false);
    expect(left().getAttribute("aria-pressed")).toBe("false");
    expect(left().title).toBe("Show source control ⌘B");
    expect(right().title).toBe("Show chat ⌥⌘B");
    expect(bottom().title).toBe("Show the bottom panel ⌘J");
    await act(async () => { left().click(); });
    expect(left().getAttribute("aria-pressed")).toBe("true");
    expect(left().title).toBe("Hide source control ⌘B");
    await act(async () => { right().click(); });
    expect(right().getAttribute("aria-pressed")).toBe("true");
    expect(right().title).toBe("Hide chat ⌥⌘B");
  });

  it("a screen without one panel disables exactly that toggle", async () => {
    await mount(<Probe withBottom={false} />, "workspace");
    expect(left().disabled).toBe(false);
    expect(bottom().disabled).toBe(true);
    expect(bottom().title).toBe("No bottom panel on this screen");
    expect(right().disabled).toBe(false);
  });
});

describe("the chords", () => {
  it("⌘B, ⌥⌘B and ⌘J toggle the registered panels on the project screens", async () => {
    await mount(<Probe />, "code");
    await press({ key: "b", metaKey: true });
    expect(left().getAttribute("aria-pressed")).toBe("true");
    await press({ key: "b", metaKey: true, altKey: true });
    expect(right().getAttribute("aria-pressed")).toBe("true");
    expect(left().getAttribute("aria-pressed")).toBe("true");
    await press({ key: "j", metaKey: true });
    expect(bottom().getAttribute("aria-pressed")).toBe("true");
  });

  it("away from the project screens the chords do nothing", async () => {
    await mount(<Probe />, "dashboard");
    await press({ key: "b", metaKey: true });
    expect(left().getAttribute("aria-pressed")).toBe("false");
    await press({ key: "b", metaKey: true, altKey: true });
    expect(right().getAttribute("aria-pressed")).toBe("false");
    await press({ key: "j", metaKey: true });
    expect(bottom().getAttribute("aria-pressed")).toBe("false");
  });

  it("alt separates ⌥⌘B from ⌘B, and ⌘J is the bottom panel's alone", async () => {
    await mount(<Probe />, "code");
    await press({ key: "j", metaKey: true, altKey: true });
    expect(bottom().getAttribute("aria-pressed")).toBe("false");
    expect(left().getAttribute("aria-pressed")).toBe("false");
    expect(right().getAttribute("aria-pressed")).toBe("false");
  });
});
