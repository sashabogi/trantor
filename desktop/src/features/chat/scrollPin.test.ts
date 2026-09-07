// scrollPin.ts drills (#6697): the geometry rule behind stick-to-bottom. The transcript follows
// new content only while the viewport already sits within the threshold of the foot.
import { describe, expect, it } from "vitest";
import { PIN_THRESHOLD_PX, isPinned } from "./scrollPin";

describe("isPinned", () => {
  it("exactly at the foot is pinned", () => {
    expect(isPinned({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 })).toBe(true);
  });

  it("within the threshold still counts as at the bottom — a smooth scroll settling short must not unpin", () => {
    expect(isPinned({ scrollHeight: 1000, scrollTop: 700 - PIN_THRESHOLD_PX, clientHeight: 300 })).toBe(true);
    expect(isPinned({ scrollHeight: 1000, scrollTop: 700 - PIN_THRESHOLD_PX - 1, clientHeight: 300 })).toBe(false);
  });

  it("scrolled up to read is not pinned", () => {
    expect(isPinned({ scrollHeight: 1000, scrollTop: 100, clientHeight: 300 })).toBe(false);
    expect(isPinned({ scrollHeight: 1000, scrollTop: 0, clientHeight: 300 })).toBe(false);
  });

  it("content shorter than the viewport is always pinned — there is nowhere else to be", () => {
    expect(isPinned({ scrollHeight: 120, scrollTop: 0, clientHeight: 300 })).toBe(true);
    expect(isPinned({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })).toBe(true);
  });

  it("the threshold is injectable", () => {
    expect(isPinned({ scrollHeight: 1000, scrollTop: 690, clientHeight: 300 }, 5)).toBe(false);
    expect(isPinned({ scrollHeight: 1000, scrollTop: 690, clientHeight: 300 }, 10)).toBe(true);
  });
});
