// @vitest-environment happy-dom
// #14075: one tick per operator message, hover card, jump, active tick, arrow keys, hidden under two prompts.
// #14084: the card also shows the send time and the files the prompt changed, clickable into Code.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptTimeline } from "./PromptTimeline";
import { activeIndex, readPrompts, samePrompts, showsTimeline, tickLabel } from "./promptTicks";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mk = (id: string, text: string, ts?: number, files?: string[]) => {
  const el = document.createElement("div");
  el.setAttribute("data-prompt-id", id);
  if (ts) el.setAttribute("data-prompt-ts", String(ts));
  if (files) el.setAttribute("data-prompt-files", JSON.stringify(files));
  el.textContent = text;
  return el;
};

describe("promptTicks model", () => {
  it("reads operator prompts in order and skips empty ones", () => {
    const got = readPrompts([mk("0.0", " first "), mk("1.0", "   "), mk("2.0", "third", 1000)]);
    expect(got).toEqual([{ id: "0.0", text: "first" }, { id: "2.0", text: "third", ts: 1000 }]);
  });
  it("reads the changed files a prompt's reply edited, and drops malformed or empty lists", () => {
    const got = readPrompts([mk("0.0", "a", undefined, ["src/a.ts", "src/b.ts"]), mk("1.0", "b", undefined, [])]);
    expect(got).toEqual([{ id: "0.0", text: "a", files: ["src/a.ts", "src/b.ts"] }, { id: "1.0", text: "b" }]);
    const bad = document.createElement("div");
    bad.setAttribute("data-prompt-id", "2.0");
    bad.setAttribute("data-prompt-files", "not json");
    bad.textContent = "c";
    expect(readPrompts([bad])).toEqual([{ id: "2.0", text: "c" }]);
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
  it("a grown file list redraws the card, so it counts as a different prompt list", () => {
    expect(samePrompts([{ id: "a", text: "x", files: ["a.ts"] }], [{ id: "a", text: "x", files: ["a.ts"] }])).toBe(true);
    expect(samePrompts([{ id: "a", text: "x", files: ["a.ts"] }], [{ id: "a", text: "x", files: ["a.ts", "b.ts"] }])).toBe(false);
    expect(samePrompts([{ id: "a", text: "x", files: ["a.ts"] }], [{ id: "a", text: "x" }])).toBe(false);
  });
});

let host: HTMLDivElement;
let root: Root;
let scroller: HTMLDivElement;
let opened: string[];
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); opened = []; });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

function Harness() {
  const ref = useRef<HTMLDivElement | null>(null);
  return (<div ref={ref}><div data-testid="sc" style={{ overflowY: "auto" }} /><PromptTimeline root={ref} onOpenChange={p => opened.push(p)} /></div>);
}
const mount = async (prompts: Array<[string, string, number?, string[]?]>) => {
  await act(async () => { root.render(<Harness />); });
  // SAFETY: the Harness above always renders this element.
  scroller = host.querySelector<HTMLDivElement>('[data-testid="sc"]')!;
  await act(async () => { for (const [id, t, ts, files] of prompts) scroller.append(mk(id, t, ts, files)); await Promise.resolve(); });
  await act(async () => { await new Promise(r => setTimeout(r, 5)); });
};
// Ticks only: the hover card's file-name buttons also live in the nav, so the selector stops at
// the tick row's direct button.
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Prompt timeline"] > div > button'));

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
  it("shows the changed files with names and a count, and no line without files", async () => {
    await mount([["0.0", "alpha", undefined, ["desktop/src/a.ts", "desktop/src-tauri/b.rs"]], ["2.0", "beta"]]);
    await act(async () => { buttons()[0].focus(); });
    const card = host.querySelector('[role="tooltip"]')!;
    expect(card.textContent).toContain("Changed 2 files");
    const names = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).map(b => b.textContent);
    expect(names).toEqual(["a.ts", "b.rs"]);
    await act(async () => { buttons()[1].focus(); });
    expect(host.querySelector('[role="tooltip"]')?.textContent).toBe("beta");
  });
  it("caps the names at five and counts the rest", async () => {
    const files = ["1.ts", "2.ts", "3.ts", "4.ts", "5.ts", "6.ts", "7.ts"];
    await mount([["0.0", "alpha", undefined, files], ["2.0", "beta"]]);
    await act(async () => { buttons()[0].focus(); });
    const card = host.querySelector('[role="tooltip"]')!;
    expect(card.textContent).toContain("Changed 7 files");
    expect(card.textContent).toContain("and 2 more");
    expect(card.querySelectorAll("button")).toHaveLength(5);
  });
  it("a file name opens that file's change", async () => {
    await mount([["0.0", "alpha", undefined, ["desktop/src/a.ts"]], ["2.0", "beta"]]);
    await act(async () => { buttons()[0].focus(); });
    const name = host.querySelector<HTMLButtonElement>('[role="tooltip"] button')!;
    await act(async () => { name.click(); });
    expect(opened).toEqual(["desktop/src/a.ts"]);
  });
  it("the card stays open while the pointer is over it and closes when it leaves", async () => {
    await mount([["0.0", "alpha", undefined, ["a.ts"]], ["2.0", "beta"]]);
    await act(async () => { buttons()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    const card = host.querySelector('[role="tooltip"]');
    // SAFETY: the card rendered for the hovered tick above.
    const shown = card as HTMLElement;
    await act(async () => {
      buttons()[0].dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: shown }));
      shown.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(host.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => {
      shown.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
    });
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
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
