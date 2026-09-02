// The round-trip contract (#5938): editor state outlives the lens. Open two tabs, type in one,
// let the surface unmount (which touches NOTHING in the store), come back — same tabs, same
// draft, same dirty dot. The store composes the pure helpers; those stay tested where they live.
import { describe, expect, it } from "vitest";
import {
  clearLoaded,
  dropDocument,
  keptDraft,
  markLoaded,
  projectDocuments,
  setBaseSignature,
  setDisk,
  setDraft,
  setActiveKey,
  setTabs,
  storedDraft,
  canStashDraft,
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

describe("project switch (#6104)", () => {
  it("work in one project survives a switch away and back; projects never see each other", () => {
    // Project A: a pinned tab with a dirty draft — the operator's mid-edit state.
    const A = "switch-a";
    const aOpen = openInTabs([], null, "project", "src/a.ts", "code");
    setTabs(A, togglePin(aOpen.tabs, tabKey("project", "src/a.ts")));
    setActiveKey(A, tabKey("project", "src/a.ts"));
    const aKey = tabKey("project", "src/a.ts");
    setDisk(A, aKey, "const a = 1;");
    setBaseSignature(A, aKey, "sig-a");
    markLoaded(A, aKey);
    setDraft(A, aKey, "const a = 2; // edited");
    setTabs(A, markDirty(projectDocuments(A).tabs, aKey, true));

    // The operator switches to project B and edits there too.
    const B = "switch-b";
    const bOpen = openInTabs([], null, "project", "src/b.ts", "code");
    setTabs(B, bOpen.tabs);
    setActiveKey(B, bOpen.activeKey);
    const bKey = tabKey("project", "src/b.ts");
    setDraft(B, bKey, "b's draft");

    // Back to A: everything is exactly where it was left — tabs, activation, draft, dirty.
    const docsA = projectDocuments(A);
    expect(docsA.tabs.map(t => t.key)).toEqual([aKey]);
    expect(docsA.tabs[0].pinned).toBe(true);
    expect(docsA.tabs[0].dirty).toBe(true);
    expect(docsA.activeKey).toBe(aKey);
    expect(docsA.docs.get(aKey)?.draft).toBe("const a = 2; // edited");
    expect(keptDraft(A, aKey)?.draft).toBe("const a = 2; // edited");
    // …and B's state is its own.
    const docsB = projectDocuments(B);
    expect(docsB.docs.get(bKey)?.draft).toBe("b's draft");
    expect(docsB.docs.has(aKey)).toBe(false);

    // The switch never leaked in either direction: the same PATH in two projects is two
    // documents — storedDraft answers per project.
    expect(storedDraft(A, null, "src/b.ts")).toBeNull();
    expect(storedDraft(B, null, "src/a.ts")).toBeNull();
  });
});

describe("canStashDraft (#5938)", () => {
  it("refuses a stash before the view hydrated its draft from the active document", () => {
    // the remount order: openPath stashes before the load effect hydrates
    expect(canStashDraft({ activeKey: "project:a.rs", loaded: true, hydratedKey: null })).toBe(false);
    expect(canStashDraft({ activeKey: "project:a.rs", loaded: true, hydratedKey: "project:b.rs" })).toBe(false);
  });
  it("refuses a stash for a document that never finished loading", () => {
    expect(canStashDraft({ activeKey: "project:a.rs", loaded: false, hydratedKey: "project:a.rs" })).toBe(false);
  });
  it("allows the stash once the active document is loaded and hydrated", () => {
    expect(canStashDraft({ activeKey: "project:a.rs", loaded: true, hydratedKey: "project:a.rs" })).toBe(true);
    expect(canStashDraft({ activeKey: null, loaded: true, hydratedKey: null })).toBe(false);
  });
});
