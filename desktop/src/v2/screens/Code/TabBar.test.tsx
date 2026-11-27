// @vitest-environment happy-dom
// #14072: a dirty tab shows the dot (title and aria-label "Unsaved changes"); closing a dirty tab
// asks in an inline row under the strip with Discard/Keep, and the X asks the owner first.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCE_TAB, TabBar, type CodeTab } from "./TabBar";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_TAB: CodeTab = { id: "file::src/a.ts", kind: "file", label: "a.ts", scope: null, path: "src/a.ts" };
const TABS: CodeTab[] = [SOURCE_TAB, FILE_TAB];

type Over = { dirty?: ReadonlySet<string>; confirmId?: string | null };

let host: HTMLDivElement;
let root: Root;
let onRequestClose: ReturnType<typeof vi.fn>;
let onConfirmClose: ReturnType<typeof vi.fn>;
let onCancelClose: ReturnType<typeof vi.fn>;
let onActivate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  onRequestClose = vi.fn();
  onConfirmClose = vi.fn();
  onCancelClose = vi.fn();
  onActivate = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
const render = async (over: Over = {}) => {
  await act(async () => {
    root.render(<TabBar tabs={TABS} activeId={FILE_TAB.id}
      dirty={over.dirty ?? new Set<string>()} confirmId={over.confirmId ?? null}
      onActivate={onActivate} onRequestClose={onRequestClose} onConfirmClose={onConfirmClose} onCancelClose={onCancelClose}
      onNew={() => undefined} />);
  });
  await flush();
};
const click = async (sel: string) => { await act(async () => { host.querySelector<HTMLElement>(sel)?.click(); }); await flush(); };
const buttonText = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text);

describe("TabBar dirty dot (#14072)", () => {
  it("shows a dot titled and labelled Unsaved changes on a dirty tab, and none on a clean strip", async () => {
    await render({ dirty: new Set([FILE_TAB.id]) });
    const dot = host.querySelector('[title="Unsaved changes"]');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("aria-label")).toBe("Unsaved changes");
    expect(dot?.closest('[role="tab"]')?.textContent ?? "").toContain("a.ts");
    await render({ dirty: new Set<string>() });
    expect(host.querySelector('[title="Unsaved changes"]')).toBeNull();
  });

  it("the dot rides a clickable tab, and the Source control tab never closes", async () => {
    await render({ dirty: new Set([FILE_TAB.id]) });
    await click('[role="tab"][aria-selected="true"]');
    expect(onActivate).toHaveBeenCalledWith(FILE_TAB.id);
    expect(host.querySelector('button[aria-label="Close Source control"]')).toBeNull();
  });
});

describe("TabBar close confirm row (#14072)", () => {
  it("the X asks the owner; the row appears only once the owner holds the tab", async () => {
    await render();
    await click('button[aria-label="Close a.ts"]');
    expect(onRequestClose).toHaveBeenCalledWith(FILE_TAB.id);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await render({ confirmId: FILE_TAB.id });
    const row = host.querySelector('[role="alert"]');
    expect(row?.textContent ?? "").toContain("src/a.ts has unsaved changes");
    expect(row?.textContent ?? "").toContain("Closing it discards them");
  });

  it("Discard and close confirms, Keep open cancels", async () => {
    await render({ confirmId: FILE_TAB.id });
    await act(async () => { buttonText("Discard and close")?.click(); });
    expect(onConfirmClose).toHaveBeenCalledTimes(1);
    await act(async () => { buttonText("Keep open")?.click(); });
    expect(onCancelClose).toHaveBeenCalledTimes(1);
  });
});

describe("TabBar unsaved question (#14268)", () => {
  it("Escape keeps the tab open", async () => {
    await render({ confirmId: FILE_TAB.id });
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onCancelClose).toHaveBeenCalledTimes(1);
  });
});

describe("the scattered controls are gone (#14512)", () => {
  it("no PanelLeftOpen lead button: the top bar's left toggle brings the sidebar back", async () => {
    await render();
    expect(host.querySelector('button[aria-label="Show the source control sidebar"]')).toBeNull();
  });
});
