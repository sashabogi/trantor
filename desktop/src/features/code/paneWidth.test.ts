// The pane width contract (#6086), pure: the clamp (280 floor, 60%-of-window ceiling) and the
// per-mode persistence — what was dragged comes back; what was corrupted, cleared, or never
// written does not pretend to. No DOM: the store is a plain two-method object, the way
// prefs.test.ts does it.
import { describe, expect, it } from "vitest";
import {
  clearPaneWidth,
  clampPaneWidth,
  loadPaneWidth,
  paneMax,
  PANE_DEFAULT,
  PANE_MAX_FRAC,
  PANE_MIN,
  savePaneWidth,
} from "./paneWidth";
import type { Store } from "../chat/prefs";

const memoryStore = (initial: Record<string, string> = {}): Store => {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
};

describe("clampPaneWidth", () => {
  it("holds the 280px floor", () => {
    expect(clampPaneWidth(200, 1920)).toBe(PANE_MIN);
    expect(clampPaneWidth(0, 1920)).toBe(PANE_MIN);
    expect(clampPaneWidth(-80, 1920)).toBe(PANE_MIN);
  });

  it("caps at 60% of the window, floored", () => {
    expect(paneMax(1000)).toBe(600);
    expect(clampPaneWidth(900, 1000)).toBe(600);
    expect(clampPaneWidth(5000, 1000)).toBe(600);
  });

  it("keeps the boundaries themselves reachable", () => {
    expect(clampPaneWidth(PANE_MIN, 1920)).toBe(PANE_MIN);
    expect(clampPaneWidth(paneMax(1000), 1000)).toBe(paneMax(1000));
  });

  it("rounds to whole px", () => {
    expect(clampPaneWidth(312.6, 1920)).toBe(313);
    expect(clampPaneWidth(312.4, 1920)).toBe(312);
  });

  it("the floor wins on a window so small the cap sits below it", () => {
    expect(paneMax(400)).toBeLessThan(PANE_MIN);
    expect(clampPaneWidth(320, 400)).toBe(PANE_MIN);
  });

  it("with no usable window dimension the floor still applies and the cap cannot", () => {
    expect(clampPaneWidth(520, NaN)).toBe(520);
    expect(clampPaneWidth(40, NaN)).toBe(PANE_MIN);
  });
});

describe("per-mode persistence", () => {
  it("round-trips a dragged width per mode, and the modes do not bleed", () => {
    const store = memoryStore();
    savePaneWidth("chat", 520, store);
    savePaneWidth("files", 341, store);
    expect(loadPaneWidth("chat", store)).toBe(520);
    expect(loadPaneWidth("files", store)).toBe(341);
    expect(loadPaneWidth("git", store)).toBeNull();
  });

  it("clamps on read and on write — storage bytes are never trusted", () => {
    const store = memoryStore({ "trantor.pane.width.chat": "5000", "trantor.pane.width.files": "40" });
    expect(loadPaneWidth("chat", store, 1000)).toBe(600);
    expect(loadPaneWidth("files", store, 1920)).toBe(PANE_MIN);
    const writer = memoryStore();
    savePaneWidth("chat", 5000, writer, 1000);
    expect(writer.getItem("trantor.pane.width.chat")).toBe("600");
  });

  it("a cleared width reads as never-set, not as a stale number", () => {
    const store = memoryStore();
    savePaneWidth("git", 420, store);
    clearPaneWidth("git", store);
    expect(loadPaneWidth("git", store)).toBeNull();
  });

  it("corrupted and foreign bytes read as never-set", () => {
    const store = memoryStore({ "trantor.pane.width.sessions": "wide", "trantor.pane.width.chat": "" });
    expect(loadPaneWidth("sessions", store)).toBeNull();
    expect(loadPaneWidth("chat", store)).toBeNull();
  });
});

describe("total readers — a hostile store can never crash the pane", () => {
  it("a null store reads as never-set and writing is a no-op", () => {
    expect(loadPaneWidth("files", null)).toBeNull();
    expect(() => savePaneWidth("files", 400, null)).not.toThrow();
    expect(() => clearPaneWidth("files", null)).not.toThrow();
  });

  it("a refusing store reads as never-set and keeps writing quiet", () => {
    const refusing: Store = {
      getItem: () => { throw new Error("private mode"); },
      setItem: () => { throw new Error("private mode"); },
    };
    expect(loadPaneWidth("files", refusing)).toBeNull();
    expect(() => savePaneWidth("files", 400, refusing)).not.toThrow();
    expect(() => clearPaneWidth("files", refusing)).not.toThrow();
  });
});

describe("the designed defaults are the artboard truth", () => {
  it("chat 440, the other three 300 — the widths the pane rendered before dragging existed", () => {
    expect(PANE_DEFAULT.chat).toBe(440);
    expect(PANE_DEFAULT.files).toBe(300);
    expect(PANE_DEFAULT.git).toBe(300);
    expect(PANE_DEFAULT.sessions).toBe(300);
  });

  it("the cap fraction is 60%", () => {
    expect(PANE_MAX_FRAC).toBe(0.6);
  });
});
