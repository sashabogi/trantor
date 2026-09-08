// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrillMode } from "./DrillMode";
import type { DrillApi } from "./drillApi";
import { DRILL_STEPS } from "./drillSteps";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeApi(over: Partial<DrillApi> = {}) {
  const api: DrillApi = {
    seedProject: vi.fn(async () => "drill-20260907-2104"),
    moveCard: vi.fn(async () => {}),
    screenshot: vi.fn(async (label: string) => `/tmp/drills/1-${label}.png`),
    autoCheck: vi.fn(() => ({ ok: false, why: "nothing mounted" })),
    settle: vi.fn(async () => {}),
    trace: vi.fn(),
    ...over,
  };
  return api;
}

describe("DrillMode", () => {
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

  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const mount = async (api: DrillApi, onClose = vi.fn()) => {
    await act(async () => {
      root.render(<DrillMode me="sasha@mac" onClose={onClose} deps={api} />);
      await flush();
    });
    return onClose;
  };
  const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim().startsWith(label));
  const click = async (label: string) => {
    const b = button(label);
    expect(b, `button ${label}`).toBeDefined();
    await act(async () => { b!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  };

  it("seeds a disposable project first and opens on the first card with its action and expected result", async () => {
    const api = fakeApi();
    await mount(api);
    expect(api.seedProject).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Drill on drill-20260907-2104");
    expect(host.textContent).toContain(`#${DRILL_STEPS[0].card}`);
    expect(host.querySelector('[data-testid="drill-action"]')?.textContent).toBe(DRILL_STEPS[0].action);
    expect(host.querySelector('[data-testid="drill-expected"]')?.textContent).toBe(DRILL_STEPS[0].expected);
    expect(host.textContent).toContain(`1 / ${DRILL_STEPS.length}`);
    // the panel docks (pointer-events pass through around it) — it never covers the app
    expect(host.querySelector('[data-testid="wizard-frame"]')?.className).toContain("pointer-events-none");
    expect(api.moveCard).not.toHaveBeenCalled();
  });

  it("refuses to run on a real project and moves nothing", async () => {
    const api = fakeApi({ seedProject: vi.fn(async () => "crebral-health") });
    await mount(api);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("crebral-health is a real project");
    expect(button("Pass")).toBeUndefined();
    expect(api.moveCard).not.toHaveBeenCalled();
    expect(api.trace).toHaveBeenCalledWith("refused: stage 'crebral-health' is not disposable");
  });

  it("Pass hides the panel, captures a screenshot, closes the card with a note citing it, and advances", async () => {
    const order: string[] = [];
    const api = fakeApi({
      settle: vi.fn(async () => { order.push(`settle hidden=${host.querySelector<HTMLElement>('[data-testid="wizard-frame"]')?.style.visibility}`); }),
      screenshot: vi.fn(async (label: string) => { order.push("shot"); return `/tmp/drills/9-${label}.png`; }),
      moveCard: vi.fn(async () => { order.push("move"); }),
    });
    await mount(api);
    const first = DRILL_STEPS[0].card;
    await click("Pass");
    expect(order).toEqual(["settle hidden=hidden", "shot", "move"]);
    expect(api.screenshot).toHaveBeenCalledWith(`card-${first}`);
    expect(api.moveCard).toHaveBeenCalledWith(first, "done",
      `drill-mode PASS by sasha@mac on drill-20260907-2104 · screenshot /tmp/drills/9-card-${first}.png · auto-check none (human only)`);
    expect(host.textContent).toContain(`#${DRILL_STEPS[1].card}`);
    expect(host.textContent).toContain(`2 / ${DRILL_STEPS.length}`);
    // the panel is visible again after the capture
    expect(host.querySelector<HTMLElement>('[data-testid="wizard-frame"]')?.style.visibility).not.toBe("hidden");
  });

  it("Fail bounces the card to doing with the operator's note and takes no screenshot", async () => {
    const api = fakeApi();
    await mount(api);
    const first = DRILL_STEPS[0].card;
    const note = host.querySelector<HTMLTextAreaElement>('[data-testid="drill-note"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(note, "sheet did not switch to From a brief");
      note.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await click("Fail");
    expect(api.screenshot).not.toHaveBeenCalled();
    expect(api.moveCard).toHaveBeenCalledWith(first, "doing",
      "drill-mode FAIL by sasha@mac on drill-20260907-2104 · auto-check none (human only) · sheet did not switch to From a brief");
    expect(host.textContent).toContain(`#${DRILL_STEPS[1].card}`);
  });

  it("an auto-check pre-fills the verdict but the card moves only on the operator's Pass", async () => {
    const api = fakeApi({ autoCheck: vi.fn(() => ({ ok: true, why: "chip row mounted with 2 chip(s)" })) });
    await mount(api);
    const chipsIndex = DRILL_STEPS.findIndex(s => s.autoCheck === "chips-mounted");
    for (let i = 0; i < chipsIndex; i++) await click("Skip");
    expect(host.textContent).toContain("#5993");
    expect(api.autoCheck).toHaveBeenCalledWith("chips-mounted");
    expect(host.querySelector('[data-testid="drill-auto-check"]')?.textContent).toContain("Auto-check says pass");
    expect(api.moveCard).not.toHaveBeenCalled();
    await click("Pass");
    expect(api.moveCard).toHaveBeenCalledTimes(1);
    expect(api.moveCard).toHaveBeenCalledWith(5993, "done", expect.stringContaining("auto-check ok: chip row mounted with 2 chip(s)"));
  });

  it("a hub refusal keeps the step on screen with the error instead of advancing", async () => {
    const api = fakeApi({ moveCard: vi.fn(async () => { throw new Error("POST /task/update → 409"); }) });
    await mount(api);
    await click("Pass");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Not recorded — POST /task/update → 409");
    expect(host.textContent).toContain(`#${DRILL_STEPS[0].card}`);
    expect(host.textContent).toContain(`1 / ${DRILL_STEPS.length}`);
  });

  it("walks every card to the summary, then Close hands back to the shell", async () => {
    const api = fakeApi();
    const onClose = await mount(api);
    for (let i = 0; i < DRILL_STEPS.length; i++) await click(i % 2 === 0 ? "Pass" : "Skip");
    const passes = Math.ceil(DRILL_STEPS.length / 2);
    expect(api.moveCard).toHaveBeenCalledTimes(passes);
    expect(host.querySelector('[data-testid="drill-summary"]')?.textContent)
      .toBe(`${passes} passed · 0 failed · ${DRILL_STEPS.length - passes} skipped of ${DRILL_STEPS.length}`);
    expect(onClose).not.toHaveBeenCalled();
    await click("Close");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Stop closes mid-drill without moving the current card", async () => {
    const api = fakeApi();
    const onClose = await mount(api);
    await click("Stop");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.moveCard).not.toHaveBeenCalled();
  });
});
