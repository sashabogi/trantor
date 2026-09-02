// The round-trip contract (#5938): editor state outlives the lens. Open two tabs, type in one,
// let the surface unmount (which touches NOTHING in the store), come back — same tabs, same
// draft, same dirty dot. The store composes the pure helpers; those stay tested where they live.
import { describe, expect, it } from "vitest";
import {
  clearLoaded,
  dropDocument,
  markLoaded,
  projectDocuments,
  setBaseSignature,
  setDisk,
  setDraft,
  setActiveKey,
  setTabs,
} from "./documents";
import { markDirty, openInTabs, tabKey, togglePin } from "./codeTabs";

describe("documents — editor state outlives the lens", () => {
  it("open two tabs, type in one, remount: same tabs, same draft, same dirty dot", () => {
    const project = "roundtrip";
    // open a.ts, PIN it (so it survives), then open b.ts — preview semantics are the pure
    // model's job, and an unpinned preview would rightly be replaced by the next open
    let docs = projectDocuments(project);
    const open = (path: string, view: "code" | "changes") => {
      const next = openInTabs(docs.tabs, docs.activeKey, "project", path, view);
      setTabs(project, next.tabs);
      setActiveKey(project, next.activeKey);
      docs = projectDocuments(project);
    };
    open("a.ts", "code");
    setTabs(project, togglePin(projectDocuments(project).tabs, tabKey("project", "a.ts")));
    open("b.ts", "changes");
    // a.ts is pinned (it survives), b.ts is the live preview; type into a
    open("a.ts", "code");
    setDisk(project, tabKey("project", "a.ts"), "original text");
    setBaseSignature(project, tabKey("project", "a.ts"), "sig-a");
    markLoaded(project, tabKey("project", "a.ts"));
    setDraft(project, tabKey("project", "a.ts"), "my edits");
    // the dirty dot is written through markDirty on every keystroke — Files composes the same way
    setTabs(project, markDirty(projectDocuments(project).tabs, tabKey("project", "a.ts"), true));

    // ── the lens unmounts and remounts: the store is module-level, so a fresh read IS the
    //    remount — nothing is written on unmount, nothing is lost between.
    docs = projectDocuments(project);
    expect(docs.tabs.map(t => t.key)).toEqual([
      tabKey("project", "a.ts"),
      tabKey("project", "b.ts"),
    ]);
    expect(docs.tabs[0].pinned).toBe(true);
    expect(docs.tabs[0].dirty).toBe(true); // the dirty dot followed the draft
    expect(docs.activeKey).toBe(tabKey("project", "a.ts"));
    const doc = docs.docs.get(tabKey("project", "a.ts"))!;
    expect(doc.draft).toBe("my edits");
    expect(doc.disk).toBe("original text");
    expect(doc.baseSignature).toBe("sig-a");
    expect(doc.loaded).toBe(true);
    // dirty is the draft-vs-disk comparison, recomputed on read — same truth after remount
    expect(doc.draft !== doc.disk).toBe(true);
  });

  it("drafts are per tab: typing in one never bleeds into the other", () => {
    const project = "per-tab";
    setTabs(project, openInTabs([], null, "project", "one.ts", "code").tabs);
    setTabs(project, togglePin(projectDocuments(project).tabs, tabKey("project", "one.ts")));
    const second = openInTabs(projectDocuments(project).tabs, tabKey("project", "one.ts"), "project", "two.ts", "code");
    setTabs(project, second.tabs);
    setActiveKey(project, second.activeKey);
    setDraft(project, tabKey("project", "one.ts"), "one's draft");
    setDraft(project, tabKey("project", "two.ts"), "two's draft");
    const docs = projectDocuments(project);
    expect(docs.docs.get(tabKey("project", "one.ts"))?.draft).toBe("one's draft");
    expect(docs.docs.get(tabKey("project", "two.ts"))?.draft).toBe("two's draft");
  });

  it("closing a tab drops its document; projects are isolated from each other", () => {
    const project = "close";
    setTabs(project, openInTabs([], null, "project", "gone.ts", "code").tabs);
    const key = tabKey("project", "gone.ts");
    setDraft(project, key, "unsaved");
    dropDocument(project, key);
    expect(projectDocuments(project).docs.has(key)).toBe(false);

    setDraft(project, key, "survivor");
    expect(projectDocuments("another-project").docs.size).toBe(0);
    expect(projectDocuments("close").docs.get(key)?.draft).toBe("survivor");
  });

  it("clearLoaded un-loads a tab — the loading-screen guard reads this", () => {
    const project = "loaded";
    setTabs(project, openInTabs([], null, "project", "x.ts", "code").tabs);
    const key = tabKey("project", "x.ts");
    markLoaded(project, key);
    expect(projectDocuments(project).docs.get(key)?.loaded).toBe(true);
    clearLoaded(project, key);
    expect(projectDocuments(project).docs.get(key)?.loaded).toBe(false);
  });
});

describe("keptDraft", () => {
  it("a document that never finished loading has no kept draft, even after a touch", async () => {
    const { setDisk, keptDraft, markLoaded, setDraft } = await import("./documents");
    setDisk("p", "k1", "disk text");
    expect(keptDraft("p", "k1")).toBeUndefined();
    setDraft("p", "k1", "typed");
    markLoaded("p", "k1");
    expect(keptDraft("p", "k1")?.draft).toBe("typed");
  });
});
