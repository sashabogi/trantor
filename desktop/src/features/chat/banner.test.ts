import { describe, expect, it } from "vitest";
import { bannerCountdown, HANDOFF_COUNTDOWN_MS } from "./banner";

describe("bannerCountdown", () => {
  it("stays hidden until the context fraction is known and at the handoff threshold", () => {
    expect(bannerCountdown(null, 1_000, 1_000).visible).toBe(false);
    expect(bannerCountdown(0.899, 1_000, 1_000).visible).toBe(false);
    expect(bannerCountdown(0.9, null, 1_000).visible).toBe(false);
  });

  it("starts at ten seconds when armed", () => {
    expect(bannerCountdown(0.9, 1_000, 1_000)).toEqual({
      visible: true,
      expired: false,
      remainingMs: HANDOFF_COUNTDOWN_MS,
      remainingSec: 10,
    });
  });

  it("ceil-rounds visible seconds so the banner never says zero before expiry", () => {
    expect(bannerCountdown(0.95, 1_000, 10_001)).toMatchObject({
      visible: true,
      expired: false,
      remainingSec: 1,
    });
  });

  it("expires once the full countdown elapses", () => {
    expect(bannerCountdown(1, 1_000, 11_000)).toEqual({
      visible: true,
      expired: true,
      remainingMs: 0,
      remainingSec: 0,
    });
  });

  it("does not go negative if the clock runs long", () => {
    expect(bannerCountdown(1, 1_000, 30_000)).toMatchObject({
      expired: true,
      remainingMs: 0,
      remainingSec: 0,
    });
  });
});
