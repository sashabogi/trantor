// @vitest-environment happy-dom
//
// #5993 — the working gate's belt. The pushed status stream can freeze on `working`, so the
// chat re-seeds the status ONCE when the transcript says a turn ended (a `chat-rows` batch
// carrying `turn_ended`) and once per `chat-session-changed`. The Tauri seam is mocked here and
// the assertions count `orchestrator_status` invokes, so a missing seed, a duplicate, or a
// polling loop all fail loudly.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const invokes: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const handlers: Record<string, (ev: { payload: string }) => void> = {};
  return { invokes, handlers };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    h.invokes.push({ cmd, args });
    if (cmd === "orchestrator_chat") {
      // A transcript with nothing past `after`: the cursor never moves unless an event moves it.
      const meta = { model: "", version: "", branch: "", context: { tokens: null, window: 0, frac: null } };
      const after = typeof args?.after === "number" ? args.after : 0;
      return Promise.resolve(JSON.stringify([[], [], after, meta, []]));
    }
    if (cmd === "chat_watch") return Promise.resolve(0);
    if (cmd === "orchestrator_status") return Promise.resolve("idle");
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (ev: { payload: string }) => void) => {
    h.handlers[event] = cb;
    return Promise.resolve(() => {});
  },
}));

// The chat's heavy neighbours stay out: this test pins the status re-seed wiring, not the
// composer's dials or the terminal bridge — both have their own tests.
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("../workspace/TerminalPane", () => ({ TerminalPane: () => null, DEFAULT_TERMINAL_DEPS: {} }));
vi.mock("../workspace/herdr", () => ({ orchestratorOf: () => Promise.resolve(null) }));

const META = { model: "", version: "", branch: "", context: { tokens: null, window: 0, frac: null } };

function rowsPayload(extra: Partial<{ project: string; sessionId: string; after: number; total: number; turn_ended: boolean }> = {}): string {
  return JSON.stringify({
    project: "p", sessionId: "s1", after: 0, total: 0, turns: [], results: [], meta: META,
    ...extra,
  });
}

const statusSeeds = () => h.invokes.filter(c => c.cmd === "orchestrator_status").length;
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

describe("Chat status re-seed (#5993)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    h.invokes.length = 0;
    for (const k of Object.keys(h.handlers)) delete h.handlers[k];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("re-seeds once on a turn_ended batch, and never without one", async () => {
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} />); });
    await flush();
    await flush();
    expect(h.handlers["chat-rows"]!).toBeTruthy();
    const baseline = statusSeeds(); // the mount seed

    // A batch WITHOUT turn_ended never re-seeds.
    await act(async () => { h.handlers["chat-rows"]!({ payload: rowsPayload({ after: 0, total: 1 }) }); });
    await flush();
    expect(statusSeeds()).toBe(baseline);

    // The turn-ended batch re-seeds EXACTLY once.
    await act(async () => { h.handlers["chat-rows"]!({ payload: rowsPayload({ after: 1, total: 2, turn_ended: true }) }); });
    await flush();
    expect(statusSeeds()).toBe(baseline + 1);

    // No polling loop behind the seed: silence stays silent.
    await new Promise(r => setTimeout(r, 50));
    expect(statusSeeds()).toBe(baseline + 1);
  });

  it("a turn_ended batch that misses the cursor still re-seeds the gate", async () => {
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} />); });
    await flush();
    await flush();
    const baseline = statusSeeds();
    // The rows resync heals the cursor; the gate must heal too, not only on in-order batches.
    await act(async () => { h.handlers["chat-rows"]!({ payload: rowsPayload({ after: 999, total: 1000, turn_ended: true }) }); });
    await flush();
    expect(statusSeeds()).toBe(baseline + 1);
  });

  it("re-seeds once per chat-session-changed event", async () => {
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} />); });
    await flush();
    await flush();
    expect(h.handlers["chat-session-changed"]!).toBeTruthy();
    const baseline = statusSeeds();
    await act(async () => { h.handlers["chat-session-changed"]!({ payload: JSON.stringify({ project: "p", sessionId: "s2" }) }); });
    await flush();
    expect(statusSeeds()).toBe(baseline + 1);
  });

  it("a history view never re-seeds — its status stays 'ended'", async () => {
    act(() => { root.render(<Chat project="p" sessionId="hist-1" dock="right" onDock={() => {}} onClose={() => {}} />); });
    await flush();
    await flush();
    expect(h.handlers["chat-rows"]!).toBeTruthy();
    const baseline = statusSeeds(); // 0: history returns before the mount seed
    await act(async () => { h.handlers["chat-rows"]!({ payload: rowsPayload({ sessionId: "hist-1", after: 0, total: 1, turn_ended: true }) }); });
    await flush();
    expect(statusSeeds()).toBe(baseline);
  });
});
