import { describe, expect, it, vi } from "vitest";
import { openMessagesWith, takeMessagesFocus, watchMessagesFocus } from "./messagesFocus";

describe("messagesFocus", () => {
  it("wakes a watcher when a sender is set, until it stops, and fires once", () => {
    const wake = vi.fn();
    const stop = watchMessagesFocus(wake);
    openMessagesWith("codex-8:trantor");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(takeMessagesFocus()).toBe("codex-8:trantor");
    expect(takeMessagesFocus()).toBeNull();
    stop();
    openMessagesWith("glm-5:trantor");
    expect(wake).toHaveBeenCalledTimes(1);
    takeMessagesFocus();
  });

  it("a take with nothing waiting is null", () => {
    expect(takeMessagesFocus()).toBeNull();
  });
});
