// @vitest-environment happy-dom
// #14513: the Workspace's reopen tab — which stored value becomes a tab, when the Browser
// has a page, and what a project reopens on.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserHasPage, readStoredTab, restoredTab, storeTab, tabKey, tabOf } from "./tabState";

let mem: Map<string, string>;
beforeEach(() => {
  mem = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
});

describe("tabState stored values", () => {
  it("tabOf takes only work tabs", () => {
    expect(tabOf("terminal")).toBe("terminal");
    expect(tabOf("changes")).toBe("changes");
    expect(tabOf("browser")).toBe("browser");
    expect(tabOf("files")).toBeNull();
    expect(tabOf(null)).toBeNull();
  });

  it("readStoredTab and storeTab round-trip per project", () => {
    storeTab("trantor", "changes");
    expect(readStoredTab("trantor")).toBe("changes");
    expect(readStoredTab("other")).toBeNull();
    expect(mem.get(tabKey("trantor"))).toBe("changes");
  });

  it("an invalid stored value and blocked storage both read as nothing", () => {
    mem.set(tabKey("trantor"), "files");
    expect(readStoredTab("trantor")).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); },
      removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    });
    expect(readStoredTab("trantor")).toBeNull();
    expect(() => storeTab("trantor", "changes")).not.toThrow();
  });
});

describe("browserHasPage", () => {
  it("a wave-2 state with a page has one", () => {
    expect(browserHasPage({ url: null, pages: [{ id: "p1", url: "https://github.com", title: "GitHub", loading: false, driver: null }] })).toBe(true);
    expect(browserHasPage({ url: "", pages: [] })).toBe(false);
  });

  it("a wave-1 state without a page set falls back to the url", () => {
    expect(browserHasPage({ url: "https://github.com" })).toBe(true);
    expect(browserHasPage({ url: "" })).toBe(false);
    expect(browserHasPage({ url: "about:blank" })).toBe(false);
    expect(browserHasPage({ url: null })).toBe(false);
  });

  it("nothing answered reads as no page", () => {
    expect(browserHasPage(null)).toBe(false);
    expect(browserHasPage(undefined)).toBe(false);
  });
});

describe("restoredTab", () => {
  it("the remembered tab reopens, except the Browser needs a page", () => {
    expect(restoredTab("changes", false)).toBe("changes");
    expect(restoredTab("terminal", false)).toBe("terminal");
    expect(restoredTab("browser", true)).toBe("browser");
    expect(restoredTab("browser", false)).toBe("terminal");
    expect(restoredTab(null, true)).toBe("terminal");
  });
});
