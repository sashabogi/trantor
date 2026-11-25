import { describe, expect, it, vi } from "vitest";
import { openSettingsAt, takeSettingsSection, watchSettingsSection } from "./settingsIntent";

describe("settingsIntent", () => {
  it("hands a requested page over once", () => {
    expect(takeSettingsSection()).toBeNull();
    openSettingsAt("general");
    expect(takeSettingsSection()).toBe("general");
    expect(takeSettingsSection()).toBeNull();
  });

  it("wakes an open Settings screen, and stops when asked to", () => {
    const wake = vi.fn();
    const stop = watchSettingsSection(wake);
    openSettingsAt("general");
    expect(wake).toHaveBeenCalledTimes(1);
    stop();
    openSettingsAt("notifications");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(takeSettingsSection()).toBe("notifications");
  });
});
