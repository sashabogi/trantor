// @vitest-environment happy-dom
// #14022: the orchestrator composer's Mode menu reads the live mode off the pane and switches it through
// the native closed loop. Fakes sit only at the Tauri IPC boundary.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { AgentCliCompatibility } from "../../../shared/api/client";
import { ComposerAdapter } from "./ComposerAdapter";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { mode: string; prompt_showing?: boolean; seen?: string[] } | Promise<never> | AgentCliCompatibility[] | null;
type Calls = Array<{ cmd: string; args?: InvokeArgs }>;
type Reply = (cmd: string, args?: InvokeArgs) => Answer | undefined;

let host: HTMLDivElement;
let root: Root;
let calls: Calls;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); calls = []; });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearMocks(); });

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
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
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
    await open();
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

  it("says Mode unknown when the parser cannot tell", async () => {
    ipc(claudeAt("unknown"));
    await mount();
    expect(chip()?.textContent).toContain("Mode unknown");
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

  it("above the verified range: the read stays the guard, and an unreadable mode line is explained", async () => {
    ipc(cmd => {
      if (cmd === "agent_cli_compatibility") return [compat("2.1.400")];
      if (cmd === "pane_mode_get") return { mode: "unknown", prompt_showing: false };
      return null;
    });
    await mount();
    expect(chip()?.textContent).toContain("Mode unknown");
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Claude Code 2.1.400 is newer than the version mode switching was checked on (2.1.326), and its mode line could not be read.");
    expect(calls.filter(c => c.cmd === "pane_mode_get").length).toBeGreaterThan(0);
  });
});
