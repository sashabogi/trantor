// @vitest-environment happy-dom
// #14241: one handle for columns and rows — the grip is always visible, the accent line lights
// during a drag, arrows commit 16px steps, drags clamp, and double-click resets.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Splitter, type SplitterProps } from "./Splitter";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const handle = () => host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize chat"]');
const line = () => host.querySelector<HTMLElement>("[data-line]");
const widthNow = () => Number(handle()?.getAttribute("aria-valuenow"));

function Harness(over: Partial<SplitterProps> = {}) {
  const [value, setValue] = useState(400);
  return <Splitter orientation="columns" edge="left" label="Resize chat" title="Drag to resize, double-click to reset"
    value={value} min={320} max={700} onChange={setValue} onCommit={setValue} onReset={() => setValue(400)} {...over} />;
}

const render = async (over: Partial<SplitterProps> = {}) => {
  await act(async () => { root.render(<Harness {...over} />); });
};
const key = (k: string) => act(async () => { handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
const pointer = (type: string, at: number, target: EventTarget, axis: "x" | "y" = "x") => act(async () => {
  const init = axis === "y" ? { bubbles: true, clientY: at } : { bubbles: true, clientX: at };
  target.dispatchEvent(new MouseEvent(type, init));
});

describe("Splitter", () => {
  it("is a focusable separator with its range, a visible 3-dot grip and a resting line", async () => {
    await render();
    const h = handle();
    expect(h?.getAttribute("aria-orientation")).toBe("vertical");
    expect(h?.tabIndex).toBe(0);
    expect(widthNow()).toBe(400);
    expect(h?.getAttribute("aria-valuemin")).toBe("320");
    expect(h?.getAttribute("aria-valuemax")).toBe("700");
    expect(h?.querySelectorAll("[data-grip] > span")).toHaveLength(3);
    expect(line()?.classList.contains("opacity-0")).toBe(true);
    expect(line()?.classList.contains("opacity-100")).toBe(false);
  });

  it("arrow keys commit 16px steps and double-click resets", async () => {
    await render();
    await key("ArrowLeft");
    expect(widthNow()).toBe(416);
    await key("ArrowLeft");
    expect(widthNow()).toBe(432);
    await act(async () => { handle()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(widthNow()).toBe(400);
  });

  it("dragging against the edge grows the value and lights the accent line", async () => {
    await render();
    const h = handle();
    if (!h) throw new Error("no splitter");
    await pointer("pointerdown", 600, h);
    expect(line()?.classList.contains("opacity-100")).toBe(true);
    await pointer("pointermove", 500, window);
    expect(widthNow()).toBe(500);
    await pointer("pointerup", 500, window);
    expect(widthNow()).toBe(500);
    expect(line()?.classList.contains("opacity-0")).toBe(true);
  });

  it("clamps to the minimum and the maximum across a drag", async () => {
    await render();
    const h = handle();
    if (!h) throw new Error("no splitter");
    await pointer("pointerdown", 100, h);
    await pointer("pointerup", 900, window);
    expect(widthNow()).toBe(320);
    await pointer("pointerdown", 900, h);
    await pointer("pointerup", 0, window);
    expect(widthNow()).toBe(700);
  });

  it("rows: dragging up grows, ArrowUp commits, and it carries a horizontal grip", async () => {
    const spy = vi.fn();
    await render({ orientation: "rows", edge: "top", label: "Resize chat", min: 120, max: 700, value: 240, onCommit: spy, onChange: vi.fn() });
    const h = handle();
    if (!h) throw new Error("no splitter");
    expect(h.getAttribute("aria-orientation")).toBe("horizontal");
    await key("ArrowUp");
    expect(spy).toHaveBeenCalledWith(256);
    await pointer("pointerdown", 500, h, "y");
    await pointer("pointerup", 400, window, "y");
    expect(spy).toHaveBeenCalledWith(340);
  });

  it("without onReset a double-click changes nothing", async () => {
    await render({ onReset: undefined });
    await key("ArrowLeft");
    await act(async () => { handle()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(widthNow()).toBe(416);
  });
});
