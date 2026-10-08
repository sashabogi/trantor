// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HandoffRecapStatus } from "./HandoffRecapStatus";
import { handoffWaiting, type HandoffState } from "./handoffState";

type StateReply = { records: HandoffState[] };
const ipc: StateReply = { records: [] };
// SAFETY: this is the Tauri webview IPC interface used by invoke, implemented in-process for the drill.
const webview = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<HandoffState[]> } };
webview.__TAURI_INTERNALS__ = { invoke: async command => {
  if (command !== "handoff_states") throw new Error(`unexpected command: ${command}`);
  return ipc.records;
} };
// SAFETY: enable React's documented test scheduler on this test's global object.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());

it("both the project row and chat divider wait through WRITTEN and CLAIMED, until RECAPPED", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  const root = createRoot(host);
  ipc.records = [{ project: "p", id: "p-1", state: "WRITTEN" }];
  try {
    await act(async () => root.render(<><HandoffRecapStatus project="p" /><HandoffRecapStatus project="p" divider /><HandoffRecapStatus project="other" /></>));
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(2);
    expect(host.textContent).toContain("handoff waiting for recap");
    ipc.records = [{ project: "p", id: "p-1", state: "CLAIMED" }];
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.querySelectorAll('[data-handoff-state="CLAIMED"]')).toHaveLength(2);
    ipc.records = [{ project: "p", id: "p-1", state: "RECAPPED" }];
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});

it("only written and claimed records are pending", () => {
  expect(handoffWaiting()).toBe(false);
  for (const state of ["WRITTEN", "CLAIMED", "RECAPPED"] as const) {
    expect(handoffWaiting({ project: "p", id: "p-1", state })).toBe(state !== "RECAPPED");
  }
});
