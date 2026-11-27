// @vitest-environment happy-dom
// #14022: the orchestrator composer's Mode menu reads the live mode off the pane and switches it through
// the native closed loop. Fakes sit only at the Tauri IPC boundary.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { AgentCliCompatibility } from "../../../shared/api/client";
import { draftSlots } from "../../../features/chat/composerDraft";
import { ComposerAdapter } from "./ComposerAdapter";
import { MODE_READ_RETRY_MS, MODE_READ_WINDOW_MS } from "./useAgentMode";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { mode: string; prompt_showing?: boolean; seen?: string[] } | Promise<never> | AgentCliCompatibility[] | null;
type Calls = Array<{ cmd: string; args?: InvokeArgs }>;
type Reply = (cmd: string, args?: InvokeArgs) => Answer | undefined;

let host: HTMLDivElement;
let root: Root;
let calls: Calls;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); calls = []; draftSlots.reset(); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearMocks(); vi.useRealTimers(); });

function ipc(reply: Reply) {
  mockIPC((cmd, args) => { calls.push({ cmd, args }); return reply(cmd, args); });
}
const claudeAt = (mode: string, onSet?: Reply): Reply => (cmd, args) => {
  if (cmd === "pane_mode_get") return { mode, prompt_showing: false };
  if (cmd === "pane_mode_set") return onSet?.(cmd, args);
  return null;
};

const props = (over: Partial<ComponentProps<typeof ComposerAdapter>> = {}): ComponentProps<typeof ComposerAdapter> => ({
  project: "trantor", target: "w4:p1", live: true, liveWhy: "", model: "claude-opus-5-5", modelSource: "reported",
  working: false, userTexts: [], context: { tokens: null, window: 200000, frac: null }, fontStep: "m",
  onFontStep: () => {}, onSent: () => {}, onLongRunChange: () => {}, onDispatch: () => {}, ...over,
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
async function mount(over?: Partial<ComponentProps<typeof ComposerAdapter>>) {
  await act(async () => { root.render(<ComposerAdapter {...props(over)} />); });
  await flush();
}
const chip = () => host.querySelector<HTMLButtonElement>('[data-group="agent"] button');
const rows = () => [...host.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')];
const headings = () => [...host.querySelectorAll('[role="menu"] div')].map(d => d.textContent);
const open = () => act(async () => { chip()?.click(); });
const pick = (label: string) => act(async () => { rows().find(r => r.textContent?.startsWith(label))?.click(); });

describe("ComposerAdapter mode menu", () => {
  it("floats the composer without a separator and follows Chat's working state", async () => {
    ipc(claudeAt("default"));
    await mount({ working: true });
    expect(host.querySelector(".v2-composer-float")?.className).not.toContain("border-t");
    expect(host.querySelector(".v2-composer-float .v2-sweep")).not.toBeNull();
    await mount({ working: false });
    expect(host.querySelector(".v2-sweep")).toBeNull();
  });

  it("sends a clicked suggestion pill through pane_send once and tells Chat it was handled", async () => {
    ipc(claudeAt("default"));
    const handled: string[] = [];
    await mount({ suggestion: "yes", onSuggestionHandled: () => { handled.push("handled"); } });
    const sends = calls.filter(c => c.cmd === "pane_send");
    expect(sends.map(c => c.args)).toEqual([{ target: "w4:p1", text: "yes" }]);
    expect(handled).toEqual(["handled"]);
  });

  it("does not send a suggestion when there is no live pane", async () => {
    ipc(claudeAt("default"));
    const handled: string[] = [];
    await mount({ suggestion: "yes", live: false, liveWhy: "not hosted", onSuggestionHandled: () => { handled.push("handled"); } });
    expect(calls.some(c => c.cmd === "pane_send")).toBe(false);
    expect(handled).toEqual([]);
  });

  it("shows the read mode and offers only the modes every session has, above the relabelled launch section", async () => {
    ipc(claudeAt("default"));
    await mount();
    expect(chip()?.getAttribute("aria-label")).toBe("orchestrator, mode: Agent, permission: Ask me");
    const readsBeforeOpen = calls.filter(c => c.cmd === "pane_mode_get").length;
    await open();
    expect(calls.filter(c => c.cmd === "pane_mode_get").length).toBe(readsBeforeOpen + 1);
    expect(rows().map(r => r.querySelector("span span")?.textContent)).toEqual(
      ["Agent", "Agent, accept edits", "Plan", "Ask me", "Full auto"]);
    expect(headings()).toContain("For new sessions and handoffs");
    expect(calls.filter(c => c.cmd === "pane_mode_get")[0]?.args).toEqual({ target: "w4:p1" });
  });

  it("switches through pane_mode_set once and then offers the modes the cycle showed", async () => {
    ipc(claudeAt("plan", () => ({ mode: "default", seen: ["plan", "auto", "default"] })));
    await mount();
    expect(chip()?.textContent).toContain("Plan");
    await open();
    await pick("Agent");
    await flush();
    expect(calls.filter(c => c.cmd === "pane_mode_set").map(c => c.args)).toEqual([{ target: "w4:p1", mode: "default" }]);
    expect(chip()?.textContent).toContain("Agent");
    await open();
    expect(rows().map(r => r.querySelector("span span")?.textContent)).toContain("Auto");
    expect(rows().map(r => r.querySelector("span span")?.textContent)).not.toContain("Bypass permissions");
  });

  it("puts a refused switch in the status line", async () => {
    ipc(claudeAt("default", () => Promise.reject("A prompt is waiting in the pane; answer it first. Nothing was pressed.")));
    await mount();
    await open();
    await pick("Plan");
    await flush();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Mode not changed: A prompt is waiting in the pane; answer it first. Nothing was pressed.");
  });

  it("says Reading mode while the pane is still booting", async () => {
    ipc(claudeAt("unknown"));
    await mount();
    expect(chip()?.textContent).toContain("Reading mode…");
    expect(chip()?.textContent).not.toContain("Mode unknown");
  });

  it("re-reads every two seconds and stops as soon as a mode arrives, without pressing a key", async () => {
    vi.useFakeTimers();
    let reads = 0;
    ipc(cmd => {
      if (cmd === "pane_mode_get") {
        reads += 1;
        return { mode: reads < 3 ? "unknown" : "plan", prompt_showing: false };
      }
      return null;
    });
    await mount();
    const bootReads = reads;
    expect(chip()?.textContent).toContain("Reading mode…");
    await act(async () => { await vi.advanceTimersByTimeAsync(MODE_READ_RETRY_MS); });
    await flush();
    expect(reads).toBe(bootReads + 1);
    expect(chip()?.textContent).toContain("Plan");
    await act(async () => { await vi.advanceTimersByTimeAsync(MODE_READ_WINDOW_MS); });
    expect(reads).toBe(bootReads + 1);
    expect(calls.filter(c => c.cmd === "pane_mode_set")).toEqual([]);
  });

  it("renders no Mode section for a pane that is not Claude Code, or with no pane", async () => {
    ipc(cmd => cmd === "pane_mode_get" ? Promise.reject("not a Claude Code pane") : null);
    await mount();
    expect(chip()?.getAttribute("aria-label")).toBe("orchestrator, permission: Ask me");
    await act(async () => { root.render(<ComposerAdapter {...props({ target: null })} />); });
    await flush();
    await open();
    expect(headings()).not.toContain("Mode");
  });
});

// #14487: while the orchestrator's turn runs, the one action is Stop — Escape to the pane over
// the classic pane_keys command, with the classic slot rule (words queue instead of stopping).
describe("ComposerAdapter stop slot", () => {
  const keys = () => calls.filter(c => c.cmd === "pane_keys");
  const escape = (ta: Element | null) =>
    act(async () => { ta?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

  it("turns Send into Stop while the turn runs, sends Escape to the pane, and returns to Send when idle", async () => {
    ipc(claudeAt("default"));
    await mount({ working: true });
    const stop = host.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
    expect(stop).not.toBeNull();
    expect(host.querySelector('button[aria-label="Send"]')).toBeNull();
    await act(async () => { stop?.click(); });
    expect(keys()).toEqual([{ cmd: "pane_keys", args: { target: "w4:p1", keys: "Escape" } }]);
    await mount({ working: false });
    expect(host.querySelector('button[aria-label="Stop"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Send"]')).not.toBeNull();
    expect(keys()).toHaveLength(1);
  });

  it("stops the turn on Esc in the composer, but not once words queue a message", async () => {
    ipc(claudeAt("default"));
    await mount({ working: true });
    const ta = host.querySelector("textarea");
    if (!ta) throw new Error("no textarea");
    await escape(ta);
    expect(keys().map(c => c.args)).toEqual([{ target: "w4:p1", keys: "Escape" }]);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => { setter?.call(ta, "hold on"); ta.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.querySelector('button[aria-label="Stop"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Send"]')).not.toBeNull();
    await escape(ta);
    expect(keys()).toHaveLength(1);
  });

  it("offers no Stop without a pane to interrupt", async () => {
    ipc(claudeAt("default"));
    await mount({ working: true, target: null });
    expect(host.querySelector('button[aria-label="Stop"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Send"]')).not.toBeNull();
    expect(keys()).toEqual([]);
  });
});

// #14488: words and chips persist per project through the classic composerDraft machinery —
// memory slots for a project switch, composer_draft_get/set for a restart, debounced writes.
describe("ComposerAdapter chat draft", () => {
  const DRAFT_DELAY_MS = 400;
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

  /** The draft commands over a caller-held disk map; pane_mode_get and pane_send answer too. */
  function draftIpc(disk: Map<string, string>): void {
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      // SAFETY: mockIPC types args as unknown; the draft commands are invoked with an object of named args.
      const named = (args ?? {}) as { project?: string; draft?: string };
      if (cmd === "pane_mode_get") return { mode: "default", prompt_showing: false };
      if (cmd === "pane_send") return { outcome: "delivered", error: null };
      if (cmd === "composer_draft_get") return disk.get(named.project ?? "") ?? null;
      if (cmd === "composer_draft_set") { disk.set(named.project ?? "", named.draft ?? ""); return null; }
      return null;
    });
  }

  const typeInto = (ta: HTMLTextAreaElement | null, text: string) => {
    if (!ta) throw new Error("no textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => { setter?.call(ta, text); ta.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  /** A fresh adapter root on the document — the mount/unmount pair a restart or a remount needs,
   *  without touching the shared root this file's teardown owns. */
  const mountHere = async () => {
    const el = document.createElement("div");
    document.body.append(el);
    const here = createRoot(el);
    await act(async () => { here.render(<ComposerAdapter {...props()} />); });
    await settle();
    return { el, root: here };
  };

  it("writes the words to the project's draft, debounced, and flushes what is pending on unmount", async () => {
    vi.useFakeTimers();
    const disk = new Map<string, string>();
    draftIpc(disk);
    const { el, root: localRoot } = await mountHere();
    typeInto(el.querySelector("textarea"), "finish the ring");
    await advance(DRAFT_DELAY_MS - 1);
    expect(disk.get("trantor")).toBeUndefined();
    await advance(1);
    expect(disk.get("trantor")).toBe(JSON.stringify({ text: "finish the ring", chips: [] }));
    typeInto(el.querySelector("textarea"), "finish the ring today");
    await act(async () => { localRoot.unmount(); });
    expect(disk.get("trantor")).toBe(JSON.stringify({ text: "finish the ring today", chips: [] }));
    el.remove();
  });

  it("restores the draft the last exit persisted, words and chips together", async () => {
    draftIpc(new Map([["trantor", JSON.stringify({ text: "finish the ring", chips: [{ path: "/tmp/one.png", size: 2048 }] })]]));
    await mount();
    await settle();
    expect(host.querySelector("textarea")?.value).toBe("finish the ring");
    expect(host.querySelectorAll("[data-chip]")).toHaveLength(1);
    expect(calls.filter(c => c.cmd === "composer_draft_get").map(c => c.args)).toEqual([{ project: "trantor" }]);
  });

  it("a delivered send clears the draft, and a restart reads back nothing to resurrect", async () => {
    vi.useFakeTimers();
    const disk = new Map<string, string>();
    draftIpc(disk);
    const first = await mountHere();
    typeInto(first.el.querySelector("textarea"), "off it goes");
    await advance(DRAFT_DELAY_MS);
    expect(disk.get("trantor")).toBe(JSON.stringify({ text: "off it goes", chips: [] }));
    await act(async () => { first.el.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click(); });
    await advance(DRAFT_DELAY_MS);
    expect(disk.get("trantor")).toBe("null");
    await act(async () => { first.root.unmount(); });
    first.el.remove();
    // Restart: fresh slots, the disk holds the emptied draft — the box comes back empty.
    draftSlots.reset();
    const second = await mountHere();
    expect(second.el.querySelector("textarea")?.value).toBe("");
    await act(async () => { second.root.unmount(); });
    second.el.remove();
  });

  it("swaps the draft with the project: each project's composer shows its own words", async () => {
    draftIpc(new Map());
    await mount();
    typeInto(host.querySelector("textarea"), "for trantor");
    await mount({ project: "other" });
    expect(host.querySelector("textarea")?.value).toBe("");
    typeInto(host.querySelector("textarea"), "for other");
    await mount({ project: "trantor" });
    expect(host.querySelector("textarea")?.value).toBe("for trantor");
    await mount({ project: "other" });
    expect(host.querySelector("textarea")?.value).toBe("for other");
  });
});

// #14030: the Mode menu consults the Rust-owned table. Below the feature's verified range the
// section shows one disabled row and never presses a key; above it the closed-loop read stays the
// guard and an unreadable mode line is explained instead of a bare "Mode unknown".
describe("ComposerAdapter Mode menu × the version table", () => {
  const compat = (installed: string): AgentCliCompatibility => ({
    cli: "claude", label: "Claude Code", installed, state: "ok", minimum: "2.1.215", verifiedUpTo: "2.1.326",
    reason: null, updateCommand: "claude update",
    features: [{ name: "Mode menu", verifiedFrom: "2.1.326", verifiedTo: "2.1.326", why: "reads the mode line", inRange: installed === "2.1.326" }],
  });

  it("below the verified range: one disabled row, and never a key pressed", async () => {
    ipc((cmd, args) => {
      if (cmd === "agent_cli_compatibility") return [compat("2.1.100")];
      if (cmd === "pane_mode_get") return { mode: "default", prompt_showing: false };
      if (cmd === "pane_mode_set") {
        // SAFETY: this mock is the only writer of the args — it echoes the mode this test passed.
        return { mode: (args as { mode?: string }).mode ?? "", seen: [] };
      }
      return null;
    });
    await mount();
    await open();
    const modeRows = rows().filter(r => /Mode switching needs/.test(r.textContent ?? ""));
    expect(modeRows).toHaveLength(1);
    expect(modeRows[0]?.textContent).toContain("Mode switching needs Claude Code 2.1.326 or newer");
    expect(modeRows[0]?.textContent).toContain("you have 2.1.100");
    // The plain mode rows are gone: the section is the honest unavailable state, nothing to pick.
    expect(rows().map(r => r.querySelector("span span")?.textContent)).not.toContain("Agent");
    await act(async () => { modeRows[0]?.click(); });
    await flush();
    // No key is ever pressed below the verified range — not even a stray pane_mode_set.
    expect(calls.filter(c => c.cmd === "pane_mode_set")).toEqual([]);
    expect(chip()?.textContent).toContain("Mode unknown");
  });

  it("inside the verified range: no change — the closed loop reads and switches as before", async () => {
    ipc(cmd => {
      if (cmd === "agent_cli_compatibility") return [compat("2.1.326")];
      if (cmd === "pane_mode_get") return { mode: "plan", prompt_showing: false };
      if (cmd === "pane_mode_set") return { mode: "default", seen: ["plan", "default"] };
      return null;
    });
    await mount();
    expect(chip()?.textContent).toContain("Plan");
    await open();
    expect(rows().map(r => r.querySelector("span span")?.textContent)).toContain("Agent");
    await pick("Agent");
    await flush();
    expect(calls.filter(c => c.cmd === "pane_mode_set").map(c => c.args)).toEqual([{ target: "w4:p1", mode: "default" }]);
  });

  it("above the verified range: retries stop at one minute before the version is blamed", async () => {
    vi.useFakeTimers();
    ipc(cmd => {
      if (cmd === "agent_cli_compatibility") return [compat("2.1.400")];
      if (cmd === "pane_mode_get") return { mode: "unknown", prompt_showing: false };
      return null;
    });
    await mount();
    const bootReads = calls.filter(c => c.cmd === "pane_mode_get").length;
    expect(chip()?.textContent).toContain("Reading mode…");
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(MODE_READ_WINDOW_MS); });
    await flush();
    expect(calls.filter(c => c.cmd === "pane_mode_get").length).toBe(bootReads + MODE_READ_WINDOW_MS / MODE_READ_RETRY_MS);
    expect(chip()?.textContent).toContain("Mode unknown");
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Claude Code 2.1.400 is newer than the version mode switching was checked on (2.1.326), and its mode line could not be read.");
    await act(async () => { await vi.advanceTimersByTimeAsync(MODE_READ_WINDOW_MS); });
    expect(calls.filter(c => c.cmd === "pane_mode_get").length).toBe(bootReads + MODE_READ_WINDOW_MS / MODE_READ_RETRY_MS);
    expect(calls.filter(c => c.cmd === "pane_mode_set")).toEqual([]);
  });
});

it("searches this project's files and sends a selected path as an attachment (#14495)", async () => {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "search_files") return JSON.stringify(["/repo/src/example.ts"]);
    if (cmd === "pane_mode_get") return { mode: "default", prompt_showing: false };
    if (cmd === "pane_send") return { outcome: "delivered" };
    return null;
  });
  await mount();
  const ta = host.querySelector("textarea");
  if (!ta) throw new Error("no textarea");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(ta, "Read @example");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
  expect(calls.find(c => c.cmd === "search_files")?.args).toEqual({ project: "trantor", query: "example", seat: null });
  await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); });
  expect(ta.value).toBe("Read ");
  expect(host.querySelector("[data-chip]")?.getAttribute("title")).toBe("/repo/src/example.ts");
  expect(calls.filter(c => c.cmd === "pane_send")).toHaveLength(0);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(); });
  expect(calls.filter(c => c.cmd === "pane_send").map(c => c.args)).toEqual([
    { target: "w4:p1", text: "/repo/src/example.ts Read" },
  ]);
});
