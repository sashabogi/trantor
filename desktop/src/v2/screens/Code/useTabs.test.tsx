// @vitest-environment happy-dom
// #14072: a dirty tab asks before it closes: the request holds the tab and shows the inline row
// state, confirming closes and discards the draft, cancelling keeps both. #14488: a discard also
// retires the persisted copy, so the drafts cache's IPC is mocked here too.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
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
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); draftDrop("trantor", null, "src/a.ts"); });

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

  // #14488: discarding the tab also retires the persisted copy, so a reopen starts from the disk.
  it("confirming a close retires the persisted draft with draft_forget", async () => {
    const forget: Array<{ project?: string; path?: string; seat?: string | null }> = [];
    mockIPC((command, args) => {
      // SAFETY: mockIPC types args as unknown; the draft commands are invoked with an object of named args.
      const named = (args ?? {}) as { project?: string; path?: string; seat?: string | null };
      if (command === "draft_forget") { forget.push(named); return null; }
      return null;
    });
    await mount();
    await click("open");
    await click("mark");
    draftKeep("trantor", null, "src/a.ts", "unsaved");
    await click("request-close");
    await click("confirm-close");
    // The baseline companion retires with the draft, so a reopen starts from the disk alone.
    expect(forget).toEqual([
      { project: "trantor", path: "src/a.ts", seat: null },
      { project: "trantor", path: "src/a.ts\u0000baseline", seat: null },
    ]);
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
