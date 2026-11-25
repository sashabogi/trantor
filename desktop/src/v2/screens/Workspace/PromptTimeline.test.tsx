// @vitest-environment happy-dom
// #14075: one tick per operator message, hover card, jump, active tick, arrow keys, hidden under two prompts.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptTimeline } from "./PromptTimeline";
import { activeIndex, readPrompts, samePrompts, showsTimeline, tickLabel } from "./promptTicks";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mk = (id: string, text: string, ts?: number) => {
  const el = document.createElement("div");
  el.setAttribute("data-prompt-id", id);
  if (ts) el.setAttribute("data-prompt-ts", String(ts));
  el.textContent = text;
  return el;
};

describe("promptTicks model", () => {
  it("reads operator prompts in order and skips empty ones", () => {
    const got = readPrompts([mk("0.0", " first "), mk("1.0", "   "), mk("2.0", "third", 1000)]);
    expect(got).toEqual([{ id: "0.0", text: "first" }, { id: "2.0", text: "third", ts: 1000 }]);
  });
  it("labels a tick with its place and the first words", () => {
    expect(tickLabel(2, 12, "fix the bug")).toBe("Prompt 3 of 12: fix the bug");
    expect(tickLabel(0, 2, "one two three four five six seven eight nine")).toBe("Prompt 1 of 2: one two three four five six seven eight...");
  });
  it("picks the last prompt at or above the viewport top, else the first", () => {
    expect(activeIndex([-300, -20, 120, 400])).toBe(1);
    expect(activeIndex([50, 200])).toBe(0);
    expect(activeIndex([-10, 4, 300])).toBe(1);
  });
  it("hides below two prompts and compares lists", () => {
    expect([0, 1, 2].map(showsTimeline)).toEqual([false, false, true]);
    expect(samePrompts([{ id: "a", text: "x" }], [{ id: "a", text: "x" }])).toBe(true);
    expect(samePrompts([{ id: "a", text: "x" }], [{ id: "a", text: "y" }])).toBe(false);
  });
});

let host: HTMLDivElement;
let root: Root;
let scroller: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

function Harness() {
  const ref = useRef<HTMLDivElement | null>(null);
  return (<div ref={ref}><div data-testid="sc" style={{ overflowY: "auto" }} /><PromptTimeline root={ref} /></div>);
}
const mount = async (prompts: Array<[string, string, number?]>) => {
  await act(async () => { root.render(<Harness />); });
  // SAFETY: the Harness above always renders this element.
  scroller = host.querySelector<HTMLDivElement>('[data-testid="sc"]')!;
  await act(async () => { for (const [id, t, ts] of prompts) scroller.append(mk(id, t, ts)); await Promise.resolve(); });
  await act(async () => { await new Promise(r => setTimeout(r, 5)); });
};
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Prompt timeline"] button'));

describe("PromptTimeline", () => {
  it("renders one button per operator message", async () => {
    await mount([["0.0", "alpha one"], ["2.0", "beta two"], ["4.0", "gamma three"]]);
    expect(buttons().map(b => b.getAttribute("aria-label"))).toEqual(["Prompt 1 of 3: alpha one", "Prompt 2 of 3: beta two", "Prompt 3 of 3: gamma three"]);
  });
  it("is not rendered for fewer than two prompts", async () => {
    await mount([["0.0", "only one"]]);
    expect(host.querySelector("nav")).toBeNull();
  });
  it("jumps to the clicked message", async () => {
    await mount([["0.0", "alpha"], ["2.0", "beta"]]);
    // SAFETY: the harness appended two div children just above.
    const target = scroller.children[1] as HTMLElement;
    const spy = vi.fn();
    target.scrollIntoView = spy;
    await act(async () => { buttons()[1].click(); });
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("shows the prompt and its time on hover and focus, and only the prompt without a time", async () => {
    await mount([["0.0", "alpha prompt", Date.now()], ["2.0", "beta prompt"]]);
    await act(async () => { buttons()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); buttons()[0].focus(); });
    const card = host.querySelector('[role="tooltip"]');
    expect(card?.textContent).toContain("alpha prompt");
    expect(card?.children.length).toBe(2);
    await act(async () => { buttons()[1].focus(); });
    const second = host.querySelector('[role="tooltip"]');
    expect(second?.textContent).toBe("beta prompt");
    expect(second?.children.length).toBe(1);
  });
  it("moves focus with the arrow keys", async () => {
    await mount([["0.0", "a"], ["2.0", "b"], ["4.0", "c"]]);
    await act(async () => { buttons()[0].focus(); });
    await act(async () => { buttons()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(document.activeElement).toBe(buttons()[1]);
    await act(async () => { buttons()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(document.activeElement).toBe(buttons()[0]);
  });
  it("highlights the prompt on screen and follows the scroll", async () => {
    await mount([["0.0", "a"], ["2.0", "b"], ["4.0", "c"]]);
    const tops = { v: [0, 300, 600] };
    const rectAt = (i: number): DOMRect => {
      // SAFETY: the timeline reads only `top` from a rect.
      return { top: tops.v[i] } as DOMRect;
    };
    Array.from(scroller.children).forEach((c, i) => { c.getBoundingClientRect = () => rectAt(i); });
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    expect(buttons().map(b => b.getAttribute("aria-current"))).toEqual(["true", null, null]);
    tops.v = [-700, -400, -10];
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    expect(buttons().map(b => b.getAttribute("aria-current"))).toEqual([null, null, "true"]);
  });
});
