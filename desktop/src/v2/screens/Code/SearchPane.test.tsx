// @vitest-environment happy-dom
// #14074: the Search view's Text mode, grouped by file, with the native command mocked at the IPC edge.
// #14104: the option toggles, the glob boxes, and replace with a count-then-confirm step.
// #14237: the match toggles sit inside the search field, the glob toggle on the replace row.
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
    { path: "src/a.ts", mtimeMs: 1000, bytes: 50, matches: [{ line: 4, column: 7, text: "  let Needle = 1;" }, { line: 9, column: 1, text: "needle()" }] },
    { path: "docs/b.md", mtimeMs: 2000, bytes: 60, matches: [{ line: 2, column: 3, text: "a needle" }] },
  ],
};

// SAFETY: mockIPC types args as unknown; both commands are invoked with named args.
type SearchCall = { query?: string; regex?: boolean; wholeWord?: boolean; caseSensitive?: boolean; include?: string; exclude?: string };
type ReplaceCall = { path?: string; query?: string; replacement?: string; only?: { line: number; column: number } | null; mtimeMs?: number; bytes?: number };

let host: HTMLDivElement;
let root: Root;
let answer: (query: string) => Promise<string>;
let replaceAnswer: (path: string) => Promise<string>;
let searchCalls: SearchCall[];
let replaceCalls: ReplaceCall[];
const onOpen = vi.fn();
const onMutated = vi.fn();

function need<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("element not found");
  return v;
}
const pane = () => need(host.querySelector("input"));
const lastSearch = () => searchCalls[searchCalls.length - 1];
const replaceBox = () => need(host.querySelector<HTMLInputElement>("#v2-text-replace"));
const byTitle = (title: string) => need([...host.querySelectorAll("button")].find(b => b.getAttribute("title") === title));
async function type(value: string) {
  const input = pane();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}
async function typeIn(box: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

beforeEach(() => {
  vi.useFakeTimers();
  searchCalls = [];
  replaceCalls = [];
  onOpen.mockReset();
  onMutated.mockReset();
  answer = async () => JSON.stringify(RESULT);
  replaceAnswer = async () => JSON.stringify({ replaced: 1 });
  mockIPC((command, args) => {
    // SAFETY: mockIPC types args as unknown; both commands are invoked with an object of named args.
    const named = (args ?? {}) as SearchCall & ReplaceCall;
    if (command === "search_text") { searchCalls.push(named); return answer(named.query ?? ""); }
    if (command === "replace_text") { replaceCalls.push(named); return replaceAnswer(named.path ?? ""); }
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => { root.render(<SearchPane project="trantor" scope={null} onOpen={onOpen} onMutated={onMutated} />); });
});
afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
  clearMocks();
  vi.useRealTimers();
});

describe("SearchPane text mode", () => {
  it("is the default mode, with a labelled input", () => {
    expect(host.querySelector("label[for=v2-text-search]")?.textContent).toBe("Search text");
    expect(pane().placeholder).toBe("Search in files");
  });

  it("holds the match toggles inside the search field and the glob toggle on the replace row", () => {
    const field = need(need(host.querySelector<HTMLInputElement>("#v2-text-search")).parentElement);
    expect(field.className).toContain("rounded-lg");
    for (const label of ["Match case", "Regular expression", "Whole word"]) {
      expect(field.querySelector(`button[aria-label='${label}']`)).not.toBeNull();
    }
    expect(field.querySelector("button[aria-label='Files to include and exclude']")).toBeNull();
    const replaceRow = need(need(host.querySelector<HTMLInputElement>("#v2-text-replace")).parentElement);
    expect(replaceRow.querySelector("button[aria-label='Files to include and exclude']")).not.toBeNull();
    expect(replaceRow.querySelector("button[aria-label='Replace all']")).not.toBeNull();
  });

  it("groups matches by file, counts them and highlights the match", async () => {
    await type("needle");
    expect(host.textContent).toContain("3 results in 2 files");
    expect(host.textContent).toContain("src/a.ts");
    expect(host.textContent).toContain("docs/b.md");
    const marks = [...host.querySelectorAll("mark")].map(m => m.textContent);
    expect(marks).toEqual(["Needle", "needle", "needle"]);
  });

  it("highlights the span the native side reports, not the query's length", async () => {
    answer = async () => JSON.stringify({ ...RESULT, files: [{ ...RESULT.files[0], matches: [{ line: 1, column: 3, text: "a foooo", markLen: 3 }] }] });
    await type("foo+");
    const mark = need(host.querySelector("mark"));
    expect(mark.textContent).toBe("foo");
  });

  it("shows a line cut before the match without a mark", async () => {
    const cut = { files: [{ path: "w.txt", mtimeMs: 1, bytes: 2, matches: [{ line: 1, column: 900, text: "x".repeat(400) }] }], total: 1, truncated: false };
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
    expect(searchCalls).toEqual([]);
  });

  it("debounces typing into one search and ignores a stale answer", async () => {
    let release: (v: string) => void = () => undefined;
    answer = q => q === "slow"
      ? new Promise<string>(r => { release = r; })
      : Promise.resolve(JSON.stringify({ files: [{ path: "fresh.ts", mtimeMs: 1, bytes: 1, matches: [{ line: 1, column: 1, text: "fast" }] }], total: 1, truncated: false }));
    await type("slow");
    await type("fast");
    await act(async () => { release(JSON.stringify(RESULT)); });
    expect(searchCalls.map(c => c.query)).toEqual(["slow", "fast"]);
    expect(host.textContent).toContain("fresh.ts");
    expect(host.textContent).not.toContain("src/a.ts");
  });

  it("sends the case option when the toggle is pressed", async () => {
    const toggle = need(host.querySelector<HTMLButtonElement>("button[aria-label='Match case']"));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await type("needle");
    expect(lastSearch()?.caseSensitive).toBe(true);
  });

  it("sends the regular expression and whole word options when their toggles are pressed", async () => {
    const re = need(host.querySelector<HTMLButtonElement>("button[aria-label='Regular expression']"));
    const word = need(host.querySelector<HTMLButtonElement>("button[aria-label='Whole word']"));
    await act(async () => { re.click(); });
    await act(async () => { word.click(); });
    expect(re.getAttribute("aria-pressed")).toBe("true");
    expect(word.getAttribute("aria-pressed")).toBe("true");
    expect(pane().placeholder).toContain("regular expression");
    await type("needle");
    expect(lastSearch()?.regex).toBe(true);
    expect(lastSearch()?.wholeWord).toBe(true);
  });

  it("shows an invalid expression under the box and runs nothing", async () => {
    const re = need(host.querySelector<HTMLButtonElement>("button[aria-label='Regular expression']"));
    await act(async () => { re.click(); });
    await type("needl(");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Invalid regular expression");
    expect(searchCalls).toEqual([]);
  });

  it("shows the include and exclude boxes behind the toggle and sends the globs", async () => {
    await type("needle");
    const toggle = need(host.querySelector<HTMLButtonElement>("button[aria-label='Files to include and exclude']"));
    expect(host.querySelector("#v2-search-include")).toBeNull();
    await act(async () => { toggle.click(); });
    const include = need(host.querySelector<HTMLInputElement>("#v2-search-include"));
    const exclude = need(host.querySelector<HTMLInputElement>("#v2-search-exclude"));
    await typeIn(include, "*.ts");
    await typeIn(exclude, "*.md, dist");
    expect(lastSearch()?.include).toBe("*.ts");
    expect(lastSearch()?.exclude).toBe("*.md, dist");
  });

  it("hides the replace-all button's action until there are results", async () => {
    const all = need(host.querySelector<HTMLButtonElement>("button[aria-label='Replace all']"));
    expect(all.disabled).toBe(true);
    await type("needle");
    expect(all.disabled).toBe(false);
  });
});

describe("SearchPane replace", () => {
  it("replaces one result: says what it will do, waits for the confirm, then replaces at the match", async () => {
    await type("needle");
    await typeIn(replaceBox(), "pin");
    const row = byTitle("Replace this result in src/a.ts");
    await act(async () => { row.click(); });
    expect(replaceCalls).toEqual([]);
    expect(host.textContent).toContain("Replace 1 result in src/a.ts");
    await act(async () => { byTitle("src/a.ts").click(); });  // confirming is not collapsing
    await act(async () => { need([...host.querySelectorAll("button")].find(b => b.textContent === "Replace")).click(); });
    expect(replaceCalls.length).toBe(1);
    expect(replaceCalls[0].path).toBe("src/a.ts");
    expect(replaceCalls[0].query).toBe("needle");
    expect(replaceCalls[0].replacement).toBe("pin");
    expect(replaceCalls[0].only).toEqual({ line: 4, column: 7 });
    expect(replaceCalls[0].mtimeMs).toBe(1000);
    expect(replaceCalls[0].bytes).toBe(50);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(searchCalls.length).toBe(2);
    expect(onMutated).toHaveBeenCalled();
  });

  it("replaces all in one file with the file's count in the preview", async () => {
    await type("needle");
    await typeIn(replaceBox(), "pin");
    await act(async () => { byTitle("Replace all in docs/b.md").click(); });
    expect(host.textContent).toContain("Replace 1 result in docs/b.md");
    await act(async () => { need([...host.querySelectorAll("button")].find(b => b.textContent === "Replace")).click(); });
    expect(replaceCalls.map(c => c.path)).toEqual(["docs/b.md"]);
    expect(replaceCalls[0].only).toBeNull();
  });

  it("replaces all across files with the total in the preview", async () => {
    await type("needle");
    await typeIn(replaceBox(), "pin");
    await act(async () => { need(host.querySelector<HTMLButtonElement>("button[aria-label='Replace all']")).click(); });
    expect(host.textContent).toContain("Replace 3 results in 2 files");
    await act(async () => { need([...host.querySelectorAll("button")].find(b => b.textContent === "Replace")).click(); });
    expect(replaceCalls.map(c => c.path)).toEqual(["src/a.ts", "docs/b.md"]);
    expect(onMutated).toHaveBeenCalled();
  });

  it("cancel dismisses the confirmation without replacing", async () => {
    await type("needle");
    await act(async () => { need(host.querySelector<HTMLButtonElement>("button[aria-label='Replace all']")).click(); });
    await act(async () => { need([...host.querySelectorAll("button")].find(b => b.textContent === "Cancel")).click(); });
    expect(replaceCalls).toEqual([]);
    expect(host.textContent).not.toContain("Replace 3 results");
  });

  it("reports what a replace did and refreshes the results", async () => {
    replaceAnswer = async () => JSON.stringify({ replaced: 2 });
    await type("needle");
    await typeIn(replaceBox(), "pin");
    await act(async () => { need(host.querySelector<HTMLButtonElement>("button[aria-label='Replace all']")).click(); });
    await act(async () => { need([...host.querySelectorAll("button")].find(b => b.textContent === "Replace")).click(); });
    expect(host.textContent).toContain("Replaced 4 results in 2 files");
  });

  it("surfaces the changed-file refusal as an alert", async () => {
    replaceAnswer = async () => { throw "src/a.ts changed since the search ran; search again and replace from the fresh results"; };
    await type("needle");
    await act(async () => { need(host.querySelector<HTMLButtonElement>("button[aria-label='Replace all']")).click(); });
    await act(async () => { need([...host.querySelectorAll("button")].find(b => b.textContent === "Replace")).click(); });
    expect(host.textContent).toContain("changed since the search ran");
  });

  it("drops a pending confirmation when the query changes", async () => {
    await type("needle");
    await act(async () => { need(host.querySelector<HTMLButtonElement>("button[aria-label='Replace all']")).click(); });
    expect(host.textContent).toContain("Replace 3 results");
    await type("other");
    expect(host.textContent).not.toContain("Replace 3 results");
  });
});
