// @vitest-environment happy-dom
//
// #5993 — the working gate's belt. The pushed status stream can freeze on `working`, so the
// chat re-seeds the status ONCE when the transcript says a turn ended (a `chat-rows` batch
// carrying `turn_ended`) and once per `chat-session-changed`. The chat's tauri/herdr seams are
// INJECTED through the ChatDeps prop (real interface — the same pattern TerminalPane's `deps`
// uses), and the assertions count `orchestrator_status` invokes, so a missing seed, a duplicate,
// or a polling loop all fail loudly.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, type ChatDeps } from "./Chat";
import type { HerdrSeat } from "../workspace/herdr";
import { WAKE_OUTCOME_MS } from "../genesis/wakeRow";
import type { WakeProgress } from "../genesis/wakeProgress";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Invoked = { cmd: string };
type Handler = (ev: { payload: string }) => void;

/** A faithful in-memory ChatDeps: invoke answers the chat's commands, listen records handlers,
 *  orchestratorOf finds no pane, and the heavy children render nothing. */
function makeDeps(wakeProjects: string[] = []) {
  const invokes: Invoked[] = [];
  const handlers = new Map<string, Handler[]>();
  const deps: ChatDeps = {
    invoke: <T,>(cmd: string): Promise<T> => {
      invokes.push({ cmd });
      if (cmd === "wake_in_progress") {
        // SAFETY: Chat types this call Promise<string[]> — the projects holding a wake chain.
        return Promise.resolve(wakeProjects as T);
      }
      if (cmd === "orchestrator_chat") {
        // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is exactly
        // the Backfill shape (empty turns, cursor 0), so the parse yields an empty thread.
        return Promise.resolve(JSON.stringify([[], [], 0,
          { model: "", version: "", branch: "", context: { tokens: null, window: 0, frac: null } }, []]) as T);
      }
      if (cmd === "chat_watch") {
        // SAFETY: Chat types this call Promise<ChatWatchResult> — the row count the watcher
        // started at, plus the generation token #6113 added for chat_unwatch to echo back.
        return Promise.resolve({ current: 0, generation: 1 } as T);
      }
      if (cmd === "orchestrator_status") {
        // SAFETY: Chat types this call Promise<string> and treats the value as herdr's status text.
        return Promise.resolve("idle" as T);
      }
      // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
      return Promise.resolve(null as T);
    },
    listen: <T,>(event: string, cb: (ev: { payload: T }) => void): Promise<() => void> => {
      // SAFETY: Chat listens for chat-rows / chat-session-changed / orch-status, all string-payload
      // events; the handler is stored under that container and fired with it, so T is string here.
      const boxed = cb as (ev: { payload: string }) => void;
      handlers.set(event, [...(handlers.get(event) ?? []), boxed]);
      return Promise.resolve(() => {});
    },
    orchestratorOf: async () => {
      // SAFETY: the test mounts no herdr pane, so the seam reports no orchestrator surface (null) —
      // exactly what Chat treats as "not hosted".
      return null as HerdrSeat | null;
    },
    Composer: () => null,
    TerminalPane: () => null,
  };
  return { deps, invokes, handlers };
}

const META = { model: "", version: "", branch: "", context: { tokens: null, window: 0, frac: null } };

function rowsPayload(extra: Partial<{ project: string; sessionId: string; after: number; total: number; turn_ended: boolean }> = {}): string {
  return JSON.stringify({
    project: "p", sessionId: "s1", after: 0, total: 0, turns: [], results: [], meta: META,
    ...extra,
  });
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

describe("Chat status re-seed (#5993)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let invokes: Invoked[];
  let handlers: Map<string, Handler[]>;

  const statusSeeds = () => invokes.filter(c => c.cmd === "orchestrator_status").length;
  const fire = (event: string, payload: string) =>
    act(async () => { for (const cb of handlers.get(event) ?? []) cb({ payload }); });

  const render = (extra: Partial<Parameters<typeof Chat>[0]> = {}) => {
    const d = makeDeps();
    invokes = d.invokes;
    handlers = d.handlers;
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={d.deps} {...extra} />); });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("re-seeds once on a turn_ended batch, and never without one", async () => {
    render();
    await flush();
    await flush();
    expect(handlers.has("chat-rows")).toBe(true);
    const baseline = statusSeeds(); // the mount seed

    // A batch WITHOUT turn_ended never re-seeds.
    await fire("chat-rows", rowsPayload({ after: 0, total: 1 }));
    await flush();
    expect(statusSeeds()).toBe(baseline);

    // The turn-ended batch re-seeds EXACTLY once.
    await fire("chat-rows", rowsPayload({ after: 1, total: 2, turn_ended: true }));
    await flush();
    expect(statusSeeds()).toBe(baseline + 1);

    // No polling loop behind the seed: silence stays silent.
    await new Promise(r => setTimeout(r, 50));
    expect(statusSeeds()).toBe(baseline + 1);
  });

  it("a turn_ended batch that misses the cursor still re-seeds the gate", async () => {
    render();
    await flush();
    await flush();
    const baseline = statusSeeds();
    // The rows resync heals the cursor; the gate must heal too, not only on in-order batches.
    await fire("chat-rows", rowsPayload({ after: 999, total: 1000, turn_ended: true }));
    await flush();
    expect(statusSeeds()).toBe(baseline + 1);
  });

  it("re-seeds once per chat-session-changed event", async () => {
    render();
    await flush();
    await flush();
    expect(handlers.has("chat-session-changed")).toBe(true);
    const baseline = statusSeeds();
    await fire("chat-session-changed", JSON.stringify({ project: "p", sessionId: "s2" }));
    await flush();
    expect(statusSeeds()).toBe(baseline + 1);
  });

  it("a history view never re-seeds — its status stays 'ended'", async () => {
    render({ sessionId: "hist-1" });
    await flush();
    await flush();
    expect(handlers.has("chat-rows")).toBe(true);
    const baseline = statusSeeds(); // 0: history returns before the mount seed
    await fire("chat-rows", rowsPayload({ sessionId: "hist-1", after: 0, total: 1, turn_ended: true }));
    await flush();
    expect(statusSeeds()).toBe(baseline);
  });
});

// #6201 — the header's read on the wake chain: "kickoff pending" during the idle gate (the
// session's own startup makes the ticker read "working", which is exactly how tiny-timer's 88s
// silent gate read as idle-with-nothing-to-do), then the outcome for the same few seconds the
// sidebar row gives it. The chain events and the mount mark arrive through the deps seam.
describe("Chat wake chain note (#6201)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let invokes: Invoked[];
  let handlers: Map<string, Handler[]>;

  const fireJson = (event: string, payload: string) =>
    act(async () => { for (const cb of handlers.get(event) ?? []) cb({ payload }); });

  const fireProgress = (payload: WakeProgress) =>
    act(async () => {
      for (const cb of handlers.get("wake-progress") ?? []) {
        // SAFETY: wake-progress payloads are structured objects; the stored handler boxes to
        // string payloads for the chat's own events, so the cast widens it back for this one.
        (cb as unknown as (ev: { payload: WakeProgress }) => void)({ payload });
      }
    });

  const render = (wakeProjects: string[] = []) => {
    const d = makeDeps(wakeProjects);
    invokes = d.invokes;
    handlers = d.handlers;
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={d.deps} />); });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("a window opened mid-wake reads 'kickoff pending' from the mount mark, and a quiet machine shows no note", async () => {
    render(["p"]);
    await flush();
    expect(handlers.has("wake-progress")).toBe(true);
    expect(invokes.some(c => c.cmd === "wake_in_progress")).toBe(true);
    expect(host.textContent).toContain("kickoff pending — waiting for idle");

    // The mount mark re-read on a project switch: no wake in flight, no note, no dead chrome.
    render([]);
    await flush();
    expect(host.textContent).not.toContain("kickoff pending");
  });

  it("the pending note replaces the session's startup ticker, and the outcome shows for the few seconds then fades", async () => {
    vi.useFakeTimers();
    try {
      render();
      await flush();
      // The exact lie tiny-timer told: the session's own startup reads "working" in the ticker.
      await fireJson("orch-status", JSON.stringify({ project: "p", status: "working" }));
      await flush();
      expect(host.textContent).toContain("working");

      // The gate opens: the wake's truth outranks the startup ticker.
      await fireProgress({ project: "p", phase: "waiting_idle", detail: null });
      await flush();
      expect(host.textContent).toContain("kickoff pending — waiting for idle");
      expect(host.textContent).not.toContain("working");

      // Landed: the outcome in Rust's own words, then gone after WAKE_OUTCOME_MS — the ticker's
      // silence returns (nothing replaces it: idle shows no line, absence IS the idle state).
      await fireProgress({ project: "p", phase: "kickoff_landed", detail: "prompt delivered — successor is recapping" });
      await flush();
      expect(host.textContent).toContain("prompt delivered — successor is recapping");
      await act(async () => { vi.advanceTimersByTime(WAKE_OUTCOME_MS + 1); });
      expect(host.textContent).not.toContain("prompt delivered");
      expect(host.textContent).not.toContain("kickoff pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("another project's chain never shows here; ended clears the note", async () => {
    render();
    await flush();
    await fireProgress({ project: "other", phase: "waiting_idle", detail: null });
    await flush();
    expect(host.textContent).not.toContain("kickoff pending");

    await fireProgress({ project: "p", phase: "waiting_idle", detail: null });
    await flush();
    expect(host.textContent).toContain("kickoff pending — waiting for idle");

    await fireProgress({ project: "p", phase: "ended", detail: null });
    await flush();
    expect(host.textContent).not.toContain("kickoff pending");
  });
});
