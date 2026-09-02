// composerHeight.ts drills (#6070): the composer is freely resizable between two lines and about
// 60% of the pane, it grows with content until the operator chooses a height, and the choice
// survives restart. The store is injected the way prefs.ts drills it — fresh per test, plus a
// REFUSING stand-in for the private-mode paths a real window hits.
import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSER_LINE_PX, COMPOSER_PAD_PX, clampComposerPx, growComposerPx, loadComposerHeight,
  maxComposerPx, minComposerPx, saveComposerHeight,
} from "./composerHeight";
import type { Store } from "./prefs";

const freshStore = (): Store => {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
};

const refusingStore = (): Store => ({
  getItem: () => { throw new Error("refused"); },
  setItem: () => { throw new Error("refused"); },
});

let store: Store;
beforeEach(() => { store = freshStore(); });

describe("the bounds", () => {
  it("the floor is two lines of the designed metrics, plus the padding", () => {
    expect(minComposerPx()).toBe(Math.round(2 * COMPOSER_LINE_PX + COMPOSER_PAD_PX));
  });

  it("the ceiling is 60% of the pane, and never below the floor", () => {
    expect(maxComposerPx(700)).toBe(420);
    expect(maxComposerPx(50)).toBe(minComposerPx());
  });
});

describe("clampComposerPx", () => {
  it("holds [floor, ceiling] and rounds", () => {
    const min = minComposerPx();
    const max = maxComposerPx(700);
    expect(clampComposerPx(10, min, max)).toBe(min);
    expect(clampComposerPx(10_000, min, max)).toBe(max);
    expect(clampComposerPx(200.6, min, max)).toBe(201);
    expect(clampComposerPx(200, min, max)).toBe(200);
  });
});

describe("growComposerPx — content decides within the bounds", () => {
  const min = minComposerPx();
  const max = maxComposerPx(700);

  it("content below the floor gets the floor", () => {
    expect(growComposerPx(20, min, max)).toBe(min);
  });

  it("content above the ceiling gets the ceiling", () => {
    expect(growComposerPx(5000, min, max)).toBe(max);
  });

  it("content in range IS the height", () => {
    expect(growComposerPx(140, min, max)).toBe(140);
  });
});

describe("the remembered height", () => {
  const min = minComposerPx();
  const max = maxComposerPx(700);

  it("never-set storage reads as never-resized (null)", () => {
    expect(loadComposerHeight(min, max, store)).toBeNull();
  });

  it("round-trips a chosen height", () => {
    saveComposerHeight(180, min, max, store);
    expect(loadComposerHeight(min, max, store)).toBe(180);
  });

  it("clamps a stored out-of-range number on read — storage bytes are decoded, never trusted", () => {
    store.setItem("trantor.chat.composerHeight", "99999");
    expect(loadComposerHeight(min, max, store)).toBe(max);
    store.setItem("trantor.chat.composerHeight", "1");
    expect(loadComposerHeight(min, max, store)).toBe(min);
  });

  it("garbage and non-positive values read as never-set", () => {
    store.setItem("trantor.chat.composerHeight", "tall");
    expect(loadComposerHeight(min, max, store)).toBeNull();
    store.setItem("trantor.chat.composerHeight", "-4");
    expect(loadComposerHeight(min, max, store)).toBeNull();
  });

  it("save clamps what it writes", () => {
    saveComposerHeight(99_999, min, max, store);
    expect(store.getItem("trantor.chat.composerHeight")).toBe(String(max));
  });

  it("a refusing store reads as never-set and never throws on save", () => {
    const refused = refusingStore();
    expect(loadComposerHeight(min, max, refused)).toBeNull();
    expect(() => saveComposerHeight(180, min, max, refused)).not.toThrow();
  });
});
