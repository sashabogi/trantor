// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notifyDutyDark, notifyOnce, setBackgroundOnly } from "./notify";

// The plugin sends through the web Notification constructor, so a faithful fake counts those.
let sent = 0;
class FakeNotification {
  static permission = "granted";
  constructor() { sent += 1; }
}

let focused = true;
let visible: "visible" | "hidden" = "visible";

beforeEach(() => {
  sent = 0;
  vi.stubGlobal("Notification", FakeNotification);
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  focused = true;
  visible = "visible";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const n = { title: "t", body: "b" };
const dark = { lastSeenMs: 1000 };

describe("notifications only in the background", () => {
  it("sends nothing while the window is focused and the setting is unset", async () => {
    expect(await notifyDutyDark(dark)).toBe(false);
    expect(sent).toBe(0);
  });

  it("sends when the window is not focused", async () => {
    focused = false;
    expect(await notifyDutyDark(dark)).toBe(true);
    expect(sent).toBe(1);
  });

  it("treats a hidden window as background even if it reports focus", async () => {
    visible = "hidden";
    expect(await notifyDutyDark(dark)).toBe(true);
  });

  it("still shows the answer to the operator's own click while the window is in front", async () => {
    expect(await notifyOnce(n)).toBe(true);
    expect(sent).toBe(1);
  });

  it("sends in both cases with the setting off", async () => {
    setBackgroundOnly(false);
    expect(await notifyDutyDark(dark)).toBe(true);
    focused = false;
    expect(await notifyDutyDark(dark)).toBe(true);
    expect(sent).toBe(2);
  });
});
