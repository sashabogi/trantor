// @vitest-environment happy-dom
// #v2-F: one key or ?ui=v2 opens 2.0; Back to classic clears both.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backToClassic, enterV2, UI_KEY, wantsV2 } from "./toggle";
import { isLensScreen, readMode, saveMode } from "./routes";

// happy-dom under this Node exposes no localStorage, so each test gets an in-memory one.
beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the 2.0 toggle", () => {
  it("is classic by default", () => {
    expect(wantsV2("")).toBe(false);
  });

  it("opens 2.0 from the stored key or the URL", () => {
    expect(wantsV2("?ui=v2")).toBe(true);
    localStorage.setItem(UI_KEY, "v2");
    expect(wantsV2("")).toBe(true);
    localStorage.setItem(UI_KEY, "classic");
    expect(wantsV2("")).toBe(false);
  });

  it("enterV2 sets the key and reloads", () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    enterV2();
    expect(localStorage.getItem(UI_KEY)).toBe("v2");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("backToClassic clears the key and reloads without ?ui", () => {
    localStorage.setItem(UI_KEY, "v2");
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    backToClassic();
    expect(localStorage.getItem(UI_KEY)).toBeNull();
    expect(replace).toHaveBeenCalledOnce();
    expect(String(replace.mock.calls[0][0])).not.toContain("ui=v2");
  });
});

describe("routes", () => {
  it("knows which screens live inside a project", () => {
    expect(isLensScreen("board")).toBe(true);
    expect(isLensScreen("browser")).toBe(true);
    expect(isLensScreen("dashboard")).toBe(false);
    expect(isLensScreen("settings")).toBe(false);
  });

  it("remembers the mode and falls back to orchestrator", () => {
    expect(readMode()).toBe("orchestrator");
    saveMode("developer");
    expect(readMode()).toBe("developer");
  });
});
