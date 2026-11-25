// @vitest-environment happy-dom
// #v2-F: one key or ?ui=v2 opens 2.0; Back to classic clears both.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backToClassic, enterV2, UI_KEY, wantsV2 } from "./toggle";
import { isLensScreen, type Screen } from "./routes";
import { MODE_CONFIG, MODE_KEY, readMode, saveMode } from "./shell/shellMode";

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
    // SAFETY: "browser" was a LensScreen before #14053 removed it; the assertion feeds a stale
    // stored route string that the literal type can no longer express.
    expect(isLensScreen("browser" as Screen)).toBe(false);
    expect(isLensScreen("dashboard")).toBe(false);
    expect(isLensScreen("settings")).toBe(false);
  });

  it("remembers the mode and falls back to orchestrator", () => {
    expect(readMode()).toBe("orchestrator");
    saveMode("developer");
    expect(readMode()).toBe("developer");
  });

  // #14070: Mixed is shown and cannot be picked, so neither a click nor an old stored value selects it.
  it("never reads or stores a mode that cannot be picked", () => {
    saveMode("developer");
    saveMode("mixed");
    expect(readMode()).toBe("developer");
    localStorage.setItem(MODE_KEY, "mixed");
    expect(readMode()).toBe("orchestrator");
    expect(MODE_CONFIG.mixed.unavailable).toContain("Mixed mode comes next");
    expect(MODE_CONFIG.developer.landing).toBe("code");
    expect(MODE_CONFIG.developer.lenses[0]).toBe("code");
  });
});
