// @vitest-environment happy-dom
//
// The mode rail's width→layout contract (#6036): a tab word NEVER truncates. The bounce taught
// the real rule — the strip MEASURES both sides (the labels' natural width offscreen vs the
// width the strip really has) instead of trusting a hardcoded constant, and switches to
// icon-only only when the labels would not fit, with a few px of hysteresis so a strip at the
// boundary cannot flicker. Pinned here around equality, around the hysteresis band, on the
// unmeasured default, and — mounted in happy-dom — at a 270px strip like the operator's.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TABS_HYSTERESIS_PX, tabsMode } from "./tabStrip";
import { ModePane } from "./ModePane";
import type { HubClient } from "../../shared/api/client";

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

  const stubClient = { peers: async () => [], tasks: async () => [] } as unknown as HubClient;

  const setWidth = (el: Element, prop: string, value: number) => {
    Object.defineProperty(el, prop, { value, configurable: true });
  };

  it("at a 270px strip whose labels need more room, the tabs render icon-only", () => {
    act(() => root.render(
      <ModePane client={stubClient} project="p" seat={null} onSeat={() => {}} onOpenFile={() => {}} />
    ));
    const strip = host.querySelector<HTMLElement>(".tr-seg");
    const pane = host.firstElementChild as HTMLElement;
    const twin = strip?.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(strip).toBeTruthy();
    expect(twin).toBeTruthy();
    setWidth(strip!, "clientWidth", 270);
    setWidth(pane, "clientWidth", 270);
    Object.defineProperty(twin!, "getBoundingClientRect", {
      value: () => ({ width: 292 }), configurable: true,
    });
    act(() => { window.dispatchEvent(new Event("resize")); });
    const chat = host.querySelector<HTMLElement>("button[aria-label='Chat']");
    expect(chat).toBeTruthy();
    // icon-only: the word is gone from the face, kept in the tooltip
    expect(chat!.getAttribute("title")).toBe("Chat");
    expect(chat!.textContent).not.toContain("Chat");
  });

  it("and steps back to full labels once the labels fit with hysteresis to spare", () => {
    act(() => root.render(
      <ModePane client={stubClient} project="p" seat={null} onSeat={() => {}} onOpenFile={() => {}} />
    ));
    const strip = host.querySelector<HTMLElement>(".tr-seg");
    const pane = host.firstElementChild as HTMLElement;
    const twin = strip?.querySelector<HTMLElement>("[aria-hidden='true']");
    setWidth(strip!, "clientWidth", 270);
    setWidth(pane, "clientWidth", 270);
    Object.defineProperty(twin!, "getBoundingClientRect", {
      value: () => ({ width: 292 }), configurable: true,
    });
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(host.querySelector("button[aria-label='Chat']")!.textContent).not.toContain("Chat");
    // the labels now fit with slack: same strip, words return
    Object.defineProperty(twin!, "getBoundingClientRect", {
      value: () => ({ width: 260 }), configurable: true,
    });
    act(() => { window.dispatchEvent(new Event("resize")); });
    const chat = host.querySelector<HTMLElement>("button[aria-label='Chat']");
    expect(chat!.textContent).toContain("Chat");
  });
});
