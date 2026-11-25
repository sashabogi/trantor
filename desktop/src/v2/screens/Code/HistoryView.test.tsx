// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { FileHistoryControl, HistoryView } from "./HistoryView";
import { toRow } from "./model";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const current = toRow({ sha: "aaa1111", author: "Tess", when: "1h", subject: "current" }, { seats: [], branch: "main" });
const branch = { sha: "bbb2222", author: "Kimi", when: "2h", subject: "branch work", refs: ["seat/kimi-9", "tag: v1"] };
let host: HTMLDivElement;
let root: Root;
type Args = { project?: string; scope?: string; all?: boolean; file?: string | null; message?: string | null };
let calls: { command: string; args: Args }[];

beforeEach(() => {
  calls = [];
  mockIPC((command, raw) => {
    // SAFETY: every mocked invoke uses this command's named argument object.
    calls.push({ command, args: (raw ?? {}) as Args });
    if (command === "git_history") return JSON.stringify([branch]);
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const click = async (target: Element | null | undefined) => {
  await act(async () => { target?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};
const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent === text);

async function mountHistory() {
  const onRows = vi.fn();
  await act(async () => {
    root.render(<HistoryView rows={[current]} branch="main" unlanded={null} selected={null} onSelect={() => undefined} seatBacked={false}
      project="trantor" scope={null} seats={[]} onRows={onRows} />);
  });
  await flush();
  return onRows;
}

it("loads all branches with branch and tag pills, then returns to the current rows", async () => {
  const onRows = await mountHistory();
  await click(button("All"));
  expect(calls[calls.length - 1]).toMatchObject({ command: "git_history", args: { project: "trantor", scope: "project", all: true, file: null, message: null } });
  expect(host.querySelector('[data-sha="bbb2222"]')?.textContent).toContain("seat/kimi-9");
  expect(host.querySelector('[data-sha="bbb2222"]')?.textContent).toContain("tag: v1");
  expect(onRows.mock.calls[onRows.mock.calls.length - 1]?.[0][0].sha).toBe("bbb2222");
  await click(button("Current branch"));
  expect(host.querySelector('[data-sha="aaa1111"]')?.textContent).toContain("current");
});

it("sends file: and message: to git instead of ignoring or subject-filtering them", async () => {
  await mountHistory();
  const input = host.querySelector<HTMLInputElement>("#v2-history-search");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "file:src/a.ts message:body");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
  expect(calls[calls.length - 1]).toMatchObject({ command: "git_history", args: { all: false, file: "src/a.ts", message: "body" } });
  expect(host.textContent).not.toContain("file: is ignored");
  expect(host.querySelector('[data-sha="bbb2222"]')?.textContent).toContain("branch work");
});

it("lists a file's commits from the reusable header control", async () => {
  await act(async () => { root.render(<FileHistoryControl project="trantor" scope={null} path="src/a.ts" />); });
  await click(host.querySelector('[aria-label="File history for src/a.ts"]'));
  expect(calls[calls.length - 1]).toMatchObject({ command: "git_history", args: { all: false, file: "src/a.ts" } });
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("branch work");
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("bbb2222".slice(0, 8));
});
