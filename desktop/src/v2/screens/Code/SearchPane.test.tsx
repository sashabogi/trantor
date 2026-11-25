// @vitest-environment happy-dom
// #14074: the Search view's Text mode, grouped by file, with the native command mocked at the IPC edge.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SearchPane } from "./SearchPane";
import type { TextSearchResult } from "./textSearch";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESULT: TextSearchResult = {
  total: 3, truncated: false,
  files: [
    { path: "src/a.ts", matches: [{ line: 4, column: 7, text: "  let Needle = 1;" }, { line: 9, column: 1, text: "needle()" }] },
    { path: "docs/b.md", matches: [{ line: 2, column: 3, text: "a needle" }] },
  ],
};

let host: HTMLDivElement;
let root: Root;
let answer: (query: string) => Promise<string>;
let queries: string[];
const onOpen = vi.fn();

function need<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("element not found");
  return v;
}
const pane = () => need(host.querySelector("input"));
const byTitle = (title: string) => need([...host.querySelectorAll("button")].find(b => b.getAttribute("title") === title));
async function type(value: string) {
  const input = pane();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

beforeEach(() => {
  vi.useFakeTimers();
  queries = [];
  onOpen.mockReset();
  answer = async () => JSON.stringify(RESULT);
  mockIPC((command, args) => {
    // SAFETY: mockIPC types args as unknown; search_text is invoked with named args.
    const named = (args ?? {}) as { query?: string };
    if (command === "search_text") { queries.push(named.query ?? ""); return answer(named.query ?? ""); }
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => { root.render(<SearchPane project="trantor" scope={null} onOpen={onOpen} />); });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearMocks();
  vi.useRealTimers();
});

describe("SearchPane text mode", () => {
  it("is the default mode, with a labelled input", () => {
    expect(host.querySelector("label[for=v2-text-search]")?.textContent).toBe("Search text");
    expect(pane().placeholder).toBe("Search in files");
  });

  it("groups matches by file, counts them and highlights the match", async () => {
    await type("needle");
    expect(host.textContent).toContain("3 results in 2 files");
    expect(host.textContent).toContain("src/a.ts");
    expect(host.textContent).toContain("docs/b.md");
    const marks = [...host.querySelectorAll("mark")].map(m => m.textContent);
    expect(marks).toEqual(["Needle", "needle", "needle"]);
  });

  it("shows a line cut before the match without a mark", async () => {
    const cut = { files: [{ path: "w.txt", matches: [{ line: 1, column: 900, text: "x".repeat(400) }] }], total: 1, truncated: false };
    answer = async () => JSON.stringify(cut);
    await type("needle");
    expect(host.querySelectorAll("mark").length).toBe(0);
    expect(host.textContent).toContain("x".repeat(400));
  });

  it("collapses a file", async () => {
    await type("needle");
    const header = byTitle("docs/b.md");
    await act(async () => { header.click(); });
    expect(host.textContent).not.toContain("a needle");
  });

  it("opens the file at the clicked line", async () => {
    await type("needle");
    const row = byTitle("src/a.ts:9");
    await act(async () => { row.click(); });
    expect(onOpen).toHaveBeenCalledWith("src/a.ts", 9, 1);
  });

  it("says when the first 2,000 results were cut", async () => {
    answer = async () => JSON.stringify({ ...RESULT, truncated: true });
    await type("needle");
    expect(host.textContent).toContain("Showing the first 2,000 results");
  });

  it("shows the empty state", async () => {
    answer = async () => JSON.stringify({ files: [], total: 0, truncated: false });
    await type("zzz");
    expect(host.textContent).toContain("No results.");
  });

  it("shows an error as an alert", async () => {
    answer = async () => { throw "fatal: not a git repository"; };
    await type("needle");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("not a git repository");
  });

  it("does not search an empty query", async () => {
    await type("   ");
    expect(queries).toEqual([]);
  });

  it("debounces typing into one search and ignores a stale answer", async () => {
    let release: (v: string) => void = () => undefined;
    answer = q => q === "slow"
      ? new Promise<string>(r => { release = r; })
      : Promise.resolve(JSON.stringify({ files: [{ path: "fresh.ts", matches: [{ line: 1, column: 1, text: "fast" }] }], total: 1, truncated: false }));
    await type("slow");
    await type("fast");
    await act(async () => { release(JSON.stringify(RESULT)); });
    expect(queries).toEqual(["slow", "fast"]);
    expect(host.textContent).toContain("fresh.ts");
    expect(host.textContent).not.toContain("src/a.ts");
  });

  it("sends the case option when the toggle is pressed", async () => {
    const toggle = need(host.querySelector<HTMLButtonElement>("button[aria-label='Match case']"));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});
