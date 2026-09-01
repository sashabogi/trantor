// The preview/pin rule is the tab strip's one non-negotiable (Orca split-open.ts:26-29 anatomy,
// RESEARCH-orca-renderer.md §4): a preview is replaced by the next preview click, a pinned tab
// never moves, the dirty dot only follows the draft, and activation survives closes sensibly.
import { describe, expect, it } from "vitest";
import { closeTab, findTab, markDirty, openInTabs, tabKey, togglePin, type CodeTab } from "./codeTabs";

const t = (scope: string, path: string, pinned = false): CodeTab => ({
  key: tabKey(scope, path),
  scope,
  path,
  view: "code",
  pinned,
  dirty: false,
});

describe("openInTabs", () => {
  it("navigates the active preview in place instead of stacking tabs", () => {
    const start = [t("project", "a.ts")];
    const { tabs, activeKey } = openInTabs(start, tabKey("project", "a.ts"), "project", "b.ts", "code");
    expect(tabs.map(x => x.path)).toEqual(["b.ts"]);
    expect(activeKey).toBe(tabKey("project", "b.ts"));
  });

  it("opens a fresh preview when the active tab is pinned", () => {
    const start = [t("project", "a.ts", true)];
    const { tabs, activeKey } = openInTabs(start, tabKey("project", "a.ts"), "project", "b.ts", "code");
    expect(tabs.map(x => x.path)).toEqual(["a.ts", "b.ts"]);
    expect(tabs[0].pinned).toBe(true);
    expect(tabs[1].pinned).toBe(false);
    expect(activeKey).toBe(tabKey("project", "b.ts"));
  });

  it("activates an existing pinned tab instead of duplicating or moving it", () => {
    const start = [t("project", "a.ts", true), t("project", "b.ts")];
    const { tabs, activeKey } = openInTabs(start, tabKey("project", "b.ts"), "project", "a.ts", "changes");
    expect(tabs.map(x => x.path)).toEqual(["a.ts", "b.ts"]);
    expect(tabs[0].pinned).toBe(true);
    expect(tabs[0].view).toBe("changes");
    expect(activeKey).toBe(tabKey("project", "a.ts"));
  });

  it("keeps scopes in one list: a seat tab can be previewed while project tabs sit pinned", () => {
    const start = [t("project", "a.ts", true)];
    const { tabs } = openInTabs(start, tabKey("project", "a.ts"), "glm", "src/lib.rs", "code");
    expect(tabs.map(x => x.key)).toEqual([
      tabKey("project", "a.ts"),
      tabKey("glm", "src/lib.rs"),
    ]);
  });

  it("the same path in two worktrees is two tabs — identity is scope+path", () => {
    const start = [t("project", "src/lib.rs", true)];
    const one = openInTabs(start, tabKey("project", "src/lib.rs"), "glm", "src/lib.rs", "changes");
    expect(findTab(one.tabs, "project", "src/lib.rs")?.view).toBe("code");
    expect(findTab(one.tabs, "glm", "src/lib.rs")?.view).toBe("changes");
  });
});

describe("togglePin and markDirty", () => {
  it("pin survives a preview navigation; unpin makes it the preview again", () => {
    let tabs = [t("project", "a.ts"), t("project", "b.ts")];
    tabs = togglePin(tabs, tabKey("project", "b.ts"));
    expect(tabs.find(x => x.path === "b.ts")?.pinned).toBe(true);
    const { tabs: after } = openInTabs(tabs, tabKey("project", "b.ts"), "project", "c.ts", "code");
    expect(after.map(x => x.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("markDirty touches exactly one tab and previewing a new path resets the dot it carried", () => {
    let tabs = [t("project", "a.ts")];
    tabs = markDirty(tabs, tabKey("project", "a.ts"), true);
    expect(tabs[0].dirty).toBe(true);
    const { tabs: after } = openInTabs(tabs, tabKey("project", "a.ts"), "project", "b.ts", "code");
    expect(after.map(x => x.dirty)).toEqual([false]);
  });
});

describe("closeTab", () => {
  it("closing the active tab activates its same-scope neighbor", () => {
    const tabs = [t("project", "a.ts"), t("project", "b.ts"), t("glm", "x.rs")];
    const closed = closeTab(tabs, tabKey("project", "b.ts"), tabKey("project", "b.ts"));
    expect(closed.activeKey).toBe(tabKey("project", "a.ts"));
  });

  it("closing the last tab of a scope moves activation to another scope, or null", () => {
    const tabs = [t("project", "a.ts"), t("glm", "x.rs")];
    const one = closeTab(tabs, tabKey("glm", "x.rs"), tabKey("glm", "x.rs"));
    expect(one.activeKey).toBe(tabKey("project", "a.ts"));
    const none = closeTab(one.tabs, tabKey("project", "a.ts"), tabKey("project", "a.ts"));
    expect(none.activeKey).toBeNull();
    expect(none.tabs).toEqual([]);
  });

  it("closing a background tab leaves activation alone", () => {
    const tabs = [t("project", "a.ts"), t("glm", "x.rs")];
    const { activeKey } = closeTab(tabs, tabKey("project", "a.ts"), tabKey("glm", "x.rs"));
    expect(activeKey).toBe(tabKey("project", "a.ts"));
  });
});
