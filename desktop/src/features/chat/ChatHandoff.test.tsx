// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { Chat, type ChatDeps } from "./Chat";

// SAFETY: invoke uses this webview bridge; this fixture implements only the polled read command.
const webview = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<never[]> } };
webview.__TAURI_INTERNALS__ = { invoke: async command => {
  if (command !== "handoff_states") throw new Error(`unexpected command: ${command}`);
  return [];
} };
// SAFETY: React's test scheduler reads this documented flag from the global object.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("header confirms or cancels, calls the existing chain once, and shows failures below the banner threshold", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  const root = createRoot(host);
  const calls: { command: string; args?: InvokeArgs }[] = [];
  let rejectHandoff: (error: Error) => void = () => {};
  const deps: ChatDeps = {
    invoke: async <T,>(command: string, args?: InvokeArgs): Promise<T> => {
      calls.push({ command, args });
      let result: string | null | { current: number; generation: number } | string[] = null;
      if (command === "orchestrator_chat") result = JSON.stringify([[], [], 0,
        { model: "", version: "", branch: "", context: { tokens: 10, window: 100, frac: 0.1 } }, []]);
      if (command === "orchestrator_status") result = "idle";
      if (command === "chat_watch") result = { current: 0, generation: 1 };
      if (command === "wake_in_progress") result = [];
      if (command === "handoff_now") result = await new Promise<string>((_, reject) => { rejectHandoff = reject; });
      // SAFETY: these fixtures implement the return shapes of the named IPC commands above.
      return result as T;
    },
    listen: async () => () => {},
    orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "w9:p1", kind: "orch" }),
    answerAtSession: async () => {},
    Composer: () => null,
    TerminalPane: () => null,
  };
  function button(label: string) {
    const found = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.trim() === label);
    if (!found) throw new Error(`missing button ${label}`);
    return found;
  }
  try {
    await act(async () => root.render(<Chat project="p" dock="pane" onDock={() => {}} onClose={() => {}} deps={deps} />));
    await act(async () => button("Hand off").click());
    expect(button("Confirm handoff").title).toContain("End this session and open a successor");
    expect(calls.filter(c => c.command === "handoff_now")).toHaveLength(0);
    await act(async () => button("Cancel").click());
    expect(host.textContent).not.toContain("Confirm handoff");
    await act(async () => button("Hand off").click());
    await act(async () => button("Confirm handoff").click());
    expect(calls.filter(c => c.command === "handoff_now")).toEqual([{ command: "handoff_now", args: { project: "p", reason: "clicked" } }]);
    expect(button("Hand off").disabled).toBe(true);
    expect(host.textContent).toContain("handoff starting");
    await act(async () => rejectHandoff(new Error("successor could not open")));
    expect(button("Hand off").disabled).toBe(false);
    expect(host.querySelectorAll('[data-handoff-state="FAILED"]')).toHaveLength(1);
    expect(host.textContent).toContain("successor could not open");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
