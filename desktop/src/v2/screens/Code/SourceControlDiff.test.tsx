// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SourceDetail } from "./SourceControlTab";
import type { ScopeSnapshot } from "./useScopeGit";

// SAFETY: #14268 React uses this test-only flag to flush asynchronous fixture updates.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const patch = (before: string, after: string) => `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
const staged = patch("base", "index");
const unstaged = patch("index", "working");
const snap: ScopeSnapshot = {
  scope: "codex-8", branch: "seat/codex-8", upstream: null, remote: null, ahead: 0, behind: 0,
  status: [{ path: "a.txt", x: "M", y: "M" }], counts: [{ path: "a.txt", plus: 1, minus: 1 }],
  log: [], seatBacked: true, readAt: 1,
};
type Args = { side?: "staged" | "unstaged"; action?: string; patch?: string; project?: string; seat?: string; path?: string };
let host: HTMLDivElement;
let root: Root;
let calls: { command: string; args: Args }[];
let patches = { staged, unstaged };
let afterApply: () => void;
const mutated = vi.fn();

beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); }, clear: () => memory.clear(), length: 0, key: () => null,
  });
  patches = { staged, unstaged };
  calls = [];
  afterApply = () => {};
  mutated.mockClear();
  mockIPC((command, payload) => {
    // SAFETY: #14268 the mocked git commands pass named arguments with this shape.
    const args = (payload ?? {}) as Args;
    calls.push({ command, args });
    if (command === "file_diff") return args.side ? patches[args.side] : patch("base", "working");
    if (command === "git_apply_patch") { afterApply(); return ""; }
    return null;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const mount = async () => {
  await act(async () => {
    root.render(<SourceDetail project="trantor" snap={snap} view="changes" cards={[]} chips={[{ path: "a.txt", letter: "M", plus: 1, minus: 1 }]}
      selected="a.txt" onPick={() => {}} historyRows={[]} selectedKey={null} onSelectKey={() => {}}
      acts={{ addToChat: () => {}, copy: () => {}, branchRefusal: null }} onNavigate={() => {}} onMutated={mutated} onError={() => {}} onOpenFile={() => {}} />);
  });
  await flush();
};
const section = (name: string) => host.querySelector(`[role="group"][aria-label="${name}"]`)!;
const buttons = (element: Element) => [...element.querySelectorAll("button")].map(button => button.textContent).filter(text => /^(Stage|Unstage|Discard) /.test(text ?? ""));
const button = (name: string) => [...host.querySelectorAll("button")].find(button => button.textContent === name)!;
const click = async (element: Element) => {
  expect(element).toBeTruthy();
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};

describe("Source control diff sides", () => {
  it.each(["Combined", "Side by side"])("renders independent sections, actions and line selections in %s", async layout => {
    await mount();
    if (layout === "Side by side") await click(button(layout));
    expect([...host.querySelectorAll("h3")].map(heading => heading.textContent)).toEqual(["Staged", "Changes"]);
    expect(host.querySelectorAll('section[aria-label="Diff of a.txt"]')).toHaveLength(1);
    expect(section("Staged").textContent).toContain("base");
    expect(section("Staged").textContent).not.toContain("working");
    expect(section("Changes").textContent).toContain("working");
    expect(section("Changes").textContent).not.toContain("base");
    expect(buttons(section("Staged"))).toEqual(["Unstage hunk"]);
    expect(buttons(section("Changes"))).toEqual(["Stage hunk", "Discard hunk"]);
    await click(section("Staged").querySelector('[data-line-index="1"]')!);
    expect(buttons(section("Staged"))).toEqual(["Unstage 1 line"]);
    expect(buttons(section("Changes"))).toEqual(["Stage hunk", "Discard hunk"]);
    await click(section("Changes").querySelector('[data-line-index="1"]')!);
    expect(buttons(section("Staged"))).toEqual(["Unstage 1 line"]);
    expect(buttons(section("Changes"))).toEqual(["Stage 1 line", "Discard 1 line"]);
    await click(button("Stage 1 line"));
    const applied = calls.find(call => call.command === "git_apply_patch")?.args;
    expect(applied?.action).toBe("stage");
    expect(applied?.patch).toContain("+working");
    expect(applied?.patch).not.toContain("base");
  });

  it.each(["stage", "unstage"])("re-reads both sides after %s even when the status snapshot stays the same", async action => {
    await mount();
    afterApply = () => { patches = action === "stage" ? { staged: patch("base", "working"), unstaged: "" } : { staged: "", unstaged: patch("base", "working") }; };
    await click(button(action === "stage" ? "Stage hunk" : "Unstage hunk"));
    const reads = calls.filter(call => call.command === "file_diff");
    expect(reads.map(call => call.args.side)).toEqual(["staged", "unstaged", "staged", "unstaged"]);
    expect(reads.every(call => call.args.project === "trantor" && call.args.seat === "codex-8" && call.args.path === "a.txt")).toBe(true);
    expect(mutated).toHaveBeenCalledOnce();
    expect(calls.find(call => call.command === "git_apply_patch")?.args.patch).toBe(action === "stage" ? unstaged : staged);
    expect(host.querySelector("h3")).toBeNull();
    expect(buttons(host)).toEqual(action === "stage" ? ["Unstage hunk"] : ["Stage hunk", "Discard hunk"]);
  });
});
