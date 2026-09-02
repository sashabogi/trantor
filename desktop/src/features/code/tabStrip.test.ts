// The mode rail's width→layout contract (#6036): a tab word NEVER truncates. Below the width
// that fits all four labels the strip renders icon-only (label as tooltip, unread dot kept);
// at or above it, full labels. The boundary is pinned exactly — 287 is icons, 288 is labels —
// and an unmeasured width stays on the designed default (labels).
import { describe, expect, it } from "vitest";
import { TAB_LABELS_MIN_WIDTH, tabsMode } from "./tabStrip";

describe("tabsMode", () => {
  it("full labels at the designed pane widths (300 and 440)", () => {
    expect(tabsMode(300)).toBe("labels");
    expect(tabsMode(440)).toBe("labels");
  });

  it("icon-only below the width that fits all four labels", () => {
    expect(tabsMode(287)).toBe("icons");
    expect(tabsMode(200)).toBe("icons");
    expect(tabsMode(0)).toBe("icons");
  });

  it("the boundary is exact — TAB_LABELS_MIN_WIDTH is the first labels width", () => {
    expect(tabsMode(TAB_LABELS_MIN_WIDTH)).toBe("labels");
    expect(tabsMode(TAB_LABELS_MIN_WIDTH - 1)).toBe("icons");
  });

  it("an unmeasured width stays on labels — never degrade on a guess", () => {
    expect(tabsMode(null)).toBe("labels");
    expect(tabsMode(undefined)).toBe("labels");
  });
});
