// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { Chat, type ChatDeps } from "../../../features/chat/Chat";
import { ComposerAdapter } from "./ComposerAdapter";

// SAFETY: React's test scheduler reads this documented flag from the global object.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let calls: { command: string; args?: InvokeArgs }[];
let settings: Map<string, { harness: string; baton: string }>;
let failBaton: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  settings = new Map();
  failBaton = false;
  mockIPC(reply);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function reply(command: string, args?: InvokeArgs) {
  calls.push({ command, args });
  // SAFETY: these named IPC commands receive the object arguments supplied by Chat and the adapter.
  const named = (args ?? {}) as { project?: string; dial?: "harness" | "baton"; value?: string };
  const project = named.project ?? "p";
  if (command === "autonomy_get" || command === "autonomy_set") {
    const resolved = settings.get(project) ?? { harness: "prompt", baton: "ask" };
    if (command === "autonomy_set" && named.dial && named.value) {
      if (failBaton && named.dial === "baton") throw new Error("baton write failed");
      resolved[named.dial] = named.value;
      settings.set(project, resolved);
    }
    return JSON.stringify({ resolved });
  }
  if (command === "orchestrator_chat") return JSON.stringify([[], [], 0,
    { model: "claude-opus-5-5", version: "", branch: "", context: { tokens: 95, window: 100, frac: 0.95 } }, []]);
  if (command === "orchestrator_status") return "idle";
  if (command === "chat_watch") return { current: 0, generation: 1 };
  if (command === "wake_in_progress" || command === "handoff_states") return [];
  if (command === "pane_mode_get") return { mode: "default", prompt_showing: false };
  return null;
}
const deps: ChatDeps = {
  invoke: async <T,>(command: string, args?: InvokeArgs): Promise<T> => {
    // SAFETY: reply provides the fixtures for the named IPC command contracts.
    return reply(command, args) as T;
  },
  listen: async () => () => {},
  orchestratorOf: async project => ({ project, agent: "orch", surface: "w9:p1", kind: "orch" }),
  answerAtSession: async () => {},
  Composer: ComposerAdapter,
  TerminalPane: () => null,
};
async function mount(project = "p") {
  await act(async () => root.render(<Chat project={project} dock="pane" onDock={() => {}} onClose={() => {}} deps={deps} />));
}
async function pick(label: string) {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-group="agent"] button')?.click());
  const row = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(b => b.textContent?.startsWith(label));
  expect(row).toBeDefined();
  await act(async () => row?.click());
}
const handoffs = () => calls.filter(c => c.command === "handoff_now");
const permission = () => host.querySelector('[data-group="agent"] button')?.getAttribute("aria-label");

it("selecting Full auto reaches Chat's unattended handoff and reload restores the project setting", async () => {
  await mount();
  expect(handoffs()).toEqual([]);
  await pick("Full auto");
  expect(handoffs()).toEqual([{ command: "handoff_now", args: { project: "p", reason: "unattended" } }]);
  expect(permission()).toContain("permission: Full auto");
  expect(settings.get("p")).toEqual({ harness: "bypass", baton: "auto" });
  await act(async () => root.unmount());
  root = createRoot(host);
  calls = [];
  await mount();
  expect(permission()).toContain("permission: Full auto");
  expect(handoffs()).toEqual([{ command: "handoff_now", args: { project: "p", reason: "unattended" } }]);
});

it("restores each project's setting without carrying Full auto into another project", async () => {
  settings.set("p", { harness: "bypass", baton: "auto" });
  await mount();
  await mount("other");
  expect(permission()).toContain("permission: Ask me");
  expect(handoffs().some(c => JSON.stringify(c.args).includes("other"))).toBe(false);
});

it("mixed dials and a failed baton write never enable Chat's unattended handoff", async () => {
  settings.set("p", { harness: "bypass", baton: "ask" });
  await mount();
  expect(permission()).toContain("permission: Ask me");
  failBaton = true;
  await pick("Full auto");
  expect(handoffs()).toEqual([]);
  expect(host.textContent).toContain("baton write failed");
  expect(permission()).toContain("permission: Ask me");
});
