// @vitest-environment happy-dom
// #14075: one tick per operator message, hover card, jump, active tick, arrow keys, hidden under two prompts.
// #14084: the card also shows the send time and the files the prompt changed, clickable into Code.
// #14327: the column sits on the chat's left edge as an overlay with 8px ticks. #14250: the card reads "N / total", the reply's first line and "Worked 4m · 2h ago"; ticks widen with the pointer.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptTimeline } from "./PromptTimeline";
import { activeIndex, readPrompts, samePrompts, showsTimeline, tickLabel, tickWidth, workedText, type PromptItem } from "./promptTicks";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mk = { id: string; text: string; ts?: number; files?: string[]; reply?: string; workedMs?: number };
const mk = (p: Mk) => {
  const el = document.createElement("div");
  el.setAttribute("data-prompt-id", p.id);
  if (p.ts) el.setAttribute("data-prompt-ts", String(p.ts));
  if (p.files) el.setAttribute("data-prompt-files", JSON.stringify(p.files));
  if (p.reply !== undefined) el.setAttribute("data-prompt-reply", p.reply);
  if (p.workedMs !== undefined) el.setAttribute("data-prompt-worked-ms", String(p.workedMs));
  el.textContent = p.text;
  return el;
};

describe("promptTicks model", () => {
  it("reads operator prompts in order and skips empty ones", () => {
    const got = readPrompts([mk({ id: "0.0", text: " first " }), mk({ id: "1.0", text: "   " }), mk({ id: "2.0", text: "third", ts: 1000 })]);
    expect(got).toEqual([{ id: "0.0", text: "first" }, { id: "2.0", text: "third", ts: 1000 }]);
  });
  it("reads the changed files a prompt's reply edited, and drops malformed or empty lists", () => {
    const got = readPrompts([mk({ id: "0.0", text: "a", files: ["src/a.ts", "src/b.ts"] }), mk({ id: "1.0", text: "b", files: [] })]);
    expect(got).toEqual([{ id: "0.0", text: "a", files: ["src/a.ts", "src/b.ts"] }, { id: "1.0", text: "b" }]);
    const bad = document.createElement("div");
    bad.setAttribute("data-prompt-id", "2.0");
    bad.setAttribute("data-prompt-files", "not json");
    bad.textContent = "c";
    expect(readPrompts([bad])).toEqual([{ id: "2.0", text: "c" }]);
  });
  it("#14250: reads the reply line and worked ms, and drops empty or malformed values", () => {
    const got = readPrompts([mk({ id: "0.0", text: "a", reply: "Done.", workedMs: 240_000 })]);
    expect(got).toEqual([{ id: "0.0", text: "a", reply: "Done.", workedMs: 240_000 }]);
    const bare = document.createElement("div");
    bare.setAttribute("data-prompt-id", "1.0");
    bare.setAttribute("data-prompt-reply", "");
    bare.setAttribute("data-prompt-worked-ms", "nope");
    bare.textContent = "b";
    expect(readPrompts([bare])).toEqual([{ id: "1.0", text: "b" }]);
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
  it("#14250: a reply line or worked time arriving mid-stream redraws the card", () => {
    const base: PromptItem[] = [{ id: "a", text: "x" }];
    expect(samePrompts(base, [{ id: "a", text: "x", reply: "Done." }])).toBe(false);
    expect(samePrompts([{ id: "a", text: "x", reply: "Done." }], [{ id: "a", text: "x", reply: "Done.", workedMs: 1000 }])).toBe(false);
  });
  it("#14250: workedText rounds to the readiest unit, and tickWidth falls off with distance", () => {
    expect(workedText(45_000)).toBe("45s");
    expect(workedText(240_000)).toBe("4m");
    expect(workedText(27_360_000)).toBe("7h 36m");
    expect(workedText(10_800_000)).toBe("3h");
    expect([0, 1, 2, 3, 4].map(tickWidth)).toEqual([24, 20, 17, 14, 14]);
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
const mount = async (prompts: Mk[]) => {
  await act(async () => { root.render(<Harness />); });
  // SAFETY: the Harness above always renders this element.
  scroller = host.querySelector<HTMLDivElement>('[data-testid="sc"]')!;
  await act(async () => { for (const p of prompts) scroller.append(mk(p)); await Promise.resolve(); });
  await act(async () => { await new Promise(r => setTimeout(r, 5)); });
};
// Ticks only: the hover card's file-name buttons also live in the nav, so the selector stops at
// the tick row's direct button.
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Prompt timeline"] > div > button'));

describe("PromptTimeline", () => {
  it("renders one button per operator message", async () => {
    await mount([{ id: "0.0", text: "alpha one" }, { id: "2.0", text: "beta two" }, { id: "4.0", text: "gamma three" }]);
    expect(buttons().map(b => b.getAttribute("aria-label"))).toEqual(["Prompt 1 of 3: alpha one", "Prompt 2 of 3: beta two", "Prompt 3 of 3: gamma three"]);
  });
  it("is not rendered for fewer than two prompts", async () => {
    await mount([{ id: "0.0", text: "only one" }]);
    expect(host.querySelector("nav")).toBeNull();
  });
  it("jumps to the clicked message", async () => {
    await mount([{ id: "0.0", text: "alpha" }, { id: "2.0", text: "beta" }]);
    // SAFETY: the harness appended two div children just above.
    const target = scroller.children[1] as HTMLElement;
    const spy = vi.fn();
    target.scrollIntoView = spy;
    await act(async () => { buttons()[1].click(); });
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("shows the place, the prompt and its age; only the parts that exist", async () => {
    await mount([{ id: "0.0", text: "alpha prompt", ts: Date.now() - 2 * 60 * 60 * 1000 }, { id: "2.0", text: "beta prompt" }]);
    await act(async () => { buttons()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); buttons()[0].focus(); });
    const card = host.querySelector('[role="tooltip"]');
    expect(card?.textContent).toContain("1 / 2");
    expect(card?.textContent).toContain("alpha prompt");
    expect(card?.textContent).toContain("2h ago");
    expect(card?.children.length).toBe(3);
    await act(async () => { buttons()[1].focus(); });
    const second = host.querySelector('[role="tooltip"]');
    expect(second?.textContent).toBe("2 / 2beta prompt");
    expect(second?.children.length).toBe(2);
  });
  it("#14250: the card reads the reply's first line and Worked 4m · 2h ago, and fades in", async () => {
    await mount([
      { id: "0.0", text: "alpha prompt", ts: Date.now() - 2 * 60 * 60 * 1000, reply: "Landed the fix in the login form.", workedMs: 4 * 60 * 1000 },
      { id: "2.0", text: "beta prompt" },
    ]);
    await act(async () => { buttons()[0].focus(); });
    const card = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(card.className).toContain("v2-fade-in");
    expect(card.textContent).toContain("1 / 2");
    expect(card.textContent).toContain("alpha prompt");
    expect(card.textContent).toContain("Landed the fix in the login form.");
    expect(card.textContent).toContain("Worked 4m · 2h ago");
    await act(async () => { buttons()[1].focus(); });
    const second = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(second.textContent).not.toContain("Worked");
    expect(second.textContent).toBe("2 / 2beta prompt");
  });
  it("#14250: a worked time without a send time shows only the Worked part", async () => {
    await mount([{ id: "0.0", text: "alpha", workedMs: 90_000 }, { id: "2.0", text: "beta" }]);
    await act(async () => { buttons()[0].focus(); });
    const card = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(card.textContent).toContain("Worked 1m");
    expect(card.textContent).not.toContain(" · ");
  });
  it("shows the changed files with names and a count, and no line without files", async () => {
    await mount([{ id: "0.0", text: "alpha", files: ["desktop/src/a.ts", "desktop/src-tauri/b.rs"] }, { id: "2.0", text: "beta" }]);
    await act(async () => { buttons()[0].focus(); });
    const card = host.querySelector('[role="tooltip"]')!;
    expect(card.textContent).toContain("Changed 2 files");
    const names = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).map(b => b.textContent);
    expect(names).toEqual(["a.ts", "b.rs"]);
    await act(async () => { buttons()[1].focus(); });
    expect(host.querySelector('[role="tooltip"]')?.textContent).toBe("2 / 2beta");
  });
  it("caps the names at five and counts the rest", async () => {
    const files = ["1.ts", "2.ts", "3.ts", "4.ts", "5.ts", "6.ts", "7.ts"];
    await mount([{ id: "0.0", text: "alpha", files }, { id: "2.0", text: "beta" }]);
    await act(async () => { buttons()[0].focus(); });
    const card = host.querySelector('[role="tooltip"]')!;
    expect(card.textContent).toContain("Changed 7 files");
    expect(card.textContent).toContain("and 2 more");
    expect(card.querySelectorAll("button")).toHaveLength(5);
  });
  it("a file name opens that file's change", async () => {
    await mount([{ id: "0.0", text: "alpha", files: ["desktop/src/a.ts"] }, { id: "2.0", text: "beta" }]);
    await act(async () => { buttons()[0].focus(); });
    const name = host.querySelector<HTMLButtonElement>('[role="tooltip"] button')!;
    await act(async () => { name.click(); });
    expect(opened).toEqual(["desktop/src/a.ts"]);
  });
  it("the card stays open while the pointer is over it and closes when it leaves", async () => {
    await mount([{ id: "0.0", text: "alpha", files: ["a.ts"] }, { id: "2.0", text: "beta" }]);
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
    await mount([{ id: "0.0", text: "a" }, { id: "2.0", text: "b" }, { id: "4.0", text: "c" }]);
    await act(async () => { buttons()[0].focus(); });
    await act(async () => { buttons()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(document.activeElement).toBe(buttons()[1]);
    await act(async () => { buttons()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(document.activeElement).toBe(buttons()[0]);
  });
  it("highlights the prompt on screen and follows the scroll", async () => {
    await mount([{ id: "0.0", text: "a" }, { id: "2.0", text: "b" }, { id: "4.0", text: "c" }]);
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

  it("#14327: sits on the left edge as an overlay, 8x2 ticks muted, the active one 14 wide and 2.5 tall in the text colour", async () => {
    await mount([{ id: "0.0", text: "a" }, { id: "2.0", text: "b" }, { id: "4.0", text: "c" }]);
    const nav = host.querySelector('nav[aria-label="Prompt timeline"]');
    expect(nav?.className).toContain("absolute");
    expect(nav?.className).toContain("left-[3px]");
    expect(nav?.className).toContain("top-[18px]");
    const spans = buttons().map(b => b.querySelector("span"));
    expect(spans[0]?.className).toContain("w-2");
    expect(spans[0]?.className).toContain("h-[2px]");
    expect(spans[0]?.className).toContain("bg-[var(--v2-muted)]");
    expect(spans[0]?.className).toContain("opacity-50");
    expect(spans[2]?.className).toContain("w-3.5");
    expect(spans[2]?.className).toContain("h-[2.5px]");
    expect(spans[2]?.className).toContain("bg-[var(--v2-text)]");
    expect(buttons()[0]?.parentElement?.className).toContain("h-1.5");
  });

  it("#14327: the prompts on screen read at 90%, the rest at 50%", async () => {
    await mount([{ id: "0.0", text: "a" }, { id: "2.0", text: "b" }, { id: "4.0", text: "c" }]);
    // SAFETY: the timeline reads only top and bottom from a rect.
    const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    const spots = [rect(-900, -800), rect(100, 140), rect(2000, 2040)];
    scroller.getBoundingClientRect = () => rect(0, 600);
    Array.from(scroller.children).forEach((c, i) => { c.getBoundingClientRect = () => spots[i]; });
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    const spans = buttons().map(b => b.querySelector("span"));
    // The first prompt is the active one (its top is above the viewport), so it takes the text colour instead.
    expect(spans[0]?.className).toContain("bg-[var(--v2-text)]");
    expect(spans[1]?.className).toContain("opacity-90");
    expect(spans[2]?.className).toContain("opacity-50");
  });

  it("#14327: the hover card opens to the right of its tick", async () => {
    await mount([{ id: "0.0", text: "a" }, { id: "2.0", text: "b" }]);
    await act(async () => { buttons()[0].focus(); });
    const card = host.querySelector<HTMLElement>('[role="tooltip"]');
    expect(card?.style.left).toBe("0px");
    expect(card?.style.right).toBe("");
  });

  it("#14250: ticks widen around the pointer (24, 20, 17, 14) and rest when it leaves", async () => {
    await mount([{ id: "0.0", text: "a" }, { id: "2.0", text: "b" }, { id: "4.0", text: "c" }, { id: "6.0", text: "d" }, { id: "8.0", text: "e" }]);
    const spans = () => buttons().map(b => b.querySelector<HTMLElement>("span"));
    await act(async () => { buttons()[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(spans().map(s => s?.style.width)).toEqual(["20px", "24px", "20px", "17px", "14px"]);
    expect(spans()[1]?.className).toContain("v2-tick");
    await act(async () => { buttons()[1].dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null })); });
    expect(spans().map(s => s?.style.width)).toEqual(["", "", "", "", ""]);
    expect(spans()[0]?.className).toContain("w-2");
  });
});
