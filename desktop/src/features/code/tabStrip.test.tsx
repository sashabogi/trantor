// @vitest-environment happy-dom
//
// The mode rail's width→layout contract (#6036): a tab word NEVER truncates. The bounces taught
// the real rules — the strip MEASURES both sides (the labels' natural width vs the width the
// strip really has) instead of trusting a hardcoded constant, and the measuring twins must live
// under the SAME cascade as the real tabs (direct children of the strip), because unlayered
// `.tr-seg > button` CSS beats every utility class and a twin styled elsewhere lies. Pinned
// here: around equality, around the hysteresis band, the unmeasured default, the twin-sum
// arithmetic, and — mounted in happy-dom — at a 270px strip like the operator's.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripLabelsNeed, TABS_HYSTERESIS_PX, tabsMode } from "./tabStrip";
import { ModePane } from "./ModePane";
import { PANE_MIN, PANE_ROW_RESERVED } from "./paneWidth";
import { HubClient } from "../../shared/api/client";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("tabsMode", () => {
  it("labels fit exactly at equality — the boundary is pinned", () => {
    expect(tabsMode(270, 270)).toBe("labels");
    expect(tabsMode(271, 270)).toBe("icons");
  });

  it("icon-only when the labels would not fit — the 270px strip specimen", () => {
    expect(tabsMode(292, 270)).toBe("icons");
    expect(tabsMode(300, 270)).toBe("icons");
  });

  it("hysteresis: leaving icons demands TABS_HYSTERESIS_PX of slack, entering does not", () => {
    // on labels: the first pixel of non-fit switches to icons
    expect(tabsMode(271, 270, "labels")).toBe("icons");
    // on icons: still icons at 1..hysteresis-1 px of slack, labels from hysteresis on
    expect(tabsMode(270 - (TABS_HYSTERESIS_PX - 1), 270, "icons")).toBe("icons");
    expect(tabsMode(270 - TABS_HYSTERESIS_PX, 270, "icons")).toBe("labels");
  });

  it("an unmeasured side stays on labels — never degrade on a guess", () => {
    expect(tabsMode(null, 270)).toBe("labels");
    expect(tabsMode(292, null)).toBe("labels");
    expect(tabsMode(undefined, undefined)).toBe("labels");
  });
});

describe("stripLabelsNeed", () => {
  it("sums the twin rects with the strip's computed gap and side padding", () => {
    const strip = document.createElement("div");
    for (const w of [10, 20, 30]) {
      const b = document.createElement("button");
      b.setAttribute("data-twin", "true");
      Object.defineProperty(b, "getBoundingClientRect", { value: () => ({ width: w }), configurable: true });
      strip.appendChild(b);
    }
    // happy-dom resolves no cascade, and its COMPUTED declaration is read-only, so the drill
    // answers with an inline declaration — the same real CSSStyleDeclaration class — carrying
    // exactly the three properties stripLabelsNeed reads, set to the .tr-seg values in
    // styles.css (gap 2px, padding 3px/5px). The precise type is kept, never a laundered literal.
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(el => {
      if (el === strip) {
        const style = document.createElement("div").style;
        style.columnGap = "2px";
        style.paddingLeft = "3px";
        style.paddingRight = "5px";
        return style;
      }
      return real(el);
    });
    try {
      expect(stripLabelsNeed(strip)).toBe(8 + 2 + 2 + 60);
    } finally {
      spy.mockRestore();
    }
  });

  it("a strip with no twins measures as null — the caller stays on labels", () => {
    expect(stripLabelsNeed(document.createElement("div"))).toBeNull();
    expect(stripLabelsNeed(null)).toBeNull();
  });
});

describe("ModePane tab strip (happy-dom)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // A real HubClient instance shape (its prototype) carrying only the two members the tab strip
  // reaches in these renders; no assertion, the type is the class itself.
  const stubClient: HubClient = Object.assign(Object.create(HubClient.prototype), {
    peers: async () => [],
    tasks: async () => [],
  });

  const setWidth = (el: Element, prop: string, value: number) => {
    Object.defineProperty(el, prop, { value, configurable: true });
  };

  // The twins sit inside the strip, so a test pins the labels' need by giving each twin a rect.
  const stubTwins = (strip: Element, width: number) => {
    strip.querySelectorAll<HTMLButtonElement>("button[data-twin='true']").forEach(b => {
      Object.defineProperty(b, "getBoundingClientRect", {
        value: () => ({ width }), configurable: true,
      });
    });
  };

  it("at a 270px strip whose labels need more room, the tabs render icon-only — word in the tooltip, dot and active state kept", () => {
    act(() => root.render(
      <ModePane client={stubClient} project="p" seat={null} onSeat={() => {}} onOpenFile={() => {}} />
    ));
    const strip = host.querySelector<HTMLElement>(".tr-seg");
    const pane = host.querySelector<HTMLElement>(":scope > *");
    if (!pane) throw new Error("ModePane rendered nothing");
    expect(strip?.querySelectorAll("button[data-twin='true']").length).toBe(4);
    // four twins at 70px need 280px — the 270px strip cannot fit the labels
    stubTwins(strip!, 70);
    setWidth(strip!, "clientWidth", 270);
    setWidth(pane, "clientWidth", 270);
    act(() => { window.dispatchEvent(new Event("resize")); });
    const chat = host.querySelector<HTMLElement>("button[aria-label='Chat']");
    expect(chat).toBeTruthy();
    // icon-only: the word is gone from the face, kept in the tooltip
    expect(chat!.getAttribute("title")).toBe("Chat");
    expect(chat!.textContent).not.toContain("Chat");
    // the unread dot and the raised active segment survive the collapse
    expect(chat!.querySelector(".rounded-full")).toBeTruthy();
    expect(host.querySelector("button[data-on='true']")).toBeTruthy();
  });

  it("and steps back to full labels once the labels fit with hysteresis to spare", () => {
    act(() => root.render(
      <ModePane client={stubClient} project="p" seat={null} onSeat={() => {}} onOpenFile={() => {}} />
    ));
    const strip = host.querySelector<HTMLElement>(".tr-seg");
    const pane = host.querySelector<HTMLElement>(":scope > *");
    if (!pane) throw new Error("ModePane rendered nothing");
    stubTwins(strip!, 70);
    setWidth(strip!, "clientWidth", 270);
    setWidth(pane, "clientWidth", 270);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(host.querySelector("button[aria-label='Chat']")!.textContent).not.toContain("Chat");
    // the labels now fit with slack: same strip, words return
    stubTwins(strip!, 60);
    act(() => { window.dispatchEvent(new Event("resize")); });
    const chat = host.querySelector<HTMLElement>("button[aria-label='Chat']");
    expect(chat!.textContent).toContain("Chat");
  });

  it("the pane never outgrows the row: its width is clamped to the window so narrowing the window narrows the strip instead of clipping it", () => {
    act(() => root.render(
      <ModePane client={stubClient} project="p" seat={null} onSeat={() => {}} onOpenFile={() => {}} />
    ));
    const pane = host.querySelector<HTMLElement>(":scope > *");
    if (!pane) throw new Error("ModePane rendered nothing");
    expect(pane.style.maxWidth).toBe(`max(${PANE_MIN}px, calc(100vw - ${PANE_ROW_RESERVED}px))`);
  });
});
