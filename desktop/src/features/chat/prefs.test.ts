// prefs.ts drills (#5522 #5523): the persistence is the feature — a panel that forgets its size,
// its reading step or its tray fold on restart is a panel nobody bothers to tune twice. The
// store is injected (the same seam TerminalDeps gives the pane), so these drills run against a
// faithful in-memory stand-in in the node environment — no DOM, no global state between tests —
// and the REFUSING store exercises the private-mode paths the real window can hit.
import { beforeEach, describe, expect, it } from "vitest";
import {
  FONT_SCALE, FONT_STEPS, PANEL_RANGE, clampPanel, fontScale, loadFontStep, loadPanelSize,
  loadTrayOpen, saveFontStep, savePanelSize, saveTrayOpen, type Store,
} from "./prefs";

/** A stand-in with localStorage's exact surface and lifetime: fresh per test, so every drill
 *  starts from "nothing was ever persisted". */
const freshStore = (): Store => {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
};

/** A store that refuses on every touch — private mode, or a window that throws on access. */
const refusingStore = (): Store => ({
  getItem: () => { throw new Error("refused"); },
  setItem: () => { throw new Error("refused"); },
});

let store: Store;
beforeEach(() => { store = freshStore(); });

describe("font step (#5522)", () => {
  it("defaults to M — never-set storage is the designed size, not an error", () => {
    expect(loadFontStep(store)).toBe("m");
  });

  it("falls back to M on a foreign value — only what this module wrote counts", () => {
    store.setItem("trantor.chat.font", "xxlarge");
    expect(loadFontStep(store)).toBe("m");
  });

  it("round-trips S and L through the store", () => {
    saveFontStep("s", store);
    expect(loadFontStep(store)).toBe("s");
    saveFontStep("l", store);
    expect(loadFontStep(store)).toBe("l");
  });

  it("covers exactly the three advertised steps, with M at 1 so M IS the designed size", () => {
    expect(FONT_STEPS.map(s => s.step)).toEqual(["s", "m", "l"]);
    expect(FONT_SCALE.m).toBe(1);
    expect(FONT_SCALE.s).toBeLessThan(1);
    expect(FONT_SCALE.l).toBeGreaterThan(1);
    for (const { step } of FONT_STEPS) expect(fontScale(step)).toBe(FONT_SCALE[step]);
  });

  it("a refusing store reads as never-set and keeps the choice in memory", () => {
    const refused = refusingStore();
    expect(loadFontStep(refused)).toBe("m");
    expect(() => saveFontStep("l", refused)).not.toThrow();
    expect(loadFontStep(refused)).toBe("m");
  });

  it("a null store (no storage at all) reads as never-set", () => {
    expect(loadFontStep(null)).toBe("m");
  });
});

describe("panel size (#5522)", () => {
  it("clamps a width into its sane range at both ends", () => {
    const [min, max] = PANEL_RANGE.width;
    expect(clampPanel(50, "width")).toBe(min);
    expect(clampPanel(4000, "width")).toBe(max);
  });

  it("clamps a height into its sane range at both ends", () => {
    const [min, max] = PANEL_RANGE.height;
    expect(clampPanel(10, "height")).toBe(min);
    expect(clampPanel(4000, "height")).toBe(max);
  });

  it("passes the exact bounds and a mid-range size through, rounded", () => {
    expect(clampPanel(PANEL_RANGE.width[0], "width")).toBe(PANEL_RANGE.width[0]);
    expect(clampPanel(PANEL_RANGE.width[1], "width")).toBe(PANEL_RANGE.width[1]);
    expect(clampPanel(420.6, "width")).toBe(421);
  });

  it("round-trips a dragged size per axis — width and height persist independently", () => {
    savePanelSize("width", 512, store);
    savePanelSize("height", 300, store);
    expect(loadPanelSize("width", store)).toBe(512);
    expect(loadPanelSize("height", store)).toBe(300);
  });

  it("reads null when never set, and clamps a stored out-of-range value on read", () => {
    expect(loadPanelSize("width", store)).toBeNull();
    store.setItem("trantor.chat.width", "9999");
    expect(loadPanelSize("width", store)).toBe(PANEL_RANGE.width[1]);
    store.setItem("trantor.chat.height", "garbage");
    expect(loadPanelSize("height", store)).toBeNull();
  });

  it("a refusing or absent store reads as never-set and never throws on save", () => {
    expect(loadPanelSize("width", refusingStore())).toBeNull();
    expect(loadPanelSize("height", null)).toBeNull();
    expect(() => savePanelSize("width", 500, refusingStore())).not.toThrow();
  });
});

describe("terminal tray fold (#5523)", () => {
  it("starts folded — absent storage means closed, by design", () => {
    expect(loadTrayOpen(store)).toBe(false);
  });

  it("treats a foreign value as folded — only the exact written flag opens it", () => {
    store.setItem("trantor.chat.tray", "yes");
    expect(loadTrayOpen(store)).toBe(false);
  });

  it("round-trips open and folded", () => {
    saveTrayOpen(true, store);
    expect(loadTrayOpen(store)).toBe(true);
    saveTrayOpen(false, store);
    expect(loadTrayOpen(store)).toBe(false);
  });

  it("a refusing or absent store keeps the tray folded", () => {
    expect(loadTrayOpen(refusingStore())).toBe(false);
    expect(loadTrayOpen(null)).toBe(false);
    expect(() => saveTrayOpen(true, refusingStore())).not.toThrow();
  });
});
