// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

// The two native commands are faked at the IPC seam; the permission answer is chosen per test.
let sent = 0;
let asked = 0;
let answer = "granted";
type Notify = typeof import("./notify");
let mod: Notify;

let focused = true;
let visible: "visible" | "hidden" = "visible";

beforeEach(async () => {
  sent = 0; asked = 0; answer = "granted";
  mockIPC(command => {
    if (command === "notify_permission") { asked += 1; return answer; }
    if (command === "notify_send") { sent += 1; return null; }
    return null;
  });
  vi.resetModules();
  mod = await import("./notify");
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
afterEach(() => { clearMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const n = { title: "t", body: "b" };
const dark = { lastSeenMs: 1000 };

describe("notifications only in the background", () => {
  it("sends nothing while the window is focused and the setting is unset", async () => {
    expect(await mod.notifyDutyDark(dark)).toBe(false);
    expect(sent).toBe(0);
  });

  it("sends when the window is not focused", async () => {
    focused = false;
    expect(await mod.notifyDutyDark(dark)).toBe(true);
    expect(sent).toBe(1);
  });

  it("treats a hidden window as background even if it reports focus", async () => {
    visible = "hidden";
    expect(await mod.notifyDutyDark(dark)).toBe(true);
  });

  it("still shows the answer to the operator's own click while the window is in front", async () => {
    expect(await mod.notifyOnce(n)).toBe(true);
    expect(sent).toBe(1);
  });

  it("sends in both cases with the setting off", async () => {
    mod.setBackgroundOnly(false);
    expect(await mod.notifyDutyDark(dark)).toBe(true);
    focused = false;
    expect(await mod.notifyDutyDark(dark)).toBe(true);
    expect(sent).toBe(2);
  });

  it("sends nothing and asks only once per run when permission is denied", async () => {
    answer = "denied";
    focused = false;
    expect(await mod.notifyDutyDark(dark)).toBe(false);
    expect(await mod.notifyDutyDark(dark)).toBe(false);
    expect(await mod.notifyOnce(n)).toBe(false);
    expect(sent).toBe(0);
    expect(asked).toBe(1);
  });
});
