// @vitest-environment happy-dom
// #14072: a dirty tab asks before it closes: the request holds the tab and shows the inline row
// state, confirming closes and discards the draft, cancelling keeps both. No IPC: the tabs model
// is pure state plus the drafts cache.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftDrop, draftFor, draftKeep } from "./drafts";
import { useTabs } from "./useTabs";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_TAB = { id: "file::src/a.ts", kind: "file" as const, label: "a.ts", scope: null, path: "src/a.ts" };

function TabsHarness() {
  const t = useTabs("trantor");
  return (
    <div>
      <span data-tabs={t.tabs.map(x => x.id).join(",")} />
      <span data-confirm={t.confirmId ?? ""} />
      <span data-dirty={[...t.dirty].join(",")} />
      <button type="button" onClick={() => t.open(FILE_TAB)}>open</button>
      <button type="button" onClick={() => t.markDirty(FILE_TAB.id, true)}>mark</button>
      <button type="button" onClick={() => t.markDirty(FILE_TAB.id, false)}>unmark</button>
      <button type="button" onClick={() => t.requestClose(FILE_TAB.id)}>request-close</button>
      <button type="button" onClick={() => t.confirmClose()}>confirm-close</button>
      <button type="button" onClick={() => t.cancelClose()}>cancel-close</button>
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); draftDrop("trantor", null, "src/a.ts"); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
const mount = async () => { await act(async () => { root.render(<TabsHarness />); }); await flush(); };
const click = async (text: string) => { await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === text)?.click(); }); await flush(); };
const attr = (name: string) => host.querySelector(`[data-${name}]`)?.getAttribute(`data-${name}`) ?? "";

describe("useTabs close with unsaved work (#14072)", () => {
  it("a clean tab closes at once", async () => {
    await mount();
    await click("open");
    expect(attr("tabs")).toContain("file::src/a.ts");
    await click("request-close");
    expect(attr("tabs")).toBe("source");
    expect(attr("confirm")).toBe("");
  });

  it("a dirty tab holds for the confirm row and keeps its draft", async () => {
    await mount();
    await click("open");
    await click("mark");
    draftKeep("trantor", null, "src/a.ts", "unsaved");
    await click("request-close");
    expect(attr("tabs")).toContain("file::src/a.ts");
    expect(attr("confirm")).toBe("file::src/a.ts");
    expect(draftFor("trantor", null, "src/a.ts")).toBe("unsaved");
  });

  it("confirming closes the tab, clears the dirty mark and discards the draft", async () => {
    await mount();
    await click("open");
    await click("mark");
    draftKeep("trantor", null, "src/a.ts", "unsaved");
    await click("request-close");
    await click("confirm-close");
    expect(attr("tabs")).toBe("source");
    expect(attr("confirm")).toBe("");
    expect(attr("dirty")).toBe("");
    expect(draftFor("trantor", null, "src/a.ts")).toBeNull();
  });

  it("cancelling keeps the tab and the draft, and asking again re-asks", async () => {
    await mount();
    await click("open");
    await click("mark");
    draftKeep("trantor", null, "src/a.ts", "unsaved");
    await click("request-close");
    await click("cancel-close");
    expect(attr("tabs")).toContain("file::src/a.ts");
    expect(attr("confirm")).toBe("");
    expect(draftFor("trantor", null, "src/a.ts")).toBe("unsaved");
    await click("request-close");
    expect(attr("confirm")).toBe("file::src/a.ts");
  });

  it("a save that clears the dirty mark lets the tab close without asking", async () => {
    await mount();
    await click("open");
    await click("mark");
    await click("unmark");
    await click("request-close");
    expect(attr("tabs")).toBe("source");
  });
});
