// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGitLog, recordGit } from "./gitLog";
import { isRoutineLine, MAX_OUTPUT_LINES, mergeOutputLines, Output, OUTPUT_CHANNEL_KEY, type OutputChannel, type OutputLogPage } from "./Output";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { channel: OutputChannel; offset: number | null };
let host: HTMLDivElement;
let root: Root;
let calls: Call[];
let respond: (call: Call) => OutputLogPage;

const page = (lines: string[], offset: number, extra?: Partial<OutputLogPage>): OutputLogPage => ({
  lines, offset, missing: false, reset: false, ...extra,
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const log = () => host.querySelector<HTMLElement>('[data-testid="output-log"]');
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

async function mount() {
  await act(async () => { root.render(<Output />); });
  await flush();
}

async function advance(ms = 1_000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await flush();
}

async function choose(value: OutputChannel) {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Output channel"]');
  await act(async () => {
    if (!select) return;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value); },
    removeItem: (key: string) => { mem.delete(key); },
    clear: () => mem.clear(), key: () => null, length: 0,
  });
  clearGitLog();
  mem.set(OUTPUT_CHANNEL_KEY, "app-trace");
  calls = [];
  respond = call => call.channel === "crashes" ? page(["panic"], 5) : call.offset === null ? page(["one"], 4) : page([], 4);
  mockIPC((command, args) => {
    if (command !== "output_log_read") return null;
    // SAFETY: mockIPC types args as unknown; output_log_read takes these two named arguments.
    const named = (args ?? {}) as Call;
    const call = { channel: named.channel, offset: named.offset };
    calls.push(call);
    return JSON.stringify(respond(call));
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  clearMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Output", () => {
  it("loads the trace tail and follows with the returned byte offset", async () => {
    respond = call => call.offset === null ? page(["one"], 4) : page(["two"], 8);
    await mount();
    expect(log()?.textContent).toContain("one");
    expect(calls).toEqual([{ channel: "app-trace", offset: null }]);
    await advance();
    expect(log()?.textContent).toContain("one");
    expect(log()?.textContent).toContain("two");
    expect(calls[1]).toEqual({ channel: "app-trace", offset: 4 });
  });

  it("remembers the channel and reloads when switching away and back", async () => {
    await mount();
    expect([...host.querySelectorAll("option")].map(option => option.textContent)).toEqual(["Git", "App trace", "App errors", "Crashes"]);
    await choose("crashes");
    expect(localStorage.getItem(OUTPUT_CHANNEL_KEY)).toBe("crashes");
    expect(log()?.textContent).toBe("panic");
    expect(calls[calls.length - 1]).toEqual({ channel: "crashes", offset: null });
    await choose("app-trace");
    expect(log()?.textContent).toBe("one");
    expect(calls[calls.length - 1]).toEqual({ channel: "app-trace", offset: null });
  });

  it("uses the missing-file empty state", async () => {
    respond = () => page([], 0, { missing: true });
    await mount();
    expect(host.textContent).toContain("Nothing has been written here yet.");
  });

  it("clear empties only the view and continues from the current offset", async () => {
    respond = call => call.offset === null ? page(["one"], 4) : page(["two"], 8);
    await mount();
    await act(async () => { button("Clear output")?.click(); });
    expect(log()?.textContent).toBe("");
    await advance();
    expect(log()?.textContent).toBe("two");
    expect(calls[1].offset).toBe(4);
  });

  it("stops following above the tail and jumps back on demand", async () => {
    respond = call => call.offset === null ? page(["one"], 4) : page(["two"], 8);
    await mount();
    const element = log();
    if (!element) throw new Error("output log not found");
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
    });
    element.scrollTop = 100;
    await act(async () => { element.dispatchEvent(new Event("scroll", { bubbles: true })); });
    expect(host.textContent).toContain("Jump to latest");
    await advance();
    expect(element.scrollTop).toBe(100);
    const jump = [...host.querySelectorAll("button")].find(item => item.textContent?.includes("Jump to latest"));
    await act(async () => { jump?.click(); });
    expect(element.scrollTop).toBe(500);
    expect(host.textContent).not.toContain("Jump to latest");
  });

  it("stops polling when the visible tab unmounts", async () => {
    await mount();
    await act(async () => { root.unmount(); });
    await advance(3_000);
    expect(calls).toHaveLength(1);
  });

  it("caps retained lines and replaces them after a native reset", () => {
    const current = Array.from({ length: 4_500 }, (_, index) => `old ${index}`);
    const incoming = Array.from({ length: 1_000 }, (_, index) => `new ${index}`);
    const merged = mergeOutputLines(current, page(incoming, 10));
    expect(merged).toHaveLength(MAX_OUTPUT_LINES);
    expect(merged[0]).toBe("old 500");
    expect(merged[merged.length - 1]).toBe("new 999");
    expect(mergeOutputLines(current, page(["fresh"], 5, { reset: true }))).toEqual(["fresh"]);
  });

  it("opens on the Git channel with the commands the Code screen ran, without polling the app log", async () => {
    localStorage.clear();
    recordGit("git stage a.txt", true, "first\nsecond\nthird\nfourth");
    recordGit("git push", false, "rejected");
    await mount();
    await advance(2_000);
    expect(calls).toHaveLength(0);
    const text = log()?.textContent ?? "";
    expect(text).toContain("git stage a.txt");
    expect(text).toContain("ok");
    expect(text).toContain("third");
    expect(text).not.toContain("fourth");
    expect(text).toContain("git push");
    expect(text).toContain("failed");
  });

  it("says so when no git command has run, then shows one as it arrives", async () => {
    localStorage.clear();
    await mount();
    expect(host.textContent).toContain("No git commands have run yet.");
    await act(async () => { recordGit("git fetch", true, ""); });
    expect(log()?.textContent).toContain("git fetch");
    await act(async () => { button("Clear output")?.click(); });
    expect(host.textContent).toContain("No git commands have run yet.");
  });

  it("hides the quiet tick and emit skipped lines in the app trace until asked", async () => {
    respond = () => page(["status: quiet tick pane=3", "real event", "emit skipped for x"], 9);
    await mount();
    expect(log()?.textContent).toBe("real event");
    const toggle = [...host.querySelectorAll("button")].find(item => item.textContent === "Show routine lines");
    await act(async () => { toggle?.click(); });
    expect(log()?.textContent).toContain("status: quiet tick pane=3");
    expect(isRoutineLine("emit skipped for x")).toBe(true);
    expect(isRoutineLine("real event")).toBe(false);
  });
});
