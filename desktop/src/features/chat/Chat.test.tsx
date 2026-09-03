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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { Chat, type ChatDeps } from "./Chat";
import type { HerdrSeat } from "../workspace/herdr";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Invoked = { cmd: string };
type Handler = (ev: { payload: string }) => void;

/** A faithful in-memory ChatDeps: invoke answers the chat's commands, listen records handlers,
 *  orchestratorOf finds no pane, and the heavy children render nothing. */
function makeDeps() {
  const invokes: Invoked[] = [];
  const handlers = new Map<string, Handler[]>();
  const deps: ChatDeps = {
    invoke: <T,>(cmd: string): Promise<T> => {
      invokes.push({ cmd });
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
    answerAtPane: async () => {},
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

// #6094 — the question card: a blocked AskUserQuestion tool_use renders as something the
// operator can answer from Chat, a click writes the picker's real keystrokes into the live pane
// (never a claim of its own), and the card only flips to answered once the transcript's own
// tool_result lands for that call.
describe("AskCard question card (#6094)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const askBlock = {
    kind: "tool", text: "Ship it?", tool: "AskUserQuestion", tool_id: "ask1",
    ask: [{
      header: "Ship", question: "Ship it?", multiSelect: false,
      options: [{ label: "Yes", description: "" }, { label: "No", description: "" }],
    }],
  };
  const askTurn = { role: "assistant", blocks: [askBlock] };

  /** A live pane (orchestratorOf resolves a surface) with one blocked AskUserQuestion already in
   *  the backfilled transcript — the render() every test in this block starts from. */
  function makeBlockedDeps() {
    const answered: Array<{ target: string; data: string }> = [];
    const deps: ChatDeps = {
      // The real backend answers `after` — a second fetch past line 0 gets nothing new, never
      // the same turn again. A mock that ignored `after` doubled the ask (2 tool blocks batched
      // into one collapsed "2 tools" row) the instant `target` resolved and re-ran the effect.
      invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
        if (cmd === "orchestrator_chat") {
          // SAFETY: Chat always calls orchestrator_chat with a plain `{ after: number }` object —
          // never the array/buffer arms of InvokeArgs — so this narrow read is exactly what
          // arrives here.
          const after = (args as { after: number } | undefined)?.after ?? 0;
          const backfill = after === 0 ? [[askTurn], [], 1, META, []] : [[], [], after, META, []];
          // SAFETY: Chat types this call Promise<string> and parses the JSON; the envelope is
          // exactly the Backfill shape this test built above.
          return Promise.resolve(JSON.stringify(backfill) as T);
        }
        if (cmd === "chat_watch") {
          // SAFETY: Chat types this call Promise<ChatWatchResult> — current=1 matches the one
          // turn the backfill above already seeded, so the post-mount watch never re-fetches it.
          return Promise.resolve({ current: 1, generation: 1 } as T);
        }
        if (cmd === "orchestrator_status") {
          // SAFETY: Chat types this call Promise<string> and treats the value as herdr's status
          // text; "blocked" is the one status that surfaces the open ask under test.
          return Promise.resolve("blocked" as T);
        }
        // SAFETY: unknown commands resolve to null, matching the real seam's unhandled default.
        return Promise.resolve(null as T);
      },
      listen: () => Promise.resolve(() => {}),
      orchestratorOf: async () => ({ project: "p", agent: "orch", surface: "surf1", kind: "orch" }),
      answerAtPane: async (target: string, data: string) => { answered.push({ target, data }); },
      Composer: () => null,
      TerminalPane: () => null,
    };
    return { deps, answered };
  }

  it("renders the open question as buttons, not a collapsed tool row", async () => {
    const { deps } = makeBlockedDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    expect(host.textContent).toContain("Ship it?");
    const buttons = [...host.querySelectorAll("button")].map(b => b.textContent ?? "");
    expect(buttons.some(t => t.includes("Yes"))).toBe(true);
    expect(buttons.some(t => t.includes("No"))).toBe(true);
  });

  it("picking an option writes answerKeystrokes' arrow-navigation sequence into the pane", async () => {
    const { deps, answered } = makeBlockedDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    const noButton = [...host.querySelectorAll("button")].find(b => (b.textContent ?? "").includes("No"))!;
    await act(async () => { noButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    // "No" is index 1: one Down arrow to reach it, then Enter — never a typed digit.
    expect(answered).toEqual([{ target: "surf1", data: "\x1b[B\r" }]);
  });

  it("stays a question card (not answered) until the transcript's own tool_result lands", async () => {
    const { deps } = makeBlockedDeps();
    act(() => { root.render(<Chat project="p" dock="right" onDock={() => {}} onClose={() => {}} deps={deps} />); });
    await flush();
    await flush();
    expect(host.textContent).not.toContain("answered");
    expect(host.textContent).toContain("Yes");
  });
});
